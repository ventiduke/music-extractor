// Run with: node --test web/editor/tests/analysis.test.mjs
//
// The analysis in web/editor/analysis/ is a port of the Python in sketch/.
// For two real recordings, fixtures/NAME.input.json holds the inputs,
// NAME.expected.json the project Python made, and NAME.sketch.json Python's
// intermediate values.
//
// About the tolerances below. Run on exactly the notes in NAME.input.json,
// Python and this port give identical projects (checked once, value for value).
// The fixtures' `expected` files were made from the notes *before* they were
// rounded to 5 decimals for the input files, which shows up in two places:
// - a velocity that was just under a half-thousandth (0.59449...) is stored as
//   0.5945 and now rounds the other way, so a few notes differ by 0.001;
// - a beat time that was within 0.000005 s of a rounding edge can land on the
//   other 0.0001 s step.
// Each check states how many such values there are; everything else is exact.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildProject, buildSketch, estimateBeats } from "../analysis/pipeline.js";
import { floorDiv, interp, median, npSum, pyRound } from "../analysis/numeric.js";

const fixture = (file) => JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));
const close = (a, b, tolerance, what) => assert.ok(Math.abs(a - b) <= tolerance, `${what}: ${a} vs ${b} (tolerance ${tolerance})`);
const byBarPosPitch = (a, b) => a[0] - b[0] || a[1] - b[1] || a[3] - b[3];

// Measured: values that differ from Python's because the fixture inputs were rounded (see the top of the file).
const FIXTURES = [
  { name: "Voice_250929_161042", velocitiesOff: 5, beatTimesOff: 2, droppedOff: 1 },
  { name: "Voice_251221_120247", velocitiesOff: 6, beatTimesOff: 4, droppedOff: 0 },
];

for (const { name, velocitiesOff, beatTimesOff, droppedOff } of FIXTURES) {
  const input = fixture(`${name}.input.json`);
  const expected = fixture(`${name}.expected.json`);
  const python = fixture(`${name}.sketch.json`);
  const project = buildProject(input.notes, input);
  const sketch = buildSketch(input.notes, input);

  test(`${name}: bars, signature, sections and tempo match Python`, () => {
    assert.equal(project.version, 2);
    assert.equal(project.id, expected.id);
    assert.equal(project.title, expected.title);
    assert.equal(project.source, expected.source);
    assert.equal(project.bars, expected.bars);
    assert.deepEqual(project.signature, expected.signature);
    assert.deepEqual(project.sections, expected.sections);
    assert.deepEqual(project.tempo.map((t) => t.bar), expected.tempo.map((t) => t.bar));
    project.tempo.forEach((t, i) => close(t.bpm, expected.tempo[i].bpm, 0.11, `bpm from bar ${t.bar}`));
  });

  test(`${name}: every track has Python's notes (at most ${velocitiesOff} guitar velocities off by 0.001)`, () => {
    assert.deepEqual(project.tracks.map((t) => t.id), expected.tracks.map((t) => t.id));
    project.tracks.forEach((track, i) => {
      const { notes, ...settings } = track;
      const { notes: wanted, ...wantedSettings } = expected.tracks[i];
      assert.deepEqual(settings, wantedSettings);
      assert.equal(notes.length, wanted.length, `${track.id}: number of notes`);
      const got = [...notes].sort(byBarPosPitch), want = [...wanted].sort(byBarPosPitch);
      let off = 0;
      got.forEach((n, k) => {
        const w = want[k], what = `${track.id} note ${k} ${JSON.stringify(n)} vs ${JSON.stringify(w)}`;
        assert.equal(n[0], w[0], `bar of ${what}`);
        close(n[1], w[1], 1e-3, `position of ${what}`);
        close(n[2], w[2], 1e-3, `length of ${what}`);
        assert.equal(n[3], w[3], `pitch of ${what}`);
        if (n[4] !== w[4]) {
          close(n[4], w[4], 0.0011, `velocity of ${what}`);
          off += 1;
        }
      });
      assert.ok(off <= (track.id === "guitar" ? velocitiesOff : 0), `${track.id}: ${off} velocities differ from Python's`);
    });
  });

  test(`${name}: chords and scales match Python`, () => {
    assert.deepEqual(project.chords, expected.chords); // names, order, pitches and beats
    assert.deepEqual(project.scales.map((s) => s.name), expected.scales.map((s) => s.name));
    project.scales.forEach((scale, i) => {
      const want = expected.scales[i];
      close(scale.fit, want.fit, 0.002, `fit of ${scale.name}`);
      assert.deepEqual(scale.bars, want.bars);
      assert.equal(scale.tonic, want.tonic);
      assert.deepEqual(scale.pitch_classes, want.pitch_classes);
    });
  });

  test(`${name}: the steps in between match Python's sketch`, () => {
    for (const key of ["meter", "division", "division_from", "tempo_bpm", "time_signature"]) assert.equal(sketch[key], python[key], key);
    assert.deepEqual(sketch.tempo_map, python.tempo_map);
    assert.deepEqual(sketch.feel, python.feel);
    assert.deepEqual(sketch.harmony, python.harmony);

    assert.equal(sketch.beat_times.length, python.beat_times.length);
    let off = 0;
    sketch.beat_times.forEach((t, i) => {
      close(t, python.beat_times[i], 1.01e-4, `beat ${i}`);
      if (t !== python.beat_times[i]) off += 1;
    });
    assert.ok(off <= beatTimesOff, `${off} beat times differ from Python's by 0.0001 s`);

    assert.equal(sketch.dropped.length, python.dropped.length);
    off = 0;
    sketch.dropped.forEach((note, i) => {
      const want = python.dropped[i];
      assert.equal(note.pitch, want.pitch);
      for (const key of ["start", "end", "velocity"]) close(note[key], want[key], 0.0011, `dropped note ${i} ${key}`);
      if (JSON.stringify(note) !== JSON.stringify(want)) off += 1;
    });
    assert.ok(off <= droppedOff, `${off} dropped notes differ from Python's by 0.001`);

    python.notes.forEach((want, i) => { // Python's first 60 cleaned notes
      const { velocity, ...rest } = sketch.notes[i];
      const { velocity: wantedVelocity, ...wantedRest } = want;
      assert.deepEqual(rest, wantedRest);
      close(velocity, wantedVelocity, 0.0011, `velocity of note ${i}`);
    });
  });
}

test("the notes overrule a tapped division of two when they sit on thirds", () => {
  const input = fixture("Voice_251221_120247.input.json");
  assert.equal(input.division, 2);
  const sketch = buildSketch(input.notes, input);
  assert.equal(sketch.division, 3);
  assert.equal(sketch.division_from, "notes (the taps file said 2)");
  assert.deepEqual(buildProject(input.notes, input).signature, [{ bar: 0, beats: 2, division: 3 }]);
});

test("number helpers behave like Python and numpy", () => {
  // round(): halves go to the even neighbour, on the exact value of the double
  assert.deepEqual([0.5, 1.5, 2.5, 3.5, -2.5].map((x) => pyRound(x)), [0, 2, 2, 4, -2]);
  assert.deepEqual([pyRound(0.125, 2), pyRound(0.375, 2), pyRound(2.675, 2), pyRound(0.0625, 3)], [0.12, 0.38, 2.67, 0.062]);
  assert.deepEqual([pyRound(1 / 3, 4), pyRound(2 / 3, 4), pyRound(127.65, 1)], [0.3333, 0.6667, 127.7]);
  // np.interp clamps outside the range
  assert.deepEqual([-1, 0, 0.5, 2, 9].map((x) => interp(x, [0, 1, 2], [10, 20, 40])), [10, 10, 15, 40, 40]);
  // np.median of an even count is the mean of the middle two
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([3, 1, 2]), 2);
  // a // b floors, for negative numbers too
  assert.deepEqual([floorDiv(7.5, 2), floorDiv(-0.5, 2), floorDiv(8, 4)], [3, -1, 2]);
  // numpy adds in pairs: summing 0.1 ten times plainly gives 0.9999999999999999
  assert.equal(npSum(new Array(10).fill(0.1)), 1);
});

// ---------- no taps: beats estimated from the notes (no Python reference) ----------

const CHORDS = [[40, 47, 52, 56], [45, 52, 57, 61], [47, 54, 59, 63], [45, 52, 57, 61]];
/** Strummed chords at a steady tempo: full chord on the beat, lighter strums on the subdivisions in between. */
function strumming({ bpm, bars, perBeat, start = 1.0, jitter = 0 }) {
  const beat = 60 / bpm, notes = [];
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5; // repeatable
  for (let i = 0; i < bars * 4 * perBeat; i++) {
    const t = start + i * beat / perBeat + jitter * random();
    const onBeat = i % perBeat === 0, chord = CHORDS[Math.floor(i / (4 * perBeat)) % CHORDS.length];
    (onBeat ? chord : chord.slice(1)).forEach((pitch, string) => {
      notes.push({ pitch, start: t + 0.008 * string, end: t + beat / perBeat - 0.03, velocity: onBeat ? 0.8 : 0.5 });
    });
  }
  return { notes, duration: start + bars * 4 * beat + 1 };
}
const onGrid = (project, step) => project.tracks[0].notes.every((n) => Math.abs(n[1] / step - Math.round(n[1] / step)) < 1e-2);

test("without taps: steady eighth-note strumming at 120 bpm comes out at 120 in 4/4, on the grid", () => {
  const { notes, duration } = strumming({ bpm: 120, bars: 16, perBeat: 2 });
  const beats = estimateBeats(notes, duration);
  assert.ok(beats.length >= 64);
  beats.slice(1).forEach((t, i) => close(t - beats[i], 0.5, 0.011, `gap after beat ${i}`));
  close(beats[0], 1.0, 0.011, "first beat sits on the first strum");

  const sketch = buildSketch(notes, { duration });
  assert.equal(sketch.beats_from, "estimate");
  const project = buildProject(notes, { id: "steady", title: "Steady", duration });
  assert.equal(project.tempo.length, 1);
  const bpm = project.tempo[0].bpm;
  assert.ok([60, 120, 240].some((want) => Math.abs(bpm - want) <= want * 0.01), `tempo ${bpm}`);
  assert.deepEqual(project.signature, [{ bar: 0, beats: 4, division: 2 }]);
  assert.ok(project.bars === 16 || project.bars === 17, `bars ${project.bars}`); // Python's grid ends on a bar line *after* the last note
  const guitar = project.tracks[0].notes;
  assert.equal(guitar.length, notes.length);
  assert.ok(onGrid(project, 0.5), "every note starts on an eighth");
  assert.deepEqual(guitar[0].slice(0, 2), [0, 0]); // the first strum is beat 1 of bar 1
  assert.deepEqual(project.tracks.map((t) => t.id), ["guitar", "bass", "pad", "drums"]);
  assert.deepEqual(project.chords.map((c) => c.name), ["A", "E", "B"]); // most used first
});

test("without taps: loose timing still gives the tempo, and the result is repeatable", () => {
  const { notes, duration } = strumming({ bpm: 100, bars: 12, perBeat: 2, jitter: 0.02 });
  const project = buildProject(notes, { id: "loose", duration });
  for (const t of project.tempo) close(t.bpm, 100, 2, "tempo");
  assert.deepEqual(project.signature, [{ bar: 0, beats: 4, division: 2 }]);
  assert.ok(onGrid(project, 0.25));
  assert.deepEqual(buildProject(notes, { id: "loose", duration }), project);
});

test("without taps: strums on thirds of the beat give a beat that divides in three", () => {
  const { notes, duration } = strumming({ bpm: 90, bars: 12, perBeat: 3 });
  const sketch = buildSketch(notes, { duration });
  assert.equal(sketch.division, 3);
  assert.equal(sketch.division_from, "notes");
  const project = buildProject(notes, { id: "compound", duration });
  close(project.tempo[0].bpm, 90, 1, "tempo");
  assert.deepEqual(project.signature, [{ bar: 0, beats: 4, division: 3 }]); // 12/8
  assert.ok(onGrid(project, 1 / 3));
});

test("without taps: real recordings and very short inputs still give a usable project", () => {
  for (const { name } of FIXTURES) {
    const { notes, duration } = fixture(`${name}.input.json`);
    const beats = estimateBeats(notes, duration);
    assert.ok(beats.length >= 4);
    beats.slice(1).forEach((t, i) => assert.ok(t > beats[i], "beats ascend"));
    const project = buildProject(notes, { id: name, duration });
    assert.equal(project.signature[0].beats, 4);
    for (const t of project.tempo) assert.ok(t.bpm >= 55 && t.bpm <= 200, `tempo ${t.bpm}`);
    assert.ok(project.bars > 8 && project.tracks[0].notes.length > 0.8 * notes.length);
  }
  const one = buildProject([{ pitch: 60, start: 0.5, end: 1.0, velocity: 0.8 }], { id: "one", duration: 3 });
  assert.equal(one.bars, 1);
  assert.deepEqual(one.tracks[0].notes, [[0, 0, 1, 60, 0.8]]);
});

test("bad input is refused with a clear message", () => {
  assert.throws(() => buildProject([], { id: "empty", duration: 1 }), /no notes/);
  const note = [{ pitch: 60, start: 0.5, end: 1.0, velocity: 0.8 }];
  assert.throws(() => buildProject(note, { id: "few", duration: 3, taps: [0.5, 1.0, 1.5] }), /at least 4 taps/);
});
