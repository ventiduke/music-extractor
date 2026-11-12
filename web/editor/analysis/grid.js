// Port of sketch/grid.py (the tapped-beat half): turn tapped beats into a grid.
//
// A memo is played without a click, so the tempo drifts. The grid is a list
// of beat *times* in the recording: beat 0 is the start of bar 1 and
// `beatTimes[i]` is when beat i happens. Positions in beats convert to memo
// time and back through that list.

import { arange, diff, floorDiv, interp, median, pyMod, pyRound, rint, searchsorted } from "./numeric.js";
import { refine } from "./tempo.js";

/** grid.Grid: beat times, beats per bar and the typical tempo. */
export class Grid {
  constructor(beatTimes, meter, tempoBpm) {
    this.beatTimes = beatTimes; // time of beat 0, 1, 2, ... in the memo (s)
    this.meter = meter; // beats per bar
    this.tempoBpm = tempoBpm; // typical tempo
    this.index = arange(beatTimes.length);
  }

  /** Memo time (s) -> position in beats. Clamped to the grid's ends. */
  toBeats(t) { return interp(t, this.beatTimes, this.index); }

  /** Position in beats -> memo time (s). */
  toTime(beat) { return interp(beat, this.index, this.beatTimes); }

  /** 1-based bar number and beat within the bar, the way a musician counts. */
  barAndBeat(beat) { return [Math.trunc(floorDiv(beat, this.meter)) + 1, pyRound(pyMod(beat, this.meter) + 1, 3)]; }

  get nBars() { return Math.ceil((this.beatTimes.length - 1) / this.meter); }
}

/** grid.strum_onsets: start time of each strum (notes beginning within `window` of each other are one strum). */
export function strumOnsets(notes, window = 0.06) {
  const onsets = [];
  let last = null;
  for (const t of notes.map((n) => n.start).sort((a, b) => a - b)) {
    if (last === null || t - last > window) onsets.push(t);
    last = t;
  }
  return onsets;
}

/** grid.tapped_times: taps with double taps dropped and missed beats filled in, before any alignment to the notes. */
export function tappedTimes(taps) {
  taps = taps.map(Number).sort((a, b) => a - b);
  const kept = [taps[0]];
  for (const t of taps.slice(1)) if (t - kept[kept.length - 1] >= 0.12) kept.push(t);
  const filled = kept.slice(0, 2);
  for (const t of kept.slice(2)) {
    const local = median(diff(filled.slice(-5)));
    const missing = rint((t - filled[filled.length - 1]) / local) - 1;
    for (let k = 1; k <= missing; k++) {
      const last = filled[filled.length - 1];
      filled.push(last + (t - last) / (missing - k + 2));
    }
    filled.push(t);
  }
  return filled;
}

/** grid._align: slide the whole grid so the typical note start lands exactly on a subdivision. */
function align(times, notes, division, gap) {
  if (!notes.length) return times;
  const index = arange(times.length);
  const offset = median(notes.map((n) => {
    const played = interp(n.start, times, index);
    return played - rint(played * division) / division;
  }));
  return times.map((t) => t + offset * gap);
}

/** grid._bars: start bar 1 on the last bar line at or before the first note, and end on a bar line after the last. */
function bars(times, phase, meter, notes, duration, gap) {
  times = times.slice();
  const firstNote = notes.length ? Math.min(...notes.map((n) => n.start)) : 0.0;
  let origin = pyMod(phase, meter);
  for (let i = origin; i < times.length; i += meter) if (times[i] <= firstNote + 0.25 * gap) origin = i;
  const lastNote = notes.length ? Math.max(...notes.map((n) => n.end)) : duration;
  let end = searchsorted(times, lastNote) + 1;
  end = origin + Math.ceil((end - origin) / meter) * meter;
  while (end >= times.length) times.push(times[times.length - 1] + gap);
  return new Grid(times.slice(origin, end + 1).map((t) => pyRound(t, 4)), meter, pyRound(60.0 / gap, 1));
}

/**
 * grid.grid_from_taps: build the grid from beats a person tapped while listening.
 *
 * The taps are the authority on where the beat is and how fast it moves. They
 * are only tidied: double taps removed, missed beats and breaks filled in at
 * the local spacing, hand jitter smoothed a little, the whole grid slid so
 * note starts sit on its subdivisions, then each beat sharpened by the strums
 * around it (tempo.refine). `downbeatShift` says which tap is beat 1 (0 = the
 * first tap). `division` is how the tapped beat divides: 2 straight, 3 triplet / compound.
 */
export function gridFromTaps(taps, notes, duration, meter = 4, division = 2, downbeatShift = 0) {
  if (taps.length < 4) throw new Error("need at least 4 taps to make a beat grid");
  const times = tappedTimes(taps);
  const smooth = times.slice();
  for (let i = 1; i < times.length - 1; i++) smooth[i] = 0.25 * times[i - 1] + 0.5 * times[i] + 0.25 * times[i + 1];
  const first = smooth[0], last = smooth[smooth.length - 1];
  const head = median(diff(smooth.slice(0, 5))), tailGap = median(diff(smooth.slice(-5)));
  // Extend at the local spacing to cover the whole memo, with room to spare.
  const nBefore = Math.trunc(floorDiv(first, head)) + 8;
  const nAfter = Math.trunc(floorDiv(Math.max(duration - last, 0), tailGap)) + 8;
  const before = [], after = [];
  for (let k = nBefore; k > 0; k--) before.push(first - head * k);
  for (let k = 1; k <= nAfter; k++) after.push(last + tailGap * k);
  const gap = median(diff(smooth));
  let all = align([...before, ...smooth, ...after], notes, division, gap);
  all = refine(all, strumOnsets(notes), division);
  return bars(all, nBefore + downbeatShift, meter, notes, duration, gap);
}
