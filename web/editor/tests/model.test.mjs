// Run with: node --test web/editor/tests/
import test from "node:test";
import assert from "node:assert/strict";
import * as m from "../model.js";
import { toMidi } from "../midi.js";

const song = () => m.migrate({
  id: "s", title: "S",
  bars: [{ beats: 4, division: 2, bpm: 120 }, { beats: 4, division: 2, bpm: 120 }, { beats: 2, division: 3, bpm: 60 }, { beats: 2, division: 3, bpm: 60 }],
  sections: [{ bar: 0, name: "A" }, { bar: 2, name: "B" }],
  tracks: [{ id: "g", name: "G", notes: [[0, 0, 1, 60, 0.8], [1, 3.5, 0.5, 62, 0.8], [2, 1.3333, 0.3333, 64, 0.8], [3, 0, 2, 65, 0.8]] }],
});

test("old per-bar projects become change lists", () => {
  const p = song();
  assert.equal(p.bars, 4);
  assert.deepEqual(p.tempo, [{ bar: 0, bpm: 120 }, { bar: 2, bpm: 60 }]);
  assert.deepEqual(p.signature, [{ bar: 0, beats: 4, division: 2 }, { bar: 2, beats: 2, division: 3 }]);
  assert.equal(m.sigText(p.signature[1]), "6/8");
  assert.deepEqual(m.migrate(p), p); // already current: unchanged
});

test("layout gives bar starts in beats and seconds, and converts both ways", () => {
  const L = m.layout(song());
  assert.deepEqual([...L.start], [0, 4, 8, 10, 12]);
  assert.deepEqual([...L.time], [0, 2, 4, 6, 8]);
  assert.equal(m.barAt(L, 8), 2); assert.equal(m.barAt(L, 7.99), 1); assert.equal(m.barAt(L, 99), 3);
  assert.deepEqual(m.place(9.5, L), [2, 1.5]);
  assert.equal(m.timeAt(L, 9), 5); assert.equal(m.beatAtTime(L, 5), 9); assert.equal(m.beatAtTime(L, 1), 2);
  assert.equal(m.snapTo(1.3, 1 / 3), 1.3333); assert.equal(m.snapDown(1.3, 0.25), 1.25);
});

test("blocks split, move and remove", () => {
  const p = song();
  const i = m.splitAt(p.tempo, 1);
  assert.equal(i, 1); assert.deepEqual(p.tempo.map((t) => t.bar), [0, 1, 2]);
  assert.equal(m.splitAt(p.tempo, 1), 1); // already a block there
  p.tempo[1].bpm = 90;
  assert.deepEqual(m.layout(p).bpm, [120, 90, 60, 60]);
  m.moveStart(p.tempo, 2, 3, p.bars); assert.deepEqual(m.layout(p).bpm, [120, 90, 90, 60]);
  m.moveStart(p.tempo, 2, 0, p.bars); assert.equal(p.tempo[2].bar, 2); // cannot pass its neighbour
  m.moveStart(p.tempo, 0, 2, p.bars); assert.equal(p.tempo[0].bar, 0); // the first block stays at the start
  m.removeBlock(p.tempo, 1); assert.deepEqual(m.layout(p).bpm, [120, 120, 60, 60]);
  m.removeBlock(p.tempo, 0); assert.equal(p.tempo.length, 2);
});

test("a shorter bar drops the notes that no longer fit", () => {
  const p = song();
  p.signature[0].beats = 3; m.prune(p);
  assert.deepEqual(p.tracks[0].notes.map((n) => n[3]), [60, 64, 65]);
});

test("insert, delete and repeat bars carry notes, tempo, signature and sections", () => {
  let p = song();
  m.insertBars(p, 2, 1);
  assert.equal(p.bars, 5); assert.deepEqual(m.layout(p).bpm, [120, 120, 120, 60, 60]);
  assert.deepEqual(p.tracks[0].notes.map((n) => n[0]), [0, 1, 3, 4]); assert.deepEqual(p.sections.map((s) => s.bar), [0, 3]);
  p = song(); m.deleteBars(p, 1, 2);
  assert.equal(p.bars, 2); assert.deepEqual(m.layout(p).bpm, [120, 60]); assert.deepEqual(m.layout(p).beats, [4, 2]);
  assert.deepEqual(p.tracks[0].notes, [[0, 0, 1, 60, 0.8], [1, 0, 2, 65, 0.8]]);
  assert.deepEqual(p.sections, [{ bar: 0, name: "A" }, { bar: 1, name: "B" }]);
  p = song(); m.deleteBars(p, 0, 3); assert.equal(p.bars, 1); // one bar always remains
  p = song(); m.duplicateBars(p, 1, 2);
  assert.equal(p.bars, 6); assert.deepEqual(m.layout(p).bpm, [120, 120, 60, 120, 60, 60]);
  assert.deepEqual(p.tracks[0].notes.map((n) => [n[0], n[3]]).sort(), [[0, 60], [1, 62], [2, 64], [3, 62], [4, 64], [5, 65]]);
  p = song(); m.setLength(p, 6); assert.equal(p.bars, 6); m.setLength(p, 2); assert.equal(p.bars, 2); assert.equal(p.tracks[0].notes.length, 2);
});

test("copied bars paste onto another track and follow the bars they land in", () => {
  const p = song(); p.tracks.push({ id: "b", name: "B", notes: [[2, 0, 1, 40, 1]] });
  const clip = m.copyBars(p, 0, 1, ["g"]);
  assert.equal(m.pasteBars(p, clip, 2, "b"), 3);
  // Bars 3-4 are 2 beats long, so the note at beat 3.5 of the copied 4-beat bar does not fit; the old note is replaced.
  assert.deepEqual(p.tracks[1].notes, [[2, 0, 1, 60, 0.8]]);
  m.clearBars(p, 0, 0, ["g"]); assert.equal(p.tracks[0].notes.length, 3);
});

test("chord names, scale snapping and solo", () => {
  assert.equal(m.chordGuess([40, 47, 52, 56]), "E"); assert.equal(m.chordGuess([49, 52, 56, 59]), "C#m7");
  assert.equal(m.chordGuess([47, 52, 56]), "E/B"); assert.equal(m.chordGuess([40, 53, 58]), "E F A#"); assert.equal(m.chordGuess([60]), "C");
  const eMajor = new Set([4, 6, 8, 9, 11, 1, 3]);
  assert.equal(m.intoScale(60, eMajor), 61); assert.equal(m.intoScale(64, eMajor), 64); assert.equal(m.intoScale(60, null), 60);
  const p = song(); p.tracks.push({ id: "b", notes: [], mute: true }, { id: "c", notes: [] });
  assert.deepEqual(m.audible(p).map((t) => t.id), ["g", "c"]);
  p.tracks[1].solo = true; assert.deepEqual(m.audible(p).map((t) => t.id), ["b"]);
});

test("MIDI export has tempo and signature changes on the bar lines", () => {
  const bytes = toMidi(song());
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), "MThd");
  assert.equal((bytes[10] << 8) | bytes[11], 2); // conductor + one track
  const text = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(" ");
  assert.ok(text.includes("ff 51 03 07 a1 20")); // 120 bpm at the start
  assert.ok(text.includes("ff 58 04 06 03")); // 6/8
  assert.ok(text.includes("ff 51 03 0a 2c 2b")); // 60 dotted quarters a minute = 90 quarters
});
