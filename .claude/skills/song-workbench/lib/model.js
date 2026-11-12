// The song model: pure functions over a project object. No DOM, no audio.
//
// project = {
//   version: 2, id, title, bars: <count>,
//   tempo:     [{bar, bpm}],               change lists: each entry applies from its bar
//   signature: [{bar, beats, division}],   until the next entry (bar is 0-based)
//   sections:  [{bar, name}],
//   tracks: [{id, name, kind: "pitched"|"drums", instrument, volume, pan, reverb, mute, solo,
//             notes: [[bar, position, length, pitch, velocity], ...]}],
//   chords: [{name, pitches}],                     the palette to draw with
//   progression: [{bar, pos, len, name, pitches}], the chord lane: what harmony sounds where
//   patterns: [{name, kind, length, notes: [[offset, length, pitch, velocity], ...]}],
//   scales: [{name, tonic, pitch_classes, fit, bars}]
// }
// Positions and lengths are in beats. A beat is what you would tap: it divides
// in `division` (2 or 3), so 2 beats dividing in 3 is 6/8.

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const noteName = (p) => NOTE_NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
export const DRUM_ROWS = [[49, "crash"], [51, "ride"], [53, "ride bell"], [46, "open hat"], [42, "hat"], [44, "pedal hat"], [54, "tambourine"], [70, "shaker"], [56, "cowbell"],
  [39, "clap"], [37, "rim"], [38, "snare"], [48, "high tom"], [45, "mid tom"], [41, "low tom"], [36, "kick"]];
const OLD_SOUNDS = { pluck: "steel", keys: "piano", lead: "saw" }; // names used before the sampled library
const DEFAULT_REVERB = { drums: 0.08, bass: 0, upright: 0, synthbass: 0, pad: 0.35, strings: 0.3, choir: 0.35 };
export const SNAPS = [[1, "1 beat"], [1 / 2, "1/2"], [1 / 3, "1/3"], [1 / 4, "1/4"], [1 / 6, "1/6"], [1 / 8, "1/8"], [1 / 48, "off"]];
const LISTS = ["tempo", "signature", "sections"];
const round = (x) => Math.round(x * 10000) / 10000;

export function sigText(s) { return s.division === 3 ? `${s.beats * 3}/8` : `${s.beats}/4`; }

/** Bring any saved project up to the current shape (v1 had a per-bar array). */
export function migrate(p) {
  p = JSON.parse(JSON.stringify(p));
  if (Array.isArray(p.bars)) {
    const bars = p.bars;
    p.tempo = runs(bars.map((b) => ({ bpm: b.bpm })));
    p.signature = runs(bars.map((b) => ({ beats: b.beats, division: b.division })));
    p.bars = bars.length;
  }
  p.version = 2;
  p.bars = Math.max(1, p.bars | 0);
  p.tempo = tidy(p.tempo && p.tempo.length ? p.tempo : [{ bar: 0, bpm: 100 }]);
  p.signature = tidy(p.signature && p.signature.length ? p.signature : [{ bar: 0, beats: 4, division: 2 }]);
  p.sections = tidy(p.sections && p.sections.length ? p.sections : [{ bar: 0, name: "Part 1" }]);
  p.tracks = (p.tracks || []).map((t) => {
    const kind = t.kind || "pitched", instrument = OLD_SOUNDS[t.instrument] || t.instrument || (kind === "drums" ? "kit" : "piano");
    return { volume: 0.8, pan: 0, reverb: DEFAULT_REVERB[kind === "drums" ? "drums" : instrument] ?? 0.15, mute: false, solo: false, ...t, kind, instrument, notes: t.notes || [] };
  });
  p.progression = (p.progression || []).filter((c) => c.pitches && c.pitches.length);
  p.patterns = p.patterns || [];
  p.chords = (p.chords || []).map((c) => ({ name: c.name, pitches: c.pitches.slice().sort((a, b) => a - b) }));
  p.scales = p.scales || [];
  return p;
}

export function blank(title = "New song") {
  return migrate({ id: "song-" + Date.now().toString(36), title, bars: 8, tracks: [{ id: "t1", name: "Piano", kind: "pitched", instrument: "piano" }] });
}

/** Sort a change list, keep one entry per bar (the later one), and make sure bar 0 has one. */
export function tidy(list) {
  const byBar = new Map();
  for (const e of list) byBar.set(Math.max(0, e.bar | 0), { ...e, bar: Math.max(0, e.bar | 0) });
  const out = [...byBar.values()].sort((a, b) => a.bar - b.bar);
  if (out[0].bar !== 0) out.unshift({ ...out[0], bar: 0 });
  return out;
}

/** Index of the entry in force at `bar`. */
export function indexAt(list, bar) { let i = 0; for (let k = 0; k < list.length; k++) if (list[k].bar <= bar) i = k; return i; }
export const at = (list, bar) => list[indexAt(list, bar)];

function runs(perBar) { // per-bar values -> change list
  const out = [];
  perBar.forEach((v, bar) => { const s = JSON.stringify(v); if (!out.length || out[out.length - 1]._s !== s) out.push({ bar, ...v, _s: s }); });
  return out.map(({ _s, ...e }) => e);
}
function expand(list, n) { // change list -> per-bar values (without `bar`)
  return Array.from({ length: n }, (_, bar) => { const { bar: _b, ...v } = at(list, bar); return v; });
}

/** Where every bar starts, in beats and in seconds. */
export function layout(p) {
  const n = p.bars, start = new Float64Array(n + 1), time = new Float64Array(n + 1), beats = [], bpm = [], division = [];
  let ti = 0, si = 0;
  for (let b = 0; b < n; b++) {
    while (ti + 1 < p.tempo.length && p.tempo[ti + 1].bar <= b) ti++;
    while (si + 1 < p.signature.length && p.signature[si + 1].bar <= b) si++;
    beats.push(p.signature[si].beats); division.push(p.signature[si].division); bpm.push(p.tempo[ti].bpm);
    start[b + 1] = start[b] + beats[b]; time[b + 1] = time[b] + beats[b] * 60 / bpm[b];
  }
  return { n, start, time, beats, bpm, division, total: start[n] };
}
export function barAt(L, beat) { // bar containing an absolute beat (binary search)
  let lo = 0, hi = L.n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (L.start[mid] <= beat + 1e-9) lo = mid; else hi = mid - 1; }
  return lo;
}
export const absOf = (note, L) => L.start[note[0]] + note[1];
export function place(beat, L) { const bar = barAt(L, Math.max(0, beat)); return [bar, round(Math.max(0, beat) - L.start[bar])]; }
export function timeAt(L, beat) { const bar = barAt(L, beat); return L.time[bar] + (beat - L.start[bar]) * 60 / L.bpm[bar]; }
export function beatAtTime(L, t) {
  let lo = 0, hi = L.n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (L.time[mid] <= t) lo = mid; else hi = mid - 1; }
  return L.start[lo] + (t - L.time[lo]) * L.bpm[lo] / 60;
}
export const snapTo = (beat, step) => round(Math.round(beat / step + 1e-9) * step);
export const snapDown = (beat, step) => round(Math.floor(beat / step + 1e-6) * step);

// ---------- blocks (tempo, signature, sections) ----------
/** Start a new block at `bar` (same value as the block it splits). Returns its index. */
export function splitAt(list, bar) {
  const i = indexAt(list, bar);
  if (list[i].bar === bar) return i;
  list.splice(i + 1, 0, { ...list[i], bar });
  return i + 1;
}
/** Move the start of block `index` to `bar`, kept between its neighbours. Block 0 always starts at bar 0. */
export function moveStart(list, index, bar, nBars) {
  if (index <= 0) return;
  const lo = list[index - 1].bar + 1, hi = (index + 1 < list.length ? list[index + 1].bar : nBars) - 1;
  list[index].bar = Math.max(lo, Math.min(hi, bar));
}
export function removeBlock(list, index) { if (index > 0) list.splice(index, 1); }

/** Drop notes that no longer fit their bar (after a signature change or a shorter song). */
export function prune(p) {
  const L = layout(p);
  for (const t of p.tracks) t.notes = t.notes.filter((n) => n[0] < p.bars && n[1] < L.beats[n[0]] - 1e-6);
  if (p.progression) p.progression = p.progression.filter((c) => c.bar < p.bars && c.pos < L.beats[c.bar] - 1e-6);
}

// ---------- bars ----------
function rebuild(p, edit) { // edit per-bar tempo/signature arrays, then turn them back into blocks
  const tempo = expand(p.tempo, p.bars), signature = expand(p.signature, p.bars);
  const n = edit(tempo, signature);
  p.bars = n; p.tempo = runs(tempo); p.signature = runs(signature);
}
/** Insert `count` empty bars before bar `where`; they take the tempo and signature of the bar before. */
export function insertBars(p, where, count = 1) {
  rebuild(p, (tempo, sig) => { const src = Math.max(0, Math.min(where - 1, p.bars - 1));
    tempo.splice(where, 0, ...Array.from({ length: count }, () => ({ ...tempo[src] })));
    sig.splice(where, 0, ...Array.from({ length: count }, () => ({ ...sig[src] }))); return tempo.length; });
  for (const t of p.tracks) for (const n of t.notes) if (n[0] >= where) n[0] += count;
  for (const c of p.progression || []) if (c.bar >= where) c.bar += count;
  for (const s of p.sections) if (s.bar >= where && s.bar > 0) s.bar += count;
}
/** Cut bars a..b out (inclusive); later bars move up. At least one bar always remains. */
export function deleteBars(p, a, b) {
  b = Math.min(b, p.bars - 1); if (b - a + 1 >= p.bars) { if (a === 0) a = 1; if (a > b) return; }
  const count = b - a + 1, after = b + 1 < p.bars ? { ...at(p.sections, b + 1) } : null;
  rebuild(p, (tempo, sig) => { tempo.splice(a, count); sig.splice(a, count); return tempo.length; });
  for (const t of p.tracks) { t.notes = t.notes.filter((n) => n[0] < a || n[0] > b); for (const n of t.notes) if (n[0] > b) n[0] -= count; }
  if (p.progression) { p.progression = p.progression.filter((c) => c.bar < a || c.bar > b); for (const c of p.progression) if (c.bar > b) c.bar -= count; }
  const keep = p.sections.filter((s) => s.bar < a || s.bar > b);
  for (const s of keep) if (s.bar > b) s.bar -= count;
  if (after && !keep.some((s) => s.bar === a) && at(keep.length ? tidy(keep) : [{ bar: 0, name: after.name }], a).name !== after.name) keep.push({ ...after, bar: a });
  p.sections = tidy(keep.length ? keep : [{ bar: 0, name: "Part 1" }]);
}
/** Repeat bars a..b right after themselves, with their notes, tempo and signature. */
export function duplicateBars(p, a, b) {
  const count = b - a + 1;
  for (const t of p.tracks) for (const n of t.notes) if (n[0] > b) n[0] += count;
  if (p.progression) { for (const c of p.progression) if (c.bar > b) c.bar += count; p.progression.push(...p.progression.filter((c) => c.bar >= a && c.bar <= b).map((c) => ({ ...c, bar: c.bar + count, pitches: c.pitches.slice() }))); }
  for (const s of p.sections) if (s.bar > b) s.bar += count;
  rebuild(p, (tempo, sig) => { tempo.splice(b + 1, 0, ...tempo.slice(a, b + 1).map((x) => ({ ...x }))); sig.splice(b + 1, 0, ...sig.slice(a, b + 1).map((x) => ({ ...x }))); return tempo.length; });
  for (const t of p.tracks) t.notes.push(...t.notes.filter((n) => n[0] >= a && n[0] <= b).map((n) => [n[0] + count, n[1], n[2], n[3], n[4]]));
}
export function setLength(p, bars) { // make the song `bars` long (adding empty bars or cutting the end)
  bars = Math.max(1, bars);
  if (bars > p.bars) insertBars(p, p.bars, bars - p.bars); else if (bars < p.bars) deleteBars(p, bars, p.bars - 1);
}
/** Copy bars a..b of the given tracks. */
export function copyBars(p, a, b, trackIds) {
  const parts = {};
  for (const t of p.tracks) if (trackIds.includes(t.id)) parts[t.id] = t.notes.filter((n) => n[0] >= a && n[0] <= b).map((n) => [n[0] - a, n[1], n[2], n[3], n[4]]);
  return { kind: "bars", bars: b - a + 1, parts };
}
/** Paste copied bars starting at bar `where`, replacing what is there. Notes take on the bars they land in.
 *  One copied track pastes onto `targetId`; several paste back onto their own tracks. */
export function pasteBars(p, clip, where, targetId) {
  const L = layout(p), last = Math.min(p.bars - 1, where + clip.bars - 1), ids = Object.keys(clip.parts);
  for (const id of ids) {
    const t = p.tracks.find((x) => x.id === (ids.length === 1 ? targetId : id)); if (!t) continue;
    t.notes = t.notes.filter((n) => n[0] < where || n[0] > last);
    for (const n of clip.parts[id]) { const bar = where + n[0]; if (bar <= last && n[1] < L.beats[bar] - 1e-6) t.notes.push([bar, n[1], n[2], n[3], n[4]]); }
  }
  return last;
}
export function clearBars(p, a, b, trackIds) { for (const t of p.tracks) if (trackIds.includes(t.id)) t.notes = t.notes.filter((n) => n[0] < a || n[0] > b); }

// ---------- chords ----------
const SHAPES = [["0,4,7", ""], ["0,3,7", "m"], ["0,7", "5"], ["0,4,7,10", "7"], ["0,4,7,11", "maj7"], ["0,3,7,10", "m7"], ["0,2,7", "sus2"], ["0,5,7", "sus4"],
  ["0,2,4,7", "add9"], ["0,2,3,7", "m(add9)"], ["0,4,7,9", "6"], ["0,3,7,9", "m6"], ["0,5,7,10", "7sus4"], ["0,2,4,7,11", "maj9"], ["0,2,3,7,10", "m9"], ["0,2,4,7,10", "9"], ["0,3,6", "dim"], ["0,4,8", "aug"], ["0,3,6,10", "m7b5"], ["0,3,6,9", "dim7"], ["0,4,7,10,2", "9"]];
/** A short name where a common chord fits (lowest note tried as root first); otherwise the note names. */
export function chordGuess(pitches) {
  if (!pitches.length) return "";
  const pcs = [...new Set(pitches.map((p) => p % 12))], bass = Math.min(...pitches) % 12;
  if (pcs.length === 1) return NOTE_NAMES[bass];
  for (const root of [bass, ...pcs.filter((p) => p !== bass)]) {
    const key = pcs.map((p) => (p - root + 12) % 12).sort((a, b) => a - b).join(","), hit = SHAPES.find((s) => s[0] === key);
    if (hit) return NOTE_NAMES[root] + hit[1] + (root === bass ? "" : "/" + NOTE_NAMES[bass]);
  }
  return pcs.sort((a, b) => ((a - bass + 12) % 12) - ((b - bass + 12) % 12)).map((p) => NOTE_NAMES[p]).join(" ");
}
/** Nearest pitch inside a set of pitch classes (ties go up). */
export function intoScale(pitch, pcs) {
  if (!pcs || pcs.has(((pitch % 12) + 12) % 12)) return pitch;
  for (let d = 1; d < 7; d++) { if (pcs.has((pitch + d) % 12)) return pitch + d; if (pcs.has((((pitch - d) % 12) + 12) % 12)) return pitch - d; }
  return pitch;
}
/** Parse "C#4", "Bb2", or a MIDI number into a pitch. Returns null when it is neither. */
export function parsePitch(x) {
  if (typeof x === "number") return x >= 0 && x <= 127 ? Math.round(x) : null;
  const m = /^\s*([A-Ga-g])([#b]?)(-?\d)\s*$/.exec(String(x)); if (!m) return null;
  const pc = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  return (parseInt(m[3], 10) + 1) * 12 + pc;
}
export const SCALE_TYPES = { "major": [0, 2, 4, 5, 7, 9, 11], "minor": [0, 2, 3, 5, 7, 8, 10], "dorian": [0, 2, 3, 5, 7, 9, 10], "mixolydian": [0, 2, 4, 5, 7, 9, 10], "lydian": [0, 2, 4, 6, 7, 9, 11],
  "phrygian": [0, 1, 3, 5, 7, 8, 10], "harmonic minor": [0, 2, 3, 5, 7, 8, 11], "major pentatonic": [0, 2, 4, 7, 9], "minor pentatonic": [0, 3, 5, 7, 10], "blues": [0, 3, 5, 6, 7, 10] };
export function makeScale(tonic, type) { const steps = SCALE_TYPES[type]; return { name: `${NOTE_NAMES[tonic]} ${type}`, tonic, type, steps: steps.map((s) => (tonic + s) % 12), pitch_classes: steps.map((s) => (tonic + s) % 12).sort((a, b) => a - b) }; }
/** The scale's notes in order from its tonic (works for detected scales, which only store the set). */
export function scaleSteps(scale) { return scale.pitch_classes.slice().sort((a, b) => ((a - scale.tonic + 12) % 12) - ((b - scale.tonic + 12) % 12)); }
export function audible(p) { const solo = p.tracks.some((t) => t.solo); return p.tracks.filter((t) => (solo ? t.solo : !t.mute)); }
export { LISTS, round };
