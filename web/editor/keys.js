// The on-screen keys, note entry from the computer keyboard, and the held chord.
import { pitchedTrack, saveChord } from "./actions.js";
import { app, begin, commit, emit, selectTrack, track } from "./app.js";
import { hear } from "./audio.js";
import { chordGuess, noteName, place } from "./model.js";
import { btn } from "./ui.js";

const $ = (id) => document.getElementById(id);
export const TYPING = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ";": 16, "'": 17 };
const down = new Set();

/** Write the held notes at the playhead on the chosen track, and step forward. */
export function insertHeld() {
  const t = pitchedTrack(), L = app.L; if (!app.held.length || app.playhead >= L.total) return;
  if (t !== track()) selectTrack(app.project.tracks.indexOf(t));
  begin(); const first = t.notes.length; for (const pitch of app.held) t.notes.push([...place(app.playhead, L), app.view.noteLen, pitch, 0.8]);
  app.sel.notes = new Set(app.held.map((_, k) => first + k)); app.sel.bars = null; app.sel.block = null; app.playhead = Math.min(L.total, app.playhead + app.view.noteLen); commit();
}
/** A letter key went down or up while typing notes. Returns true if it was a note key. */
export function typeNote(e, isDown) {
  const k = e.key.toLowerCase(); if (!(k in TYPING)) return false; const pitch = app.keyBase + TYPING[k];
  if (isDown) { if (e.repeat) return true; if (!down.size) app.held = []; down.add(k); if (!app.held.includes(pitch)) app.held = [...app.held, pitch].sort((a, b) => a - b); hear(pitchedTrack(), [pitch]); emit("selection"); }
  else { down.delete(k); if (!down.size && app.stepRecord && app.held.length) insertHeld(); }
  return true;
}
export function renderKeys() {
  const box = $("keys"), pcs = app.scale >= 0 && app.project.scales[app.scale] ? new Set(app.project.scales[app.scale].pitch_classes) : null, held = new Set(app.held);
  const letters = Object.fromEntries(Object.entries(TYPING).map(([k, v]) => [v, k]));
  box.replaceChildren(...Array.from({ length: 25 }, (_, k) => { const pitch = app.keyBase + k, black = [1, 3, 6, 8, 10].includes(pitch % 12);
    return btn(app.typing && letters[k] ? letters[k].toUpperCase() : pitch % 12 === 0 ? noteName(pitch) : "", () => { hear(pitchedTrack(), [pitch]); app.held = held.has(pitch) ? app.held.filter((x) => x !== pitch) : [...app.held, pitch].sort((a, b) => a - b); emit("selection"); },
      { className: "key" + (black ? " black" : "") + (pcs && pcs.has(pitch % 12) ? " inscale" : "") + (held.has(pitch) ? " held" : ""), attrs: { "aria-label": noteName(pitch) } }); }));
  $("heldName").textContent = app.held.length ? `${chordGuess(app.held)}  ·  ${app.held.map(noteName).join(" ")}` : "Nothing held. Click keys, or press Q and play A W S E D F…";
  for (const id of ["heldPlay", "heldInsert", "heldBrush", "heldSave", "heldClear"]) $(id).disabled = !app.held.length;
  $("typing").setAttribute("aria-pressed", String(app.typing)); $("stepRecord").setAttribute("aria-pressed", String(app.stepRecord));
}
export function wireKeys() {
  $("heldPlay").addEventListener("click", () => hear(pitchedTrack(), app.held, 0.8));
  $("heldInsert").addEventListener("click", insertHeld);
  $("heldBrush").addEventListener("click", () => { app.brush = app.held.slice(); app.stamp = null; app.view.tool = "draw"; emit("selection"); });
  $("heldSave").addEventListener("click", () => saveChord(app.held));
  $("heldClear").addEventListener("click", () => { app.held = []; emit("selection"); });
  $("octDown").addEventListener("click", () => { app.keyBase = Math.max(24, app.keyBase - 12); emit("selection"); });
  $("octUp").addEventListener("click", () => { app.keyBase = Math.min(72, app.keyBase + 12); emit("selection"); });
  $("typing").addEventListener("click", () => { app.typing = !app.typing; emit("selection"); });
  $("stepRecord").addEventListener("click", () => { app.stepRecord = !app.stepRecord; emit("selection"); });
  document.addEventListener("keyup", (e) => { if (app.typing) typeNote(e, false); });
}
