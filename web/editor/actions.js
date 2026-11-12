// Things you can do to the selection, shared by the context bar, menus and shortcuts.
import { app, begin, commit, edit, emit, selectTrack, track } from "./app.js";
import { loadInstrument } from "./audio.js";
import { barAt, chordGuess, clearBars, copyBars, duplicateBars, pasteBars, place, prune, removeBlock, round, snapDown } from "./model.js";

export const uid = () => "t" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
export const pitchedTrack = () => (track().kind === "drums" ? app.project.tracks.find((t) => t.kind !== "drums") || track() : track());
export const scopeIds = () => (app.sel.bars && app.sel.bars.all ? app.project.tracks.map((t) => t.id) : [track().id]);
/** What a transform should act on, and words for it. */
export function scope() {
  if (app.sel.notes.size) return { scope: { indices: [...app.sel.notes] }, text: `${app.sel.notes.size} selected notes` };
  if (app.sel.bars) return { scope: { bars: { a: app.sel.bars.a, b: app.sel.bars.b } }, text: app.sel.bars.a === app.sel.bars.b ? `bar ${app.sel.bars.a + 1}` : `bars ${app.sel.bars.a + 1}–${app.sel.bars.b + 1}` };
  return { scope: null, text: "the whole track" };
}
export const barRegion = () => (app.sel.bars ? { a: app.sel.bars.a, b: app.sel.bars.b } : null);

export function copy() {
  const t = track(), L = app.L;
  if (app.sel.notes.size) { const ns = [...app.sel.notes].map((i) => t.notes[i]), a0 = Math.min(...ns.map((n) => L.start[n[0]] + n[1])); app.clip = { kind: "notes", notes: ns.map((n) => [L.start[n[0]] + n[1] - a0, n[2], n[3], n[4]]) }; }
  else if (app.sel.bars) app.clip = copyBars(app.project, app.sel.bars.a, app.sel.bars.b, scopeIds());
  emit("selection");
}
export function paste() {
  const c = app.clip; if (!c) return; const L = app.L, t = track();
  if (c.kind === "notes") { begin(); const first = t.notes.length; for (const n of c.notes) { const a = app.playhead + n[0]; if (a < L.total) t.notes.push([...place(a, L), n[1], n[2], n[3]]); }
    app.sel.notes = new Set(t.notes.slice(first).map((_, k) => first + k)); commit(); }
  else { const where = app.sel.bars ? app.sel.bars.a : barAt(L, Math.min(app.playhead, L.total - 1e-6)); begin(); const last = pasteBars(app.project, c, where, t.id); app.sel.bars = { a: where, b: last, all: Object.keys(c.parts).length > 1 }; commit(); }
}
export function removeSelection() {
  const t = track(), b = app.sel.block;
  if (app.sel.notes.size) { begin(); t.notes = t.notes.filter((_, i) => !app.sel.notes.has(i)); app.sel.notes = new Set(); commit(); }
  else if (b && b.lane === "chords") { begin(); app.project.progression.splice(b.index, 1); app.sel.block = null; commit(); }
  else if (b && b.index > 0) { begin(); removeBlock(app.project[b.lane], b.index); if (b.lane === "signature") prune(app.project); app.sel.block = null; commit(); }
  else if (app.sel.bars) edit((p) => clearBars(p, app.sel.bars.a, app.sel.bars.b, scopeIds()));
}
export function duplicate() {
  const t = track(), L = app.L;
  if (app.sel.notes.size) { begin(); const ns = [...app.sel.notes].map((i) => t.notes[i]), a0 = Math.min(...ns.map((n) => L.start[n[0]] + n[1])), a1 = Math.max(...ns.map((n) => L.start[n[0]] + n[1] + n[2])), first = t.notes.length;
    for (const n of ns) { const a = L.start[n[0]] + n[1] + (a1 - a0); if (a < L.total) t.notes.push([...place(a, L), n[2], n[3], n[4]]); }
    app.sel.notes = new Set(t.notes.slice(first).map((_, k) => first + k)); commit(); }
  else if (app.sel.bars) { const { a, b } = app.sel.bars; begin(); duplicateBars(app.project, a, b); app.sel.bars = { ...app.sel.bars, a: b + 1, b: b + 1 + (b - a) }; commit(); }
}
export function saveChord(pitches, name) {
  pitches = [...new Set(pitches)].sort((a, b) => a - b); if (!pitches.length) return;
  edit((p) => { p.chords.push({ name: name || chordGuess(pitches), pitches }); });
  app.brush = pitches; app.stamp = null; emit("rename-chord");
}
/** Keep the selected notes (or the selected bars of this track) as a reusable pattern. */
export function savePattern() {
  const t = track(), L = app.L; let ns, origin, length;
  if (app.sel.notes.size) { ns = [...app.sel.notes].map((i) => t.notes[i]); origin = snapDown(Math.min(...ns.map((n) => L.start[n[0]] + n[1])), 1); length = Math.max(1, Math.ceil(Math.max(...ns.map((n) => L.start[n[0]] + n[1] + n[2])) - origin - 1e-6)); }
  else if (app.sel.bars) { const { a, b } = app.sel.bars; ns = t.notes.filter((n) => n[0] >= a && n[0] <= b); origin = L.start[a]; length = L.start[b + 1] - origin; }
  if (!ns || !ns.length) return false;
  edit((p) => { p.patterns.push({ name: `${t.name} pattern ${p.patterns.length + 1}`, kind: t.kind, length: round(length), notes: ns.map((n) => [round(L.start[n[0]] + n[1] - origin), n[2], n[3], n[4]]).sort((x, y) => x[0] - y[0]) }); });
  emit("rename-pattern"); return true;
}
export function addTrack(drums, props = {}) {
  edit((p) => { p.tracks.push({ id: uid(), name: drums ? "Drums" : "Track " + (p.tracks.length + 1), kind: drums ? "drums" : "pitched", instrument: drums ? "kit" : "piano", volume: 0.8, pan: 0, reverb: drums ? 0.08 : 0.15, mute: false, solo: false, notes: [], ...props }); });
  const t = app.project.tracks[app.project.tracks.length - 1]; loadInstrument(t.instrument); selectTrack(app.project.tracks.length - 1); return t;
}
export function duplicateTrack(i) { edit((p) => { const t = p.tracks[i]; p.tracks.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(t)), id: uid(), name: t.name + " copy" }); }); selectTrack(i + 1); }
export function removeTrack(i) { if (app.project.tracks.length > 1) edit((p) => { p.tracks.splice(i, 1); }); }
