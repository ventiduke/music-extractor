// Run with: node --test web/editor/tests/tools.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as m from "../model.js";
import * as t from "../tools.js";

const E = [40, 47, 52, 56], A = [45, 52, 57, 61], B = [47, 54, 59, 63];
function song(beats = 4, division = 2) {
  const p = m.migrate({ id: "s", title: "S", bars: 4, signature: [{ bar: 0, beats, division }], tempo: [{ bar: 0, bpm: 120 }],
    tracks: [{ id: "g", name: "Guitar", instrument: "steel", notes: [] }, { id: "b", name: "Bass", instrument: "bass", notes: [] }, { id: "d", name: "Drums", kind: "drums", notes: [] }] });
  [E, A, B, E].forEach((chord, bar) => chord.forEach((pitch) => p.tracks[0].notes.push([bar, 0, beats, pitch, 0.8])));
  p.progression = t.detectProgression(p, "g"); return p;
}
const abs = (p, n) => m.layout(p).start[n[0]] + n[1];

test("the chord lane is read off a track and merges repeated chords", () => {
  const p = song();
  assert.deepEqual(p.progression.map((c) => [c.bar, c.pos, c.len, c.name]), [[0, 0, 4, "E"], [1, 0, 4, "A"], [2, 0, 4, "B"], [3, 0, 4, "E"]]);
  assert.deepEqual(p.progression[1].pitches, A);
  const L = m.layout(p);
  assert.equal(t.chordAt(p, L, 5.5).name, "A"); assert.equal(t.chordSlices(p, L, 1, 2).length, 2);
  t.setChord(p, 2, 4, { pitches: B }); // B over the second half of bar 1 and the first half of bar 2
  assert.deepEqual(p.progression.map((c) => [c.bar, c.pos, c.len, c.name]), [[0, 0, 2, "E"], [0, 2, 4, "B"], [1, 2, 2, "A"], [2, 0, 4, "B"], [3, 0, 4, "E"]]);
  assert.deepEqual(t.chordSlices(p, L, 0, 1).map((c) => [c.start, c.len, c.name]), [[0, 2, "E"], [2, 2, "B"], [4, 2, "B"], [6, 2, "A"]]); // cut at the bar line
  t.setChord(p, 0, 16, null); assert.equal(p.progression.length, 0);
});

test("bass lines follow the chords in each style", () => {
  const p = song(), bass = p.tracks[1];
  t.bassLine(p, bass, null, "held"); assert.deepEqual(bass.notes.map((n) => [n[0], n[2], n[3] % 12]), [[0, 4, 4], [1, 4, 9], [2, 4, 11], [3, 4, 4]]);
  assert.ok(bass.notes.every((n) => n[3] >= 28 && n[3] < 40));
  t.bassLine(p, bass, null, "pulse"); assert.equal(bass.notes.length, 16); assert.deepEqual(bass.notes.slice(0, 4).map((n) => n[1]), [0, 1, 2, 3]);
  t.bassLine(p, bass, null, "eighths"); assert.equal(bass.notes.length, 32);
  t.bassLine(p, bass, null, "octaves"); assert.deepEqual(bass.notes.slice(0, 4).map((n) => n[3] - bass.notes[0][3]), [0, 12, 0, 12]);
  t.bassLine(p, bass, null, "root-fifth"); assert.deepEqual(bass.notes.slice(0, 2).map((n) => n[3] % 12), [4, 11]);
  t.bassLine(p, bass, { a: 0, b: 1 }, "walking");
  const firstBar = bass.notes.filter((n) => n[0] === 0).sort((x, y) => x[1] - y[1]).map((n) => n[3] % 12);
  assert.deepEqual(firstBar.slice(0, 3), [4, 8, 11]); assert.ok([8, 10].includes(firstBar[3])); // root, third, fifth, then a step from the next root (A)
  assert.equal(bass.notes.filter((n) => n[0] >= 2).length, 8); // other bars untouched
  const six = song(2, 3); t.bassLine(six, six.tracks[1], null, "eighths"); assert.equal(six.tracks[1].notes.length, 4 * 6); assert.equal(six.tracks[1].notes[1][1], 0.3333);
});

test("pad, arpeggio and strum parts", () => {
  const p = song(), tr = p.tracks[1];
  p.progression = [{ bar: 0, pos: 0, len: 8, name: "E", pitches: E }, { bar: 2, pos: 0, len: 8, name: "A", pitches: A }];
  t.padPart(p, tr, null);
  assert.equal(tr.notes.length, 6); assert.ok(tr.notes.every((n) => n[2] === 8 && n[3] >= 50 && n[3] <= 76)); // one held voicing per chord, across the bar line
  assert.deepEqual([...new Set(tr.notes.filter((n) => n[0] === 0).map((n) => n[3] % 12))].sort((a, b) => a - b), [4, 8, 11]);
  t.arpeggio(p, tr, { a: 0, b: 0 }, { shape: "up", rate: 0.5, octaves: 1 });
  const bar0 = tr.notes.filter((n) => n[0] === 0).sort((x, y) => x[1] - y[1]);
  assert.equal(bar0.length, 8); assert.deepEqual(bar0.slice(0, 4).map((n) => n[3] % 12), [4, 8, 11, 4]); assert.ok(bar0[3][3] === bar0[0][3] + 12);
  t.arpeggio(p, tr, { a: 0, b: 0 }, { shape: "random", rate: 0.25, seed: 7 }); const once = JSON.stringify(tr.notes);
  t.arpeggio(p, tr, { a: 0, b: 0 }, { shape: "random", rate: 0.25, seed: 7 }); assert.equal(JSON.stringify(tr.notes), once); // same seed, same notes
  t.strum(p, tr, { a: 0, b: 0 }, "pop");
  const strums = [...new Set(tr.notes.filter((n) => n[0] === 0).map((n) => Math.round(n[1] * 2) / 2))].sort((a, b) => a - b);
  assert.deepEqual(strums, [0, 1, 1.5, 2.5, 3, 3.5]);
  const down = tr.notes.filter((n) => n[0] === 0 && n[1] < 0.5).sort((x, y) => x[1] - y[1]); assert.deepEqual(down.map((n) => n[3]), E); // low string first
  assert.ok(down[1][1] > 0 && down[1][1] < 0.05); // strings are a few ms apart
});

test("drum styles fit the bar, with fills and crashes", () => {
  const rock = t.drumBar("rock", 4, 2);
  assert.deepEqual(rock.filter((h) => h[1] === 36).map((h) => h[0]), [0, 2, 2.5]); assert.deepEqual(rock.filter((h) => h[1] === 38).map((h) => h[0]), [1, 3]); assert.equal(rock.filter((h) => h[1] === 42).length, 8);
  const six = t.drumBar("rock", 2, 3); assert.equal(six.filter((h) => h[1] === 42).length, 6); assert.deepEqual(six.filter((h) => h[1] === 38).map((h) => h[0]), [1]);
  assert.equal(t.drumBar("four", 4, 2).filter((h) => h[1] === 36).length, 4);
  for (const style of Object.keys(t.DRUM_STYLES)) for (const [beats, div] of [[4, 2], [3, 2], [2, 3], [5, 2]]) assert.ok(t.drumBar(style, beats, div).every((h) => h[0] >= 0 && h[0] < beats), style);
  const p = song(), d = p.tracks[2]; p.bars = 8; p.progression = []; t.drumPart(p, d, null, { style: "rock", fillEvery: 4 });
  assert.ok(d.notes.some((n) => n[0] === 3 && [48, 45, 41].includes(n[3]) && n[1] >= 3)); // a tom fill ends bar 4
  assert.ok(d.notes.some((n) => n[0] === 4 && n[1] === 0 && n[3] === 49)); // and a crash opens bar 5
  assert.ok(!d.notes.some((n) => n[0] === 7 && [48, 45, 41].includes(n[3]))); // no fill at the very end
});

test("transforms: quantize, humanize, legato, transpose, loudness, harmonize, double", () => {
  const p = song(), tr = p.tracks[1]; tr.notes = [[0, 0.1, 0.4, 60, 0.5], [0, 1.45, 0.4, 62, 0.5], [1, 0.9, 0.5, 64, 0.5]];
  t.quantize(p, tr, null, 0.5); assert.deepEqual(tr.notes.map((n) => [n[0], n[1]]), [[0, 0], [0, 1.5], [1, 1]]);
  t.legato(p, tr, null); assert.deepEqual(tr.notes.map((n) => n[2]), [1.5, 3.5, 0.5]);
  t.transpose(p, tr, { indices: [0] }, 12); assert.deepEqual(tr.notes.map((n) => n[3]), [72, 62, 64]);
  t.loudness(p, tr, null, { from: 0.2, to: 1 }); assert.deepEqual(tr.notes.map((n) => n[4]), [0.2, 0.44, 1]);
  t.loudness(p, tr, { bars: { a: 1, b: 1 } }, { scale: 0.5 }); assert.equal(tr.notes[2][4], 0.5);
  const before = JSON.stringify(tr.notes); t.humanize(p, tr, null, 1, 3); assert.notEqual(JSON.stringify(tr.notes), before);
  assert.ok(tr.notes.every((n, i) => Math.abs(abs(p, n) - abs(p, JSON.parse(before)[i])) <= 0.031));
  const cMajor = m.makeScale(0, "major"); tr.notes = [[0, 0, 1, 60, 0.8], [0, 1, 1, 64, 0.8], [0, 2, 1, 71, 0.8]];
  assert.equal(t.harmonize(p, tr, null, cMajor, 2), 3); assert.deepEqual(tr.notes.slice(3).map((n) => n[3]), [64, 67, 74]); // thirds above, inside the scale
  tr.notes = [[0, 0, 1, 64, 0.8]]; t.harmonize(p, tr, null, cMajor, -2); assert.equal(tr.notes[1][3], 60);
  t.double(p, tr, { indices: [0] }, -12); assert.equal(tr.notes[2][3], 52);
  t.transpose(p, p.tracks[2], null, 5); // drums are left alone
});

test("chords built on a scale", () => {
  const chords = t.diatonicChords(m.makeScale(4, "major"));
  assert.deepEqual(chords.map((c) => c.name), ["E", "F#m", "G#m", "A", "B", "C#m", "D#dim"]);
  assert.deepEqual(chords.map((c) => c.numeral), ["I", "ii", "iii", "IV", "V", "vi", "vii°"]);
  assert.deepEqual(t.diatonicChords(m.makeScale(9, "minor"), true).map((c) => c.name).slice(0, 3), ["Am7", "Bm7b5", "Cmaj7"]);
  assert.equal(t.diatonicChords(m.makeScale(0, "minor pentatonic")).length, 0);
  assert.equal(m.parsePitch("C#4"), 61); assert.equal(m.parsePitch("Bb2"), 46); assert.equal(m.parsePitch(64), 64); assert.equal(m.parsePitch("H2"), null);
});
