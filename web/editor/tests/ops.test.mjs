// Run with: node --test web/editor/tests/ops.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as m from "../model.js";
import { applyOps, describe, extractOps, GUIDE } from "../ops.js";

const song = () => { const p = m.migrate({ id: "s", title: "S", bars: 8, tracks: [{ id: "g", name: "Guitar", instrument: "steel", notes: [] }] });
  [[40, 47, 52, 56], [45, 52, 57, 61]].forEach((ch, i) => { for (let bar = i * 4; bar < i * 4 + 4; bar++) ch.forEach((pitch) => p.tracks[0].notes.push([bar, 0, 4, pitch, 0.8])); }); return p; };

test("operations change tempo, signature, sections and bars", () => {
  const p = song();
  const r = applyOps(p, [{ op: "set_tempo", bpm: 90, bars: [5, 8] }, { op: "set_signature", beats: 3, bars: [7, 8] }, { op: "set_section", bar: 5, name: "Chorus" }, { op: "set_title", title: "Demo" }]);
  assert.deepEqual(r.errors, []); assert.equal(r.done.length, 4);
  assert.deepEqual(p.tempo, [{ bar: 0, bpm: 100 }, { bar: 4, bpm: 90 }]); assert.deepEqual(m.layout(p).beats, [4, 4, 4, 4, 4, 4, 3, 3]);
  assert.deepEqual(p.sections, [{ bar: 0, name: "Part 1" }, { bar: 4, name: "Chorus" }]); assert.equal(p.title, "Demo");
  applyOps(p, [{ op: "set_tempo", bpm: 100, bars: [5, 8] }]); assert.deepEqual(p.tempo, [{ bar: 0, bpm: 100 }]); // equal neighbours fold back together
  applyOps(p, [{ op: "repeat_bars", bars: [1, 4] }, { op: "insert_bars", after: 12, count: 2 }, { op: "delete_bars", bars: [13, 14] }]); assert.equal(p.bars, 12);
  assert.equal(p.tracks[0].notes.filter((n) => n[0] >= 4 && n[0] < 8 && n[3] === 40).length, 4);
});

test("tracks, notes, chords, generators and transforms", () => {
  const p = song();
  const r = applyOps(p, [
    { op: "detect_chords", track: "guitar" },
    { op: "generate", part: "bass", track: "Bass", style: "walking" },
    { op: "generate", part: "drums", track: "Drums", style: "half", bars: [1, 4] },
    { op: "generate", part: "arpeggio", track: "Arp", shape: "updown", rate: 0.5, instrument: "harp" },
    { op: "add_notes", track: "Lead", instrument: "flute", notes: [{ bar: 1, beat: 1, length: 2, pitch: "E5" }, { bar: 1, beat: 3, length: 2, pitch: "G#5", velocity: 0.6 }, { bar: 99, beat: 1, pitch: "C4" }] },
    { op: "transform", action: "harmonize", track: "Lead", steps: -2, scale: "E major" },
    { op: "transform", action: "transpose", track: "Guitar", semitones: 2, bars: [5, 8] },
    { op: "set_track", track: "Bass", instrument: "upright", volume: 0.6, pan: -0.3 },
    { op: "add_chord", name: "Esus2", notes: ["E2", "B2", "E3", "F#3"] },
    { op: "set_chords", chords: [{ bar: 8, beat: 3, length: 2, notes: ["B2", "F#3", "B3", "D#4"] }] },
  ]);
  assert.deepEqual(r.errors, []);
  const by = (name) => p.tracks.find((t) => t.name === name);
  assert.deepEqual(p.tracks.map((t) => t.name), ["Guitar", "Bass", "Drums", "Arp", "Lead"]);
  assert.equal(by("Bass").notes.length, 32); assert.equal(by("Bass").instrument, "upright"); assert.equal(by("Bass").pan, -0.3);
  assert.equal(by("Drums").kind, "drums"); assert.ok(by("Drums").notes.every((n) => n[0] < 4)); assert.equal(by("Arp").instrument, "harp");
  assert.deepEqual(by("Lead").notes.map((n) => m.noteName(n[3])), ["E5", "G#5", "C#5", "E5"]); assert.equal(by("Lead").instrument, "flute");
  assert.ok(by("Guitar").notes.some((n) => n[0] === 4 && n[3] === 47) && by("Guitar").notes.some((n) => n[0] === 0 && n[3] === 40));
  assert.equal(p.chords.at(-1).name, "Esus2"); assert.equal(p.progression.at(-1).name, "B"); assert.deepEqual([p.progression.at(-1).bar, p.progression.at(-1).pos, p.progression.at(-1).len], [7, 2, 2]);
});

test("bad operations are refused one by one, without stopping the rest", () => {
  const p = song(), r = applyOps(p, [{ op: "set_tempo", bpm: 900 }, { op: "fly" }, { op: "remove_track", track: "Guitar" }, { op: "transform", action: "transpose", track: "Nope", semitones: 1 },
    { op: "generate", part: "drums", track: "Guitar" }, { op: "delete_bars", bars: [7, 20] }, { op: "set_tempo", bpm: 80 }]);
  assert.equal(r.errors.length, 6); assert.deepEqual(r.done, ["tempo 80 for bars 1-8"]); assert.equal(p.tempo[0].bpm, 80); assert.equal(p.tracks.length, 1);
});

test("replies are parsed and songs are described", () => {
  assert.deepEqual(extractOps('Sure!\n```json\n[{"op":"set_tempo","bpm":90}]\n```\nDone.'), [{ op: "set_tempo", bpm: 90 }]);
  assert.deepEqual(extractOps('{"ops":[{"op":"clear","track":"all"}]}'), [{ op: "clear", track: "all" }]);
  assert.deepEqual(extractOps('Here you go: [{"op":"set_title","title":"A [b]"}] hope it helps'), [{ op: "set_title", title: "A [b]" }]);
  assert.equal(extractOps("I cannot do that."), null); assert.equal(extractOps('[{"nop":1}]'), null);
  const p = song(); applyOps(p, [{ op: "detect_chords" }]);
  const text = describe(p); assert.match(text, /Song "S": 8 bars/); assert.match(text, /"Guitar" \(sound steel\): 32 notes/); assert.match(text, /Chord lane.*1-4: E \| 5-8: A/);
  assert.match(describe(p, { bars: [1, 1] }), /bar 1: 1 E2 4, 1 B2 4, 1 E3 4, 1 G#3 4/);
  for (const name of ["set_tempo", "set_signature", "add_notes", "generate", "transform", "set_chords"]) assert.ok(GUIDE.includes(`"op":"${name}"`));
});

test("the Claude skill carries an exact copy of the editor's song code", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["model.js", "tools.js", "ops.js", "midi.js"])
    assert.equal(readFileSync(new URL(`../../../.claude/skills/song-workbench/lib/${f}`, import.meta.url), "utf8"), readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), `${f} is out of date: run node tools/sync_skill.mjs`);
});

test("the style prompt for a cover tool is written from the song", async () => {
  const { stylePrompt } = await import("../brief.js");
  const p = song(); applyOps(p, [{ op: "generate", part: "drums", track: "Drums" }, { op: "add_track", name: "Empty", instrument: "flute" }]);
  p.scales = [{ name: "E major", tonic: 4, pitch_classes: [1, 3, 4, 6, 8, 9, 11] }];
  assert.equal(stylePrompt(p, "warm indie folk, intimate.", { steel: "Steel guitar" }), "warm indie folk, intimate. instrumental, no vocals. steel guitar, drums. E major, 4/4, about 100 bpm.");
  applyOps(p, [{ op: "set_tempo", bpm: 130, bars: [5, 8] }, { op: "set_signature", beats: 2, division: 3 }, { op: "set_track", track: "Drums", mute: true }]);
  assert.equal(stylePrompt(p), "instrumental, no vocals. steel. E major, 6/8 with a lilting triplet feel, tempo building from 100 to 130 bpm.");
});
