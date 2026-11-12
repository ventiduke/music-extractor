// Beat estimate from the notes alone, for recordings nobody tapped along to.
//
// Python falls back to librosa's beat tracker on the audio here, which is not
// available in the browser. This is the same idea (Ellis's dynamic-programming
// beat tracker, as in `librosa.beat.beat_track`) run on the extracted notes
// instead of the audio. There is no Python reference for its output: it is a
// first guess, and tapped beats remain the authority.
//
// 1. Onset strength: every strum (notes starting within 60 ms of each other)
//    is a bump at its start time, as tall as the summed velocity of its notes.
// 2. Tempo: the lag between 60 and 180 bpm where the curve's autocorrelation
//    is strongest, weighted towards 120 bpm (one octave wide) to settle
//    half / double tempo.
// 3. Beats: the sequence of frames that collects the most onset strength
//    while staying close to that spacing; it follows mild tempo drift.

import { STRUM_WINDOW } from "./rhythm.js";

const FRAME = 0.01; // s per step of the onset-strength curve
const BUMP = 1.5; // width (standard deviation, in frames) of the bump one strum makes
const MIN_BPM = 60, MAX_BPM = 180;
const CENTRE_BPM = 120, OCTAVES = 1.0; // tempo preference: log-normal around 120 bpm
const TIGHTNESS = 100; // how strictly beats keep to the estimated spacing (librosa's default)
const DEFAULT_PERIOD = 0.5; // s, when the notes give no tempo at all

/** Strums as [{time, weight}]: weight is the summed velocity of the notes in the strum. */
function strums(notes) {
  const out = [];
  let last = null;
  for (const n of [...notes].sort((a, b) => a.start - b.start)) {
    if (last === null || n.start - last > STRUM_WINDOW) out.push({ time: n.start, weight: 0 });
    out[out.length - 1].weight += n.velocity;
    last = n.start;
  }
  return out;
}

/** Onset-strength curve sampled every FRAME seconds. */
function onsetCurve(hits, seconds) {
  const curve = new Float64Array(Math.ceil(seconds / FRAME) + 1);
  for (const { time, weight } of hits) {
    const centre = time / FRAME;
    for (let i = Math.max(0, Math.ceil(centre - 4 * BUMP)); i <= Math.min(curve.length - 1, centre + 4 * BUMP); i++) {
      curve[i] += weight * Math.exp(-0.5 * ((i - centre) / BUMP) ** 2);
    }
  }
  return curve;
}

/** Beat period in frames (fractional), or 0 when the curve shows no repetition in the tempo range. */
function beatPeriod(curve) {
  const autocorrelation = (lag) => {
    let sum = 0;
    for (let i = 0; i + lag < curve.length; i++) sum += curve[i] * curve[i + lag];
    return sum;
  };
  const shortest = Math.ceil(60 / MAX_BPM / FRAME), longest = Math.floor(60 / MIN_BPM / FRAME);
  let best = 0, bestScore = 0;
  for (let lag = shortest; lag <= longest; lag++) {
    const octavesOff = Math.log2(60 / (lag * FRAME) / CENTRE_BPM) / OCTAVES;
    const score = autocorrelation(lag) * Math.exp(-0.5 * octavesOff * octavesOff);
    if (score > bestScore) { best = lag; bestScore = score; }
  }
  if (!best) return 0;
  // Parabola through the peak and its neighbours, for a period finer than one frame.
  const before = autocorrelation(best - 1), peak = autocorrelation(best), after = autocorrelation(best + 1);
  const curvature = before - 2 * peak + after;
  const nudge = curvature < 0 ? 0.5 * (before - after) / curvature : 0;
  return best + Math.max(-0.5, Math.min(0.5, nudge));
}

/** Frames of the beats: the best-scoring chain of frames about `period` apart (dynamic programming). */
function trackBeats(curve, period) {
  const n = curve.length;
  let mean = 0, peak = 0;
  for (const v of curve) { mean += v / n; peak = Math.max(peak, v); }
  let variance = 0;
  for (const v of curve) variance += (v - mean) * (v - mean) / n;
  const scale = Math.sqrt(variance) || 1;

  const nearest = Math.max(1, Math.round(period / 2)), farthest = Math.floor(2 * period);
  const penalty = new Float64Array(farthest + 1); // for a step of d frames from the previous beat
  for (let d = nearest; d <= farthest; d++) penalty[d] = -TIGHTNESS * Math.log(d / period) ** 2;

  const total = new Float64Array(n); // best score of a chain ending with a beat on frame i
  const previous = new Int32Array(n).fill(-1);
  let started = false; // beats start with the first real onset
  for (let i = 0; i < n; i++) {
    let from = -1, carried = 0;
    for (let d = nearest; d <= farthest && d <= i; d++) {
      const score = total[i - d] + penalty[d];
      if (from < 0 || score > carried) { from = i - d; carried = score; }
    }
    total[i] = curve[i] / scale + carried;
    if (!started && curve[i] < 0.01 * peak) continue;
    started = true;
    previous[i] = from;
  }

  // End on the last frame that is a local best and still scores at least half the typical local best.
  const peaks = [];
  for (let i = 1; i < n - 1; i++) if (total[i] > total[i - 1] && total[i] >= total[i + 1]) peaks.push(i);
  if (!peaks.length) return [];
  const sorted = peaks.map((i) => total[i]).sort((a, b) => a - b);
  const typical = sorted[sorted.length >> 1];
  let at = peaks[0];
  for (const i of peaks) if (2 * total[i] > typical) at = i;
  const frames = [];
  for (; at >= 0; at = previous[at]) frames.push(at);
  return frames.reverse();
}

/**
 * Beat times (seconds, ascending) estimated from raw notes [{pitch, start, end, velocity}].
 * The first beat returned is the one the first strum sits on (or the last one
 * before it), so it can stand in for "tap 1". Always returns at least 4 beats.
 */
export function estimateBeats(notes, duration) {
  if (!notes.length) return [];
  const hits = strums(notes);
  const firstOnset = hits[0].time, lastOnset = hits[hits.length - 1].time;
  const lastEnd = Math.max(...notes.map((n) => n.end));
  const curve = onsetCurve(hits, Math.max(duration || 0, lastEnd));
  const period = beatPeriod(curve);
  const seconds = period ? period * FRAME : DEFAULT_PERIOD;

  let beats = period ? trackBeats(curve, period).map((frame) => frame * FRAME) : [];
  // Keep the beats that carry the playing; the grid is extended at the local spacing afterwards.
  beats = beats.filter((t) => t >= firstOnset - 0.25 * seconds && t <= lastOnset + 0.5 * seconds);
  if (beats.length < 4) {
    // Too little to track: a steady pulse from the first strum to the end of the last note.
    const count = Math.max(4, Math.ceil((lastEnd - firstOnset) / seconds) + 1);
    beats = Array.from({ length: count }, (_, k) => firstOnset + k * seconds);
  }
  return beats.map((t) => Math.round(t * 1e4) / 1e4);
}
