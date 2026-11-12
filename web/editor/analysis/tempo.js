// Port of sketch/tempo.py: sharpen a beat grid with the strums, and tell
// sustained tempo changes from wobble.
//
// Taps say *which* beat (good to about 50 ms); strums say *when* (about 10 ms)
// but not which beat they belong to. `refine` combines them. `tempoSections`
// then splits the piece into stretches of steady tempo: a change has to last
// two bars and be about 5% to make a new section.

import { arange, diff, gradient, interp, median, npMean, npSum, pyRound, rint } from "./numeric.js";

const MIN_BARS = 2;
const CHANGE_PENALTY = 0.012; // squared log-tempo error a new section must save
const MERGE_BELOW = 0.04; // neighbouring sections closer than 4% in tempo are one section

/** tempo.refine: move each beat to where the strums around it say it is (two passes by default). */
export function refine(times, strums, division, reach = 0.2, passes = 2) {
  for (let i = 0; i < passes; i++) times = refineOnce(times, strums, division, reach);
  return times;
}

/** tempo._refine_once: strums near a subdivision vote for their beat; beats without votes follow their neighbours. */
function refineOnce(times, strums, division, reach) {
  const n = times.length, index = arange(n);
  const gaps = gradient(times);
  const votes = new Map();
  for (const t of strums) {
    const position = interp(t, times, index);
    const slot = rint(position * division) / division;
    const near = Math.abs(position - slot) <= reach / division * 2;
    const beat = rint(slot);
    if (near && beat >= 0 && beat < n && Math.abs(slot - beat) < 0.5) {
      if (!votes.has(beat)) votes.set(beat, []);
      votes.get(beat).push(t - (slot - beat) * gaps[beat]);
    }
  }
  const known = [...votes.keys()].sort((a, b) => a - b);
  if (!known.length) return times;
  const estimates = known.map((b) => median(votes.get(b)) - times[b]);
  const shift = index.map((i) => interp(i, known, estimates));
  // A light smoothing (edges repeated) keeps one odd strum from bending the grid.
  const refined = times.map((t, i) => {
    const before = shift[Math.max(i - 1, 0)], after = shift[Math.min(i + 1, n - 1)];
    return t + (0.25 * before + 0.5 * shift[i] + 0.25 * after);
  });
  // Never let beats cross or bunch up.
  const floor = 0.5 * median(diff(times));
  for (let i = 1; i < n; i++) if (refined[i] - refined[i - 1] < floor) refined[i] = refined[i - 1] + floor;
  return refined;
}

/** tempo.tempo_sections: steady-tempo sections as [{beat, length, bpm, looseness_ms}]. */
export function tempoSections(beatTimes, meter) {
  const times = beatTimes;
  const nBars = Math.floor((times.length - 1) / meter);
  if (nBars < 1) return [{ beat: 0, length: times.length - 1, bpm: pyRound(60.0 / median(diff(times)), 1) }];
  const logTempo = [];
  for (let b = 0; b < nBars; b++) logTempo.push(Math.log(60.0 * meter / (times[(b + 1) * meter] - times[b * meter])));

  // Fewest sections that explain the bar tempos: dynamic programming with a cost per section.
  const cost = (a, b) => {
    const seg = logTempo.slice(a, b), mid = median(seg);
    return npSum(seg.map((v) => (v - mid) * (v - mid)));
  };
  const best = [0, ...new Array(nBars).fill(Infinity)];
  const cut = new Array(nBars + 1).fill(0);
  for (let end = 1; end <= nBars; end++) {
    const stop = end >= MIN_BARS ? end - MIN_BARS + 1 : 1;
    for (let start = 0; start < stop; start++) {
      if (start && start < MIN_BARS) continue;
      const total = best[start] + cost(start, end) + CHANGE_PENALTY;
      if (total < best[end]) { best[end] = total; cut[end] = start; }
    }
  }
  const bounds = [nBars];
  while (bounds[bounds.length - 1] > 0) bounds.push(cut[bounds[bounds.length - 1]]);
  bounds.reverse();

  const merged = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i], b = bounds[i + 1], last = merged[merged.length - 1];
    if (last && Math.abs(median(logTempo.slice(a, b)) - median(logTempo.slice(last[0], last[1]))) < MERGE_BELOW) last[1] = b;
    else merged.push([a, b]);
  }

  const sections = merged.map(([a, b]) => {
    const first = a * meter, last = b * meter;
    const gaps = diff(times.slice(first, last + 1));
    const typical = median(gaps);
    return {
      beat: first,
      length: last - first,
      bpm: pyRound(60.0 / typical, 1),
      // How far single beats strayed from this section's steady pulse.
      looseness_ms: pyRound(1000 * median(gaps.map((g) => Math.abs(g - typical))) * 1.4826),
    };
  });
  const tail = sections[sections.length - 1];
  tail.length = times.length - 1 - tail.beat; // beats past the last full bar
  return sections;
}

/** tempo.per_beat: the steady tempo of every beat. */
export function perBeat(sections, nBeats, fallback) {
  const bpms = new Array(nBeats).fill(fallback);
  for (const s of sections) for (let b = s.beat; b < Math.min(s.beat + s.length, nBeats); b++) bpms[b] = s.bpm;
  return bpms;
}

/** tempo.as_sections: per-beat tempos back to runs (keeping `looseness_ms` where a run still starts where it did). */
export function asSections(bpms, old = []) {
  const keep = new Map(old.map((s) => [`${s.beat}|${s.bpm}`, s.looseness_ms]));
  const out = [];
  bpms.forEach((bpm, beat) => {
    const last = out[out.length - 1];
    if (last && last.bpm === bpm) last.length += 1;
    else out.push({ beat, length: 1, bpm });
  });
  for (const s of out) {
    const looseness = keep.get(`${s.beat}|${s.bpm}`);
    if (looseness !== undefined && looseness !== null) s.looseness_ms = looseness;
  }
  return out;
}

/**
 * tempo.best_division: does the beat divide in two or three?
 * Returns [division, fit]: the clearly better division (0 if too close to call)
 * and each one's fit as a share of what random timing would score (lower is better).
 */
export function bestDivision(times, strums) {
  const index = arange(times.length);
  const position = Array.from(strums, (t) => interp(t, times, index));
  const fit = {};
  for (const division of [2, 3]) {
    let scaled = position.map((p) => p * division);
    const early = median(scaled.map((s) => s - rint(s))); // taps run a little early or late as a whole
    scaled = scaled.map((s) => s - early);
    const error = scaled.map((s) => Math.abs(s - rint(s)) / division);
    fit[division] = pyRound(npMean(error) / (1 / (4 * division)), 2);
  }
  if (fit[3] < fit[2] - 0.1) return [3, fit];
  if (fit[2] < fit[3] - 0.1) return [2, fit];
  return [0, fit]; // too close to call
}
