// Port of sketch/harmony.py (spans) and sketch/theory.py (chords used, likely
// scales): what the notes add up to.
//
// A harmony span is just its bass note and the pitches that sound, so unusual
// voicings come through as they are. A chord's `pitches` (the voicing played)
// are the truth; its `name` is a best guess, and is just the note names when
// no common chord fits.

import { NOTE_NAMES, noteName } from "../model.js";
import { npSum, pyRound } from "./numeric.js";

// Intervals above the root -> suffix. Checked in this order, so plainer names win.
const CHORD_SHAPES = [
  [[0, 4, 7], ""], [[0, 3, 7], "m"], [[0, 7], "5"], [[0, 4, 7, 10], "7"], [[0, 4, 7, 11], "maj7"], [[0, 3, 7, 10], "m7"],
  [[0, 2, 7], "sus2"], [[0, 5, 7], "sus4"], [[0, 2, 4, 7], "add9"], [[0, 2, 3, 7], "m(add9)"], [[0, 4, 7, 9], "6"],
  [[0, 3, 7, 9], "m6"], [[0, 4, 5, 7], "add11"], [[0, 5, 7, 10], "7sus4"], [[0, 2, 4, 7, 11], "maj9"],
  [[0, 2, 3, 7, 10], "m9"], [[0, 2, 4, 7, 10], "9"], [[0, 3, 6], "dim"], [[0, 4, 8], "aug"], [[0, 4, 10], "7(no5)"],
  [[0, 3, 10], "m7(no5)"], [[0, 4, 11], "maj7(no5)"],
].map(([intervals, suffix]) => [intervals.join(","), suffix]);

const SCALES = {
  "major": [0, 2, 4, 5, 7, 9, 11],
  "minor": [0, 2, 3, 5, 7, 8, 10],
  "dorian": [0, 2, 3, 5, 7, 9, 10],
  "mixolydian": [0, 2, 4, 5, 7, 9, 10],
  "lydian": [0, 2, 4, 6, 7, 9, 11],
  "phrygian": [0, 1, 3, 5, 7, 8, 10],
  "harmonic minor": [0, 2, 3, 5, 7, 8, 11],
  "major pentatonic": [0, 2, 4, 7, 9],
  "minor pentatonic": [0, 3, 5, 7, 10],
};

const ascending = (a, b) => a - b;
const mod12 = (x) => ((x % 12) + 12) % 12;

/**
 * harmony._sounding: pitch -> weight (beats sounding x velocity) between two
 * beats, keeping only pitches with at least a quarter of the strongest weight.
 * A Map, in the order the pitches are first met (ties elsewhere depend on it).
 */
export function sounding(notes, start, end) {
  const weights = new Map();
  for (const n of notes) {
    const overlap = Math.min(n.beat + n.length, end) - Math.max(n.beat, start);
    if (overlap > 0) weights.set(n.pitch, (weights.get(n.pitch) ?? 0.0) + overlap * n.velocity);
  }
  if (!weights.size) return weights;
  const top = Math.max(...weights.values());
  return new Map([...weights].filter(([, w]) => w >= 0.25 * top));
}

/**
 * harmony.harmony_spans: merge consecutive beats with the same bass and mostly
 * the same pitch classes into spans
 * [{beat, length, bar, beat_in_bar, bass, pitches, pitch_classes, midi}].
 * `midi` (the sounding pitches as numbers) is an addition to the Python rows.
 */
export function harmonySpans(notes, nBeats, meter) {
  const spans = [];
  for (let beat = 0; beat < nBeats; beat++) {
    const pitches = sounding(notes, beat, beat + 1);
    if (!pitches.size) continue;
    const pcs = new Set([...pitches.keys()].map(mod12));
    const bass = Math.min(...pitches.keys());
    const prev = spans[spans.length - 1];
    if (prev && prev.beat + prev.length === beat && mod12(prev.bassPitch) === mod12(bass)) {
      const shared = [...pcs].filter((pc) => prev.pcs.has(pc)).length;
      const either = pcs.size + prev.pcs.size - shared;
      const sameBar = Math.floor(prev.beat / meter) === Math.floor(beat / meter);
      const sameClasses = shared === pcs.size && shared === prev.pcs.size;
      if (shared / either >= 0.6 && (sameBar || sameClasses)) { prev.length += 1; continue; }
    }
    spans.push({ beat, length: 1, bassPitch: bass, pcs });
  }
  return spans.map((s) => {
    const midi = [...sounding(notes, s.beat, s.beat + s.length).keys()].sort(ascending);
    return {
      beat: s.beat,
      length: s.length,
      bar: Math.floor(s.beat / meter) + 1,
      beat_in_bar: s.beat % meter + 1,
      bass: noteName(midi[0]),
      pitches: midi.map(noteName),
      pitch_classes: [...new Set(midi.map(mod12))].sort(ascending).map((pc) => NOTE_NAMES[pc]),
      midi,
    };
  });
}

/** theory.chord_name: best-guess name for a set of pitches; the lowest note is tried as the root first. */
export function chordName(pitches) {
  const classes = [...new Set(pitches.map(mod12))].sort(ascending);
  const bass = mod12(Math.min(...pitches));
  for (const root of [bass, ...classes.filter((pc) => pc !== bass)]) {
    const shape = classes.map((pc) => mod12(pc - root)).sort(ascending).join(",");
    const hit = CHORD_SHAPES.find(([intervals]) => intervals === shape);
    if (hit) {
      const name = NOTE_NAMES[root] + hit[1];
      return root === bass ? name : `${name}/${NOTE_NAMES[bass]}`;
    }
  }
  return classes.sort((a, b) => mod12(a - bass) - mod12(b - bass)).map((pc) => NOTE_NAMES[pc]).join(" ");
}

/** theory.chords_used: distinct chords, most used first: [{name, pitches (the voicing played), beats}]. */
export function chordsUsed(notes, nBeats, meter, limit = 16) {
  const found = new Map();
  for (const span of harmonySpans(notes, nBeats, meter)) {
    const end = span.beat + span.length;
    const struck = new Set(notes.filter((n) => n.beat < end && n.beat + n.length > span.beat).map((n) => n.pitch));
    const voicing = span.midi.filter((p) => struck.has(p));
    const classes = [...new Set(voicing.map(mod12))].sort(ascending);
    if (classes.length < 2) continue;
    const key = `${mod12(voicing[0])}|${classes.join(",")}`;
    if (!found.has(key)) found.set(key, { beats: 0, longest: 0, pitches: voicing });
    const entry = found.get(key);
    entry.beats += span.length;
    if (span.length > entry.longest) { entry.longest = span.length; entry.pitches = voicing; }
  }
  return [...found.values()]
    .sort((a, b) => b.beats - a.beats) // stable: equally used chords stay in order of appearance
    .slice(0, limit)
    .filter((e) => e.beats >= 2)
    .map((e) => ({ name: chordName(e.pitches), pitches: e.pitches, beats: e.beats }));
}

/** theory._histogram: weight of each pitch class (beats sounding x velocity) between two beats. */
function histogram(notes, start, end) {
  const hist = new Array(12).fill(0);
  for (const n of notes) {
    const overlap = Math.min(n.beat + n.length, end) - Math.max(n.beat, start);
    if (overlap > 0) hist[mod12(n.pitch)] += overlap * n.velocity;
  }
  return hist;
}

/** theory._rank_scales: every scale on every tonic, best first. */
function rankScales(hist, bassHist) {
  const total = npSum(hist);
  if (total <= 0) return [];
  const bassTotal = npSum(bassHist);
  const out = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [name, steps] of Object.entries(SCALES)) {
      const classes = steps.map((s) => (tonic + s) % 12);
      const inside = npSum(classes.map((pc) => hist[pc])) / total; // share of what is played that the scale covers
      const used = classes.filter((pc) => hist[pc] > 0.02 * total).length / classes.length; // share of the scale actually played
      const home = (hist[tonic] + bassHist[tonic]) / (total + bassTotal); // how much the tonic is leaned on
      out.push({
        name: `${NOTE_NAMES[tonic]} ${name}`, tonic, pitch_classes: classes.slice().sort(ascending),
        fit: pyRound(inside, 3), score: inside + 0.25 * used + 0.6 * home,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score); // stable, like Python's sort
}

/**
 * theory.likely_scales: the best few scales for the whole song, plus any
 * stretch where a different one fits clearly better (a likely key change).
 * Each is {name, tonic, pitch_classes, fit, bars: [first, last]} (bars 1-based, inclusive).
 */
export function likelyScales(notes, nBeats, meter, windowBars = 8, top = 4) {
  const bass = notes.filter((n) => n.pitch < 52);
  const whole = rankScales(histogram(notes, 0, nBeats), histogram(bass, 0, nBeats));
  const nBars = Math.max(1, Math.floor(nBeats / meter));
  const out = whole.slice(0, top).map((s) => ({ ...s, bars: [1, nBars] }));
  const main = out[0];
  const span = windowBars * meter;
  const regional = [];
  for (let start = 0; start + span <= nBeats; start += span) {
    const ranked = rankScales(histogram(notes, start, start + span), histogram(bass, start, start + span));
    if (!ranked.length || !main) continue;
    const best = ranked[0];
    const mainHere = ranked.find((s) => s.name === main.name);
    // Only call it a change when the song's main scale clearly fits worse here.
    if (best.name !== main.name && best.fit >= mainHere.fit + 0.08) {
      const bars = [Math.floor(start / meter) + 1, Math.floor((start + span) / meter)];
      const last = regional[regional.length - 1];
      if (last && last.name === best.name && last.bars[1] === bars[0] - 1) last.bars[1] = bars[1];
      else regional.push({ ...best, bars });
    }
  }
  return [...out, ...regional].map(({ score, ...scale }) => scale);
}
