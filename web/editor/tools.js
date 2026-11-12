// Creation tools: pure functions that write or reshape notes. No DOM, no audio.
//  - the chord lane (progression): detect it from a track, look chords up by position
//  - generators that follow the chord lane: bass, pad, arpeggio, strum, drums
//  - transforms on existing notes: quantize, humanize, legato, transpose, harmonize, loudness, double
// Bars are 0-based and inclusive here. Every function changes the project in place.
import { NOTE_NAMES, absOf, chordGuess, layout, place, round, scaleSteps } from "./model.js";

export function rng(seed = 1) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const uniq = (xs) => [...new Set(xs)];
const region = (p, r) => ({ a: Math.max(0, r?.a ?? 0), b: Math.min(p.bars - 1, r?.b ?? p.bars - 1) });

// ---------- the chord lane ----------
/** Read the harmony off a track: one block per stretch where the same chord sounds. */
export function detectProgression(p, trackId) {
  const L = layout(p), t = p.tracks.find((x) => x.id === trackId) || p.tracks.find((x) => x.kind !== "drums"); if (!t) return [];
  const notes = t.notes.filter((n) => n[0] < L.n).map((n) => [absOf(n, L), n[2], n[3], n[4]]).sort((x, y) => x[0] - y[0]);
  const blocks = []; let from = 0;
  for (let bar = 0; bar < L.n; bar++) {
    const beats = L.beats[bar], size = beats <= 3 ? beats : 2;
    for (let pos = 0; pos < beats - 1e-6; pos += size) {
      const start = L.start[bar] + pos, len = Math.min(size, beats - pos), end = start + len, weight = new Map();
      while (from < notes.length && notes[from][0] + notes[from][1] <= start - 16) from++; // nothing this old still sounds
      for (let i = from; i < notes.length && notes[i][0] < end; i++) { const [a, l, pitch, vel] = notes[i], over = Math.min(a + l, end) - Math.max(a, start); if (over > 0) weight.set(pitch, (weight.get(pitch) || 0) + over * vel); }
      if (!weight.size) continue;
      const top = Math.max(...weight.values()), kept = [...weight].filter(([, w]) => w >= 0.25 * top).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([pitch]) => pitch).sort((x, y) => x - y);
      const name = chordGuess(kept), prev = blocks[blocks.length - 1];
      if (prev && prev.name === name && Math.abs(L.start[prev.bar] + prev.pos + prev.len - start) < 1e-6) prev.len = round(prev.len + len);
      else blocks.push({ bar, pos: round(pos), len: round(len), name, pitches: kept });
    }
  }
  return blocks;
}
/** The chord lane cut at bar lines and limited to bars a..b: [{start, len, bar, name, pitches}] in absolute beats. */
export function chordSlices(p, L, a, b) {
  const out = [];
  for (const c of p.progression || []) {
    if (c.bar >= L.n) continue; let start = L.start[c.bar] + c.pos; const end = Math.min(start + c.len, L.start[b + 1]);
    while (start < end - 1e-6) { let bar = c.bar; while (bar < L.n - 1 && L.start[bar + 1] <= start + 1e-6) bar++;
      const stop = Math.min(end, L.start[bar + 1]); if (bar >= a && bar <= b) out.push({ start, len: round(stop - start), bar, name: c.name, pitches: c.pitches }); start = stop; }
  }
  return out.sort((x, y) => x.start - y.start);
}
export function chordAt(p, L, beat) { for (const c of p.progression || []) { if (c.bar >= L.n) continue; const s = L.start[c.bar] + c.pos; if (beat >= s - 1e-6 && beat < s + c.len - 1e-6) return c; } return null; }
/** Put a chord on the lane from absolute beat `start` for `len` beats, replacing what was there. */
export function setChord(p, start, len, chord) {
  const L = layout(p), end = Math.min(start + len, L.total), kept = [];
  for (const c of p.progression || []) {
    if (c.bar >= L.n) continue; const s = L.start[c.bar] + c.pos, e = s + c.len;
    if (e <= start + 1e-6 || s >= end - 1e-6) { kept.push(c); continue; }
    if (s < start - 1e-6) kept.push({ ...c, len: round(start - s) });
    if (e > end + 1e-6) { const [bar, pos] = place(end, L); kept.push({ ...c, bar, pos, len: round(e - end) }); }
  }
  if (chord) { const [bar, pos] = place(start, L); kept.push({ bar, pos, len: round(end - start), name: chord.name || chordGuess(chord.pitches), pitches: chord.pitches.slice().sort((x, y) => x - y) }); }
  p.progression = kept.sort((x, y) => x.bar - y.bar || x.pos - y.pos);
}

/** Replace a track's notes in bars a..b with notes given as [absolute beat, length, pitch, velocity]. */
function write(p, L, track, a, b, notes) {
  track.notes = track.notes.filter((n) => n[0] < a || n[0] > b);
  const end = L.start[b + 1];
  for (const [at, len, pitch, vel] of notes) { if (at < L.start[a] - 1e-6 || at >= end - 1e-6 || pitch < 0 || pitch > 127) continue;
    track.notes.push([...place(at, L), round(Math.max(0.05, Math.min(len, end - at))), Math.round(pitch), round(Math.max(0.05, Math.min(1, vel)))]); }
  return track.notes.length;
}
const bassOf = (pitches) => { const pc = Math.min(...pitches) % 12; return 28 + ((pc - 4 + 12) % 12); }; // E1 .. D#2
function tones(pitches) { // root, third-ish, fifth-ish as intervals above the bass
  const root = Math.min(...pitches) % 12, ivs = uniq(pitches.map((x) => (x - root + 120) % 12)).sort((x, y) => x - y);
  return { third: ivs.find((i) => i === 3 || i === 4) ?? ivs.find((i) => i === 2 || i === 5) ?? 7, fifth: ivs.find((i) => i === 7) ?? ivs.find((i) => i === 6 || i === 8) ?? 7, sixth: ivs.find((i) => i === 9 || i === 10 || i === 11) ?? 9 };
}

// ---------- generators ----------
export const BASS_STYLES = { held: "Held roots", pulse: "On every beat", eighths: "Driving", "root-fifth": "Root and fifth", octaves: "Octaves", walking: "Walking" };
export function bassLine(p, track, r, style = "pulse") {
  const L = layout(p), { a, b } = region(p, r), sl = chordSlices(p, L, a, b), out = [];
  sl.forEach((c, i) => {
    const root = bassOf(c.pitches), { third, fifth, sixth } = tones(c.pitches), div = L.division[c.bar], next = sl[i + 1], nBeats = Math.max(1, Math.round(c.len));
    if (style === "held") out.push([c.start, c.len, root, 0.8]);
    else if (style === "pulse") for (let k = 0; k < c.len - 1e-6; k++) out.push([c.start + k, Math.min(0.92, c.len - k), root, k === 0 ? 0.85 : 0.7]);
    else if (style === "eighths") for (let k = 0; k * (1 / div) < c.len - 1e-6; k++) out.push([c.start + k / div, 0.9 / div, root, k % div === 0 ? 0.85 : 0.62]);
    else if (style === "octaves") for (let k = 0; k * (1 / div) < c.len - 1e-6; k++) out.push([c.start + k / div, 0.85 / div, root + (k % 2 ? 12 : 0), k % 2 ? 0.62 : 0.85]);
    else if (style === "root-fifth") for (let k = 0; k < c.len - 1e-6; k++) out.push([c.start + k, Math.min(0.92, c.len - k), root + (k % 2 ? fifth - (root + fifth > 43 ? 12 : 0) : 0), k % 2 ? 0.7 : 0.85]);
    else for (let k = 0; k < nBeats; k++) { // walking: root, chord tones, then lean into the next root
      let pitch = root + [0, third, fifth, sixth][k % 4];
      if (k === nBeats - 1 && k > 0 && next && bassOf(next.pitches) !== root) { const target = bassOf(next.pitches); pitch = target + (target > root ? -1 : 1); }
      out.push([c.start + k, Math.min(0.95, c.len - k), pitch, k === 0 ? 0.85 : 0.72]);
    }
  });
  return write(p, L, track, a, b, out);
}
export function padPart(p, track, r) {
  const L = layout(p), { a, b } = region(p, r), out = []; let centre = 62, last = null;
  for (const c of chordSlices(p, L, a, b)) {
    const pcs = uniq(c.pitches.map((x) => x % 12)).slice(0, 5), key = pcs.slice().sort().join(",");
    if (last && last.key === key && Math.abs(last.end - c.start) < 1e-6) { for (const n of last.notes) n[1] = round(n[1] + c.len); last.end = c.start + c.len; continue; }
    const voiced = pcs.map((pc) => { let pitch = pc + 12 * Math.round((centre - pc) / 12); if (pitch < 50) pitch += 12; if (pitch > 76) pitch -= 12; return pitch; });
    centre = voiced.reduce((s, x) => s + x, 0) / voiced.length;
    const notes = voiced.map((pitch) => [c.start, c.len, pitch, 0.5]); out.push(...notes); last = { key, end: c.start + c.len, notes };
  }
  return write(p, L, track, a, b, out);
}
export const ARP_SHAPES = { up: "Up", down: "Down", updown: "Up and down", random: "Random" };
export function arpeggio(p, track, r, { shape = "up", rate = 0.5, octaves = 2, seed = 1 } = {}) {
  const L = layout(p), { a, b } = region(p, r), out = [], rand = rng(seed);
  for (const c of chordSlices(p, L, a, b)) {
    const root = Math.min(...c.pitches) % 12, base = 48 + root, ivs = uniq(c.pitches.map((x) => (x - root + 120) % 12)).sort((x, y) => x - y);
    let ladder = []; for (let o = 0; o < octaves; o++) for (const i of ivs) ladder.push(base + i + 12 * o); if (octaves > 0) ladder.push(base + 12 * octaves);
    if (shape === "down") ladder.reverse(); else if (shape === "updown") ladder = ladder.concat(ladder.slice(1, -1).reverse());
    for (let k = 0; k * rate < c.len - 1e-6; k++) { const at = c.start + k * rate, onBeat = Math.abs(k * rate - Math.round(k * rate)) < 1e-6;
      out.push([at, Math.min(rate * 0.95, c.len - k * rate), shape === "random" ? ladder[Math.floor(rand() * ladder.length)] : ladder[k % ladder.length], onBeat ? 0.78 : 0.58]); }
  }
  return write(p, L, track, a, b, out);
}
export const STRUM_STYLES = { beats: "Down on every beat", eighths: "Down and up", pop: "Pop (down, down-up, up-down-up)", ballad: "Let it ring" };
export function strum(p, track, r, style = "eighths") {
  const L = layout(p), { a, b } = region(p, r), out = [];
  for (const c of chordSlices(p, L, a, b)) {
    const div = L.division[c.bar], spb = L.bpm[c.bar] / 60, hits = []; // [offset in beats, "D" | "U", velocity]
    if (style === "ballad") { hits.push([0, "D", 0.8]); if (c.len >= 3.5) hits.push([2, "D", 0.6]); }
    else if (style === "beats") for (let k = 0; k < c.len - 1e-6; k++) hits.push([k, "D", k === 0 ? 0.85 : 0.7]);
    else if (style === "pop" && div === 2 && L.beats[c.bar] === 4) { const inBar = c.start - L.start[c.bar]; for (const [o, d, v] of [[0, "D", 0.85], [1, "D", 0.72], [1.5, "U", 0.55], [2.5, "U", 0.6], [3, "D", 0.72], [3.5, "U", 0.55]]) if (o >= inBar - 1e-6 && o < inBar + c.len - 1e-6) hits.push([o - inBar, d, v]); }
    else for (let k = 0; k / div < c.len - 1e-6; k++) hits.push([k / div, div === 2 ? (k % 2 ? "U" : "D") : "D", k % div === 0 ? 0.82 : 0.55]);
    hits.forEach(([off, dir, vel], i) => {
      const until = i + 1 < hits.length ? hits[i + 1][0] : c.len, strings = dir === "D" ? c.pitches : c.pitches.slice(-4).reverse(), gap = 0.012 * spb; // 12 ms a string
      strings.forEach((pitch, s) => out.push([c.start + off + s * gap, Math.max(0.1, (until - off) * 0.96 - s * gap), pitch, vel - s * 0.02]));
    });
  }
  return write(p, L, track, a, b, out);
}
const KICK = 36, SNARE = 38, RIM = 37, HAT = 42, OPEN = 46, RIDE = 51, CRASH = 49, SHAKER = 70, TOMS = [48, 45, 41];
const BACKBEAT = { 2: [[0], [1]], 3: [[0], [2]], 4: [[0, 2], [1, 3]], 5: [[0, 3], [2, 4]], 6: [[0, 3], [2, 5]], 7: [[0, 4], [2, 6]] };
export const DRUM_STYLES = { rock: "Rock", four: "Four on the floor", half: "Half time", shuffle: "Shuffle", ballad: "Ballad", soft: "Soft shaker" };
/** One bar of a drum style as [position, pitch, velocity], shaped to the bar's beats and division. */
export function drumBar(style, beats, div) {
  const [kicks, snares] = BACKBEAT[beats] || [[0], [Math.floor(beats / 2)]], hits = [], step = 1 / div;
  const every = (pitch, strong, weak) => { for (let k = 0; k * step < beats - 1e-6; k++) hits.push([round(k * step), pitch, k % div === 0 ? strong : weak]); };
  if (style === "four") { for (let k = 0; k < beats; k++) { hits.push([k, KICK, 0.9]); if (div === 2) hits.push([k + 0.5, OPEN, 0.5]); else hits.push([k, HAT, 0.5], [round(k + 2 / 3), HAT, 0.4]); } for (const s of snares) hits.push([s, SNARE, 0.8]); }
  else if (style === "half") { every(HAT, 0.6, 0.38); hits.push([0, KICK, 0.9]); if (beats >= 4 && div === 2) hits.push([beats - 1.5, KICK, 0.65]); hits.push([Math.floor(beats / 2), SNARE, 0.88]); }
  else if (style === "shuffle") { for (let k = 0; k < beats; k++) hits.push([k, RIDE, 0.62], [round(k + (div === 3 ? 2 / 3 : 0.5)), RIDE, 0.42]); for (const k of kicks) hits.push([k, KICK, 0.88]); for (const s of snares) hits.push([s, SNARE, 0.78]); }
  else if (style === "ballad") { for (let k = 0; k < beats; k++) hits.push([k, HAT, 0.5]); for (const k of kicks) hits.push([k, KICK, 0.82]); for (const s of snares) hits.push([s, RIM, 0.7]); }
  else if (style === "soft") { every(SHAKER, 0.55, 0.36); hits.push([0, KICK, 0.75]); for (const s of snares) hits.push([s, RIM, 0.55]); }
  else { every(HAT, 0.62, 0.4); for (const k of kicks) hits.push([k, KICK, 0.9]); if (div === 2 && beats >= 4) hits.push([kicks[kicks.length - 1] + 0.5, KICK, 0.6]); for (const s of snares) hits.push([s, SNARE, 0.85]); }
  return hits;
}
export function drumPart(p, track, r, { style = "rock", fillEvery = 4, crash = true } = {}) {
  const L = layout(p), { a, b } = region(p, r), out = [];
  for (let bar = a; bar <= b; bar++) {
    const beats = L.beats[bar], div = L.division[bar], n = bar - a, fill = fillEvery > 0 && (n + 1) % fillEvery === 0 && bar < b;
    for (const [pos, pitch, vel] of drumBar(style, beats, div)) { if (fill && pos >= beats - 1 - 1e-6) continue; out.push([L.start[bar] + pos, 0.2, pitch, vel]); }
    if (fill) for (let k = 0; k < div + (div === 2 ? 2 : 0); k++) { const stepLen = 1 / (div === 2 ? 4 : 3); out.push([L.start[bar] + beats - 1 + k * stepLen, 0.2, TOMS[Math.min(2, Math.floor(k * 3 / (div === 2 ? 4 : 3)))], 0.6 + 0.08 * k]); }
    if (crash && n > 0 && fillEvery > 0 && n % fillEvery === 0) out.push([L.start[bar], 0.2, CRASH, 0.8]);
  }
  return write(p, L, track, a, b, out);
}

// ---------- transforms ----------
/** The notes a transform applies to: explicit indices, else bars a..b, else the whole track. */
function chosen(track, scope) {
  if (scope?.indices?.length) return scope.indices.map((i) => track.notes[i]).filter(Boolean);
  if (scope?.bars) return track.notes.filter((n) => n[0] >= scope.bars.a && n[0] <= scope.bars.b);
  return track.notes;
}
function move(n, at, L) { const [bar, pos] = place(Math.max(0, Math.min(at, L.total - 1e-3)), L); n[0] = bar; n[1] = pos; }
export function quantize(p, track, scope, step = 0.5, strength = 1) { const L = layout(p); for (const n of chosen(track, scope)) { const at = absOf(n, L), to = Math.round(at / step + 1e-9) * step; move(n, at + (to - at) * strength, L); } }
export function humanize(p, track, scope, amount = 0.5, seed = 1) {
  const L = layout(p), rand = rng(seed), byStart = new Map(); // notes struck together move together
  for (const n of chosen(track, scope)) { const key = round(absOf(n, L)); if (!byStart.has(key)) byStart.set(key, (rand() - 0.5) * 0.06 * amount);
    move(n, absOf(n, L) + (track.kind === "drums" ? (rand() - 0.5) * 0.03 * amount : byStart.get(key)), L); n[4] = round(Math.max(0.05, Math.min(1, n[4] + (rand() - 0.5) * 0.24 * amount))); }
}
export function legato(p, track, scope) {
  const L = layout(p), ns = chosen(track, scope).slice().sort((x, y) => absOf(x, L) - absOf(y, L)), starts = uniq(ns.map((n) => round(absOf(n, L))));
  for (const n of ns) { const at = round(absOf(n, L)), next = starts.find((s) => s > at + 1e-6); if (next !== undefined && next - at <= 8) n[2] = round(next - at); }
}
export function transpose(p, track, scope, semitones) { if (track.kind === "drums") return; for (const n of chosen(track, scope)) n[3] = Math.max(0, Math.min(127, n[3] + semitones)); }
export function loudness(p, track, scope, { scale = 1, from = null, to = null } = {}) {
  const L = layout(p), ns = chosen(track, scope); if (!ns.length) return; const a0 = Math.min(...ns.map((n) => absOf(n, L))), a1 = Math.max(...ns.map((n) => absOf(n, L)));
  for (const n of ns) { const v = from === null ? n[4] * scale : from + (to - from) * (a1 > a0 ? (absOf(n, L) - a0) / (a1 - a0) : 0); n[4] = round(Math.max(0.05, Math.min(1, v))); }
}
/** Add a parallel line a number of scale steps above (or below) each note: 2 is a third up, -2 a third down, 5 a sixth up. */
export function harmonize(p, track, scope, scale, steps = 2) {
  if (track.kind === "drums" || !scale) return 0; const order = scaleSteps(scale), added = [];
  for (const note of chosen(track, scope)) {
    const pc = note[3] % 12; let deg = order.indexOf(pc); if (deg < 0) deg = order.reduce((best, x, i) => (Math.min((x - pc + 12) % 12, (pc - x + 12) % 12) < Math.min((order[best] - pc + 12) % 12, (pc - order[best] + 12) % 12) ? i : best), 0);
    const n2 = order.length, tpc = order[(((deg + steps) % n2) + n2) % n2], basePc = order[deg], whole = Math.floor(Math.abs(steps) / n2) * 12;
    let up = steps > 0 ? ((tpc - basePc + 12) % 12) + whole : -((basePc - tpc + 12) % 12) - whole;
    if (steps > 0 && up === 0) up = 12; if (steps < 0 && up === 0) up = -12;
    const pitch = note[3] + up; if (pitch >= 0 && pitch <= 127) added.push([note[0], note[1], note[2], pitch, round(note[4] * 0.85)]);
  }
  track.notes.push(...added); return added.length;
}
export function double(p, track, scope, semitones = 12) { if (track.kind === "drums") return; track.notes.push(...chosen(track, scope).filter((n) => n[3] + semitones >= 0 && n[3] + semitones <= 127).map((n) => [n[0], n[1], n[2], n[3] + semitones, round(n[4] * 0.8)])); }

// ---------- chords from a scale ----------
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];
/** The chords built on each step of a seven-note scale: [{name, numeral, pitches}]. */
export function diatonicChords(scale, sevenths = false) {
  const order = scaleSteps(scale); if (order.length !== 7) return [];
  return order.map((rootPc, i) => {
    const ivs = [0, 2, 4, ...(sevenths ? [6] : [])].map((k) => (order[(i + k) % 7] - rootPc + 12) % 12), root = 48 + rootPc - (rootPc > 7 ? 12 : 0), pitches = ivs.map((iv) => root + iv);
    const minor = ivs[1] === 3, dim = ivs[2] === 6;
    return { name: chordGuess(pitches), numeral: (minor ? ROMAN[i].toLowerCase() : ROMAN[i]) + (dim ? "°" : "") + (sevenths ? "7" : ""), pitches };
  });
}
export { NOTE_NAMES };
