// Port of sketch/rhythm.py and the parts of sketch/tidy.py it uses: decide how
// each beat is divided, then land every strum on that division.
//
// A *feel* is picked for every beat (straight eighths, sixteenths or triplets)
// by how well the strums in that beat fit each one, preferring the simpler
// feel when the fit is close and preferring not to flip feel from one beat to
// the next. Notes then snap to their beat's division, ends snap too, and small
// gaps before the next strum are closed.
//
// A sketch note is {pitch, beat, length, velocity}: start and length in beats
// from the start of bar 1, velocity 0-1 (tidy.SketchNote).

import { pyRound } from "./numeric.js";

// tidy.py
export const STRUM_WINDOW = 0.06; // s: notes starting this close together are one strum
export const BLIP_SECONDS = 0.12; // notes both shorter than this ...
export const BLIP_VELOCITY = 0.4; // ... and quieter than this are dropped as blips

// rhythm.py
export const FEELS = {
  eighths: [0.0, 0.5],
  sixteenths: [0.0, 0.25, 0.5, 0.75],
  triplets: [0.0, 1 / 3, 2 / 3],
};
const FEEL_NAMES = Object.keys(FEELS);
// A finer feel must fit this much better (squared beats per beat) to be chosen.
const FEEL_COST = { eighths: 0.0, sixteenths: 0.030, triplets: 0.035 };
// When the beat is known to divide in three (tapped that way), triplets are the plain choice.
const FEEL_COST_TRIPLE = { triplets: 0.0, eighths: 0.030, sixteenths: 0.045 };
const MERGE_COST = 0.05; // two separate strums landing on the same slot
const SWITCH_COST = 0.010; // changing feel between neighbouring beats
const MIN_LENGTH = { eighths: 0.25, sixteenths: 0.25, triplets: 1 / 3 };

const isBlip = (n) => n.end - n.start < BLIP_SECONDS && n.velocity < BLIP_VELOCITY;
const byStartThenPitch = (a, b) => a.start - b.start || a.pitch - b.pitch;

/** The blip list of tidy.tidy: notes left out for being short and quiet, in memo seconds. */
export function droppedBlips(notes) {
  return notes.filter(isBlip).sort(byStartThenPitch).map((n) => ({
    pitch: n.pitch, start: pyRound(n.start, 3), end: pyRound(n.end, 3),
    velocity: pyRound(n.velocity, 3), reason: "short and quiet",
  }));
}

/** tidy.clean_overlaps: merge duplicates at the same spot and stop a note when its pitch is struck again. */
export function cleanOverlaps(notes) {
  const sorted = notes.map((n) => ({ ...n })).sort((a, b) => a.pitch - b.pitch || a.beat - b.beat);
  const out = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    const prev = last && last.pitch === n.pitch ? last : null;
    if (prev && n.beat <= prev.beat + 1e-6) {
      prev.length = Math.max(prev.length, n.length);
      prev.velocity = Math.max(prev.velocity, n.velocity);
      continue;
    }
    if (prev && prev.beat + prev.length > n.beat) prev.length = pyRound(n.beat - prev.beat, 3);
    out.push(n);
  }
  return out.sort((a, b) => a.beat - b.beat || a.pitch - b.pitch);
}

/** rhythm._snap: nearest point of this beat's division (the next beat's start counts too). */
function snap(position, feel) {
  const beat = Math.floor(position);
  let best = 0, bestDistance = Infinity;
  for (const x of [...FEELS[feel], 1.0]) {
    const distance = Math.abs(beat + x - position);
    if (distance < bestDistance) { best = beat + x; bestDistance = distance; }
  }
  return best;
}

/** rhythm.choose_feels: one feel per beat, by dynamic programming (Viterbi) over fit + simplicity + continuity. */
export function chooseFeels(positions, nBeats, division = 2) {
  const feelCost = division === 3 ? FEEL_COST_TRIPLE : FEEL_COST;
  const plain = division === 3 ? "triplets" : "eighths";
  const k = FEEL_NAMES.length;
  const inBeat = new Map();
  for (const position of positions) {
    const beat = Math.trunc(position);
    if (beat >= 0 && beat < nBeats) {
      if (!inBeat.has(beat)) inBeat.set(beat, []);
      inBeat.get(beat).push(position);
    }
  }
  const cost = Array.from({ length: nBeats }, () => new Array(k).fill(0));
  for (const [beat, here] of inBeat) {
    FEEL_NAMES.forEach((name, j) => {
      const slots = here.map((p) => snap(p, name));
      let fit = 0;
      here.forEach((p, i) => { fit += (p - slots[i]) * (p - slots[i]); });
      const merged = slots.length - new Set(slots).size; // separate strums forced onto one slot
      cost[beat][j] = fit + MERGE_COST * merged + feelCost[name];
    });
  }
  let best = cost[0].slice();
  const back = Array.from({ length: nBeats }, () => new Array(k).fill(0));
  for (let b = 1; b < nBeats; b++) {
    const next = new Array(k);
    for (let j = 0; j < k; j++) {
      let from = 0, least = Infinity;
      for (let i = 0; i < k; i++) {
        const step = best[i] + (i === j ? 0 : SWITCH_COST);
        if (step < least) { least = step; from = i; }
      }
      back[b][j] = from;
      next[j] = least + cost[b][j];
    }
    best = next;
  }
  let at = 0;
  for (let j = 1; j < k; j++) if (best[j] < best[at]) at = j;
  const path = [at];
  for (let b = nBeats - 1; b > 0; b--) path.push(back[b][path[path.length - 1]]);
  path.reverse();
  // Beats nobody plays in have no feel of their own: give them the plain one.
  return path.map((j, beat) => (inBeat.has(beat) ? FEEL_NAMES[j] : plain));
}

/**
 * rhythm.clean: raw notes (seconds) -> [cleaned sketch notes, feel per beat].
 * Short quiet blips are left out. `division` 3 means the beat is known to
 * divide in three, so triplets are preferred over eighths.
 */
export function clean(notes, grid, division = 2) {
  const kept = notes.filter((n) => !isBlip(n)).sort(byStartThenPitch);
  const strums = [];
  for (const n of kept) {
    const strum = strums[strums.length - 1];
    if (strum && n.start - strum[strum.length - 1].start <= STRUM_WINDOW) strum.push(n);
    else strums.push([n]);
  }
  const nBeats = grid.beatTimes.length - 1;
  const played = strums.map((s) => grid.toBeats(s[0].start));
  const feels = chooseFeels(played, nBeats, division);
  const feelAt = (position) => feels[Math.trunc(Math.min(Math.max(position, 0), nBeats - 1))];

  const slots = played.map((p) => snap(p, feelAt(p)));
  const out = [];
  strums.forEach((strum, i) => {
    const slot = slots[i];
    let nextSlot = null;
    for (let j = i + 1; j < slots.length; j++) if (slots[j] > slot) { nextSlot = slots[j]; break; }
    for (const n of strum) {
      let end = grid.toBeats(n.end);
      end = snap(end, feelAt(end));
      // Close a small gap before the next strum so the line does not stutter.
      if (nextSlot !== null && nextSlot - end > 0 && nextSlot - end <= 0.26) end = nextSlot;
      const length = Math.max(end - slot, MIN_LENGTH[feelAt(slot)]);
      out.push({ pitch: n.pitch, beat: pyRound(slot, 4), length: pyRound(length, 4), velocity: pyRound(n.velocity, 3) });
    }
  });
  return [cleanOverlaps(out), feels];
}

/** rhythm.time_signature: four beats that are mostly triplets is 12/8, not 4/4. */
export function timeSignature(meter, feels) {
  const share = feels.filter((f) => f === "triplets").length / Math.max(feels.length, 1);
  return share > 0.5 ? `${meter * 3}/8` : `${meter}/4`;
}

/** rhythm.runs: per-beat feels as runs [{beat, length, feel}]. */
export function runs(feels) {
  const out = [];
  feels.forEach((feel, beat) => {
    const last = out[out.length - 1];
    if (last && last.feel === feel) last.length += 1;
    else out.push({ beat, length: 1, feel });
  });
  return out;
}

/** rhythm.expand: runs back to one feel per beat. */
export function expand(feelRuns, nBeats) {
  const feels = new Array(nBeats).fill("eighths");
  for (const run of feelRuns) for (let b = run.beat; b < Math.min(run.beat + run.length, nBeats); b++) feels[b] = run.feel;
  return feels;
}
