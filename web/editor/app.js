// Shared editor state, undo, and change notification. Views read `app` and call `emit()`.
import { layout, migrate } from "./model.js";
import { detectProgression } from "./tools.js";

export const HEAD_W = 190; // width of the left column (track headers / piano keys)

export const app = {
  project: null, L: null, dirty: false,
  sel: { track: 0, notes: new Set(), bars: null, block: null }, // bars: {a, b, all}; block: {lane, index}
  view: { ppb: 36, scrollX: 0, snap: 0.5, tool: "draw", noteLen: 1 },
  playhead: 0, loop: { on: false, a: 0, b: 0 },
  brush: null, // chord pitches picked up for drawing
  stamp: null, // a pattern picked up for stamping: {name, kind, length, notes}
  scale: -1, scaleLock: false,
  held: [], typing: false, stepRecord: false, keyBase: 48,
  clip: null, undo: [], redo: [],
};

const listeners = [];
export const on = (fn) => listeners.push(fn);
export function emit(what = "view") { for (const fn of listeners) fn(what); }

export const track = () => app.project.tracks[app.sel.track];
export const scalePcs = () => (app.scale >= 0 && app.project.scales[app.scale] ? new Set(app.project.scales[app.scale].pitch_classes) : null);

export function open(project) {
  app.project = migrate(project); app.L = layout(app.project);
  app.sel = { track: 0, notes: new Set(), bars: null, block: null };
  app.playhead = 0; app.loop = { on: false, a: 0, b: 0 }; app.brush = null; app.stamp = null; app.held = [];
  if (!app.project.progression.length) { const src = app.project.tracks.find((t) => t.kind !== "drums" && t.notes.length); if (src) app.project.progression = detectProgression(app.project, src.id); }
  app.scale = app.project.scales.length ? 0 : -1; app.undo = []; app.redo = []; app.dirty = false; app.view.scrollX = 0;
  emit("open");
}

let pending = null;
/** Call before changing the project. */
export function begin() { if (pending === null) pending = JSON.stringify(app.project); }
/** Call after changing it. Records one undo step if anything actually changed. */
export function commit() {
  app.L = layout(app.project);
  if (pending !== null) {
    if (pending !== JSON.stringify(app.project)) { app.undo.push(pending); if (app.undo.length > 100) app.undo.shift(); app.redo = []; app.dirty = true; }
    pending = null;
  }
  clampSelection(); emit("project");
}
/** Refresh during a drag, without closing the undo step. */
export function touch() { app.L = layout(app.project); emit("view"); }
export function edit(fn) { begin(); fn(app.project); commit(); }

function clampSelection() {
  const p = app.project;
  app.sel.track = Math.max(0, Math.min(app.sel.track, p.tracks.length - 1));
  const n = track().notes.length; for (const i of [...app.sel.notes]) if (i >= n) app.sel.notes.delete(i);
  if (app.sel.bars) { app.sel.bars.a = Math.min(app.sel.bars.a, p.bars - 1); app.sel.bars.b = Math.min(app.sel.bars.b, p.bars - 1); }
  if (app.sel.block && app.sel.block.index >= (app.sel.block.lane === "chords" ? p.progression : p[app.sel.block.lane]).length) app.sel.block = null;
  app.playhead = Math.max(0, Math.min(app.playhead, app.L.total));
}
function restore(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(app.project)); app.project = JSON.parse(from.pop()); app.L = layout(app.project);
  app.sel.notes = new Set(); app.sel.block = null; app.dirty = true; clampSelection(); emit("project");
}
export const undo = () => restore(app.undo, app.redo);
export const redo = () => restore(app.redo, app.undo);

export function selectTrack(i) { if (i === app.sel.track) return; app.sel.track = i; app.sel.notes = new Set(); emit("selection"); }
