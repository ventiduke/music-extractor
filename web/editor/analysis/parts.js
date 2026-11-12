// Port of sketch/parts.py: generated parts that follow the guitar.
//
// Deliberately plain. Each is a starting point to edit, not a finished part:
// - bass: the lowest pitch class the guitar plays in each two-beat window, down an octave or two
// - pad: the main pitch classes of each window, held, in the middle register
// - drums: kick and snare by the bar, hi-hat on the beat's division (eighths or triplets)

import { pyMod, pyRound } from "./numeric.js";
import { sounding } from "./harmony.js";

export const KICK = 36, SNARE = 38, HAT = 42;
// Beat numbers (0-based) within a bar.
const DRUM_PATTERNS = {
  2: { kick: [0], snare: [1] },
  3: { kick: [0], snare: [2] },
  4: { kick: [0, 2], snare: [1, 3] },
  5: { kick: [0, 3], snare: [2, 4] },
  6: { kick: [0], snare: [3] },
};
export const PART_NAMES = ["bass", "pad", "drums"];

/** parts._windows: [start beat, length, sounding pitches] for each half bar (whole bar when the meter is odd). */
function windows(notes, nBeats, meter) {
  const size = meter % 2 ? meter : 2;
  const out = [];
  for (let barStart = 0; barStart < nBeats; barStart += meter) {
    for (let start = barStart; start < Math.min(barStart + meter, nBeats); start += size) {
      const length = Math.min(size, barStart + meter - start, nBeats - start);
      const pitches = sounding(notes, start, start + length);
      if (pitches.size) out.push([start, length, pitches]);
    }
  }
  return out;
}

/** parts.make_bass. */
export function makeBass(notes, nBeats, meter) {
  return windows(notes, nBeats, meter).map(([start, length, pitches]) => ({
    pitch: 28 + pyMod(Math.min(...pitches.keys()) - 28, 12), // E1 .. D#2
    beat: start, length, velocity: 0.8,
  }));
}

/** parts.make_pad. */
export function makePad(notes, nBeats, meter) {
  const chords = []; // {start, length, voiced}
  for (const [start, length, pitches] of windows(notes, nBeats, meter)) {
    const byClass = new Map();
    for (const [p, w] of pitches) byClass.set(p % 12, (byClass.get(p % 12) ?? 0.0) + w);
    const top = Math.max(...byClass.values());
    const classes = [...byClass.keys()].sort((a, b) => byClass.get(b) - byClass.get(a)).slice(0, 4); // stable
    const voiced = classes.filter((pc) => byClass.get(pc) >= 0.3 * top).map((pc) => 60 + pc).sort((a, b) => a - b); // C4 .. B4
    const last = chords[chords.length - 1];
    if (last && last.voiced.join() === voiced.join() && last.start + last.length === start) last.length += length;
    else chords.push({ start, length, voiced });
  }
  return chords.flatMap((c) => c.voiced.map((pitch) => ({ pitch, beat: c.start, length: c.length, velocity: 0.45 })));
}

/** parts.make_drums. `feels` is one feel per beat. */
export function makeDrums(notes, nBeats, meter, feels) {
  if (!notes.length) return [];
  const first = Math.floor(Math.trunc(Math.min(...notes.map((n) => n.beat))) / meter) * meter;
  const last = Math.trunc(Math.max(...notes.map((n) => n.beat + n.length)));
  const pattern = DRUM_PATTERNS[meter] ?? { kick: [0], snare: [] };
  const out = [];
  for (let beat = first; beat < Math.min(last + 1, nBeats); beat++) {
    const inBar = beat % meter;
    if (pattern.kick.includes(inBar)) out.push({ pitch: KICK, beat, length: 0.25, velocity: 0.9 });
    if (pattern.snare.includes(inBar)) out.push({ pitch: SNARE, beat, length: 0.25, velocity: 0.8 });
    const steps = feels[beat] === "triplets" ? [0.0, 1 / 3, 2 / 3] : [0.0, 0.5];
    steps.forEach((step, i) => out.push({ pitch: HAT, beat: pyRound(beat + step, 4), length: 0.25, velocity: i === 0 ? 0.55 : 0.35 }));
  }
  return out;
}

/** parts.make_parts: {bass, pad, drums}. */
export function makeParts(notes, nBeats, meter, feels) {
  return {
    bass: makeBass(notes, nBeats, meter),
    pad: makePad(notes, nBeats, meter),
    drums: makeDrums(notes, nBeats, meter, feels),
  };
}
