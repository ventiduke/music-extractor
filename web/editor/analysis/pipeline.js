// Extracted notes -> song project, in the browser.
//
// A port of the Python pipeline in `sketch/`: `sketch.build.build(audio, beats=...)`
// followed by `sketch.project.from_sketch(sketch)`, starting from the notes
// already extracted from one recording. Given the same notes and taps it gives
// the same project as Python (checked by tests/analysis.test.mjs).
//
//   grid.js      beat grid from tapped beats            (sketch/grid.py)
//   tempo.js     sharpen the grid, tempo sections       (sketch/tempo.py)
//   rhythm.js    feel per beat, notes onto the grid     (sketch/rhythm.py, sketch/tidy.py)
//   harmony.js   harmony spans, chords used, scales     (sketch/harmony.py, sketch/theory.py)
//   parts.js     generated bass, pad and drums          (sketch/parts.py)
//   beats.js     beat estimate when nobody tapped       (no Python counterpart)
//   numeric.js   numpy / Python number behaviour        (rounding, interp, median, sums)
//
// Not ported: the light tidy (`light_notes`), the key estimate, the automatic
// bar-length and downbeat guess of the audio beat tracker, and the edit history.

import { noteName } from "../model.js";
import { estimateBeats } from "./beats.js";
import { gridFromTaps, strumOnsets, tappedTimes } from "./grid.js";
import { chordsUsed, harmonySpans, likelyScales } from "./harmony.js";
import { floorDiv, pyRound } from "./numeric.js";
import { PART_NAMES, makeParts } from "./parts.js";
import { clean, cleanOverlaps, droppedBlips, runs, timeSignature } from "./rhythm.js";
import { asSections, bestDivision, perBeat, tempoSections } from "./tempo.js";

export { estimateBeats };

const VERSION = 2;
const DRUM_NAMES = { 36: "kick", 38: "snare", 42: "hat" };
const INSTRUMENTS = { guitar: "pluck", bass: "bass", pad: "pad", drums: "kit" };
const VOLUMES = { guitar: 0.9, bass: 0.8, pad: 0.5, drums: 0.7 };

/** build.as_rows: sketch notes with their id, name and musician's position. */
function asRows(notes, grid, drums = false) {
  return notes.map((n, id) => {
    const [bar, beatInBar] = grid.barAndBeat(n.beat);
    const name = drums ? DRUM_NAMES[n.pitch] ?? `drum ${n.pitch}` : noteName(n.pitch);
    return { id, pitch: n.pitch, name, bar, beat_in_bar: beatInBar, beat: n.beat, length: n.length, velocity: n.velocity };
  });
}

/**
 * build.build + build.refresh: raw notes -> sketch (the intermediate result, in beats on the recording's grid).
 *
 * notes: [{pitch, start, end, velocity}] in seconds.
 * opts:  {duration, taps?, beats_per_bar?, division?, downbeat_shift?, source?}
 *   With `taps` (at least 4), they set the grid. Without, beats are estimated
 *   from the notes (`estimateBeats`) and used the same way; bars are then
 *   `beats_per_bar` (default 4) beats long, counted from the first strum's beat.
 *   `division` (default 2) is overridden when the notes clearly divide the
 *   beat the other way; `division_from` says which was used.
 *
 * Returns the sketch fields Python writes, minus `key`, `light_notes`, the
 * confidences and `history`: {version, source, beats_from, division,
 * division_from, tempo_bpm, tempo_map, meter, time_signature, bars, feel,
 * harmony, notes, parts, dropped, beat_times}.
 */
export function buildSketch(notes, opts = {}) {
  if (!notes || !notes.length) throw new Error("no notes found");
  const duration = opts.duration ?? Math.max(...notes.map((n) => n.end));
  const tapped = Array.isArray(opts.taps) && opts.taps.length > 0;
  const beats = tapped ? opts.taps : estimateBeats(notes, duration);
  const meter = Math.trunc(opts.beats_per_bar ?? 4);
  const shift = Math.trunc(opts.downbeat_shift ?? 0);
  let division = Math.trunc(opts.division ?? 2);
  let divisionFrom = tapped ? "taps" : opts.division ? "given" : "default";
  // The notes can show the beat dividing in three when "two" was saved (or the reverse).
  const [seen] = bestDivision(tappedTimes(beats), strumOnsets(notes));
  if (seen && seen !== division) {
    divisionFrom = tapped ? `notes (the taps file said ${division})` : "notes";
    division = seen;
  }
  const grid = gridFromTaps(beats, notes, duration, meter, division, shift);
  const [cleaned, feels] = clean(notes, grid, division);
  const nBeats = grid.beatTimes.length - 1;
  const generated = makeParts(cleaned, nBeats, grid.meter, feels);
  const sections = tempoSections(grid.beatTimes, grid.meter);

  // build.refresh: everything derived from the notes.
  const guitar = cleanOverlaps(cleaned);
  return {
    version: VERSION,
    source: opts.source ?? null,
    beats_from: tapped ? "taps" : "estimate",
    division,
    division_from: divisionFrom,
    tempo_bpm: grid.tempoBpm,
    tempo_map: asSections(perBeat(sections, nBeats, grid.tempoBpm), sections).map((row) => ({
      ...row, bar: Math.floor(row.beat / grid.meter) + 1, bars: Math.ceil(row.length / grid.meter),
    })),
    meter: grid.meter,
    time_signature: timeSignature(grid.meter, feels),
    bars: grid.nBars,
    feel: runs(feels),
    harmony: harmonySpans(guitar, nBeats, grid.meter).map(({ midi, ...span }) => span),
    notes: asRows(guitar, grid),
    parts: Object.fromEntries(PART_NAMES.map((name) => [name, asRows(cleanOverlaps(generated[name]), grid, name === "drums")])),
    dropped: droppedBlips(notes),
    beat_times: grid.beatTimes,
  };
}

/**
 * project.from_sketch: sketch -> project (format v2, described at the top of ../model.js).
 * The project no longer refers to the recording's timing. `info` is {id, title?, source?}.
 */
export function projectFromSketch(sketch, info = {}) {
  const meter = sketch.meter;
  const nBeats = sketch.beat_times.length - 1;
  const nBars = Math.floor(nBeats / meter);
  const bpms = perBeat(sketch.tempo_map, nBeats, sketch.tempo_bpm);
  const feels = sketch.feel.flatMap((run) => new Array(run.length).fill(run.feel));
  let division = sketch.division;
  if (division !== 3 && feels.filter((f) => f === "triplets").length > feels.length / 2) division = 3;
  const tempo = [];
  for (let bar = 0; bar < nBars; bar++) {
    const bpm = bpms[bar * meter];
    if (!tempo.length || tempo[tempo.length - 1].bpm !== bpm) tempo.push({ bar, bpm });
  }
  const sections = (sketch.tempo_map.length ? sketch.tempo_map : [{ bar: 1 }])
    .map((row, i) => ({ bar: row.bar - 1, name: `Part ${i + 1}` }))
    .filter((section) => section.bar < nBars);

  const rows = (notes) => {
    const out = [];
    for (const n of notes) {
      const bar = Math.trunc(floorDiv(n.beat, meter));
      if (bar < nBars) out.push([bar, pyRound(n.beat - bar * meter, 4), n.length, n.pitch, n.velocity]);
    }
    return out;
  };
  const capitalize = (name) => name[0].toUpperCase() + name.slice(1).toLowerCase();
  const tracks = [["guitar", sketch.notes], ...Object.entries(sketch.parts)].map(([name, notes]) => ({
    id: name, name: capitalize(name), kind: name === "drums" ? "drums" : "pitched",
    instrument: INSTRUMENTS[name] ?? "pluck", volume: VOLUMES[name] ?? 0.7, mute: false, notes: rows(notes),
  }));
  const id = info.id ?? "song";
  const source = info.source ?? sketch.source;
  return {
    version: VERSION,
    id,
    title: info.title ?? id,
    ...(source === null || source === undefined ? {} : { source }),
    bars: nBars,
    tempo,
    signature: [{ bar: 0, beats: meter, division }],
    sections,
    tracks,
    chords: chordsUsed(sketch.notes, nBeats, meter),
    scales: likelyScales(sketch.notes, nBeats, meter),
  };
}

/**
 * Raw extracted notes of one recording -> song project for the editor.
 *
 * notes: [{pitch, start, end, velocity}] in seconds.
 * opts:  {id, title, source?, duration, taps?: number[], beats_per_bar?: number, division?: 2|3, downbeat_shift?: number}
 */
export function buildProject(notes, opts = {}) {
  return projectFromSketch(buildSketch(notes, opts), opts);
}
