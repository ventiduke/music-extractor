// Wires the page together: toolbar, shortcuts, redraw loop, loading and saving.
import { HEAD_W, app, begin, commit, edit, emit, on, open, redo, selectTrack, track, undo } from "./app.js";
import * as arrange from "./arrange.js";
import { ensure, hear, transport } from "./audio.js";
import { toMidi } from "./midi.js";
import { SNAPS, barAt, blank, place, round } from "./model.js";
import * as panels from "./panels.js";
import * as roll from "./roll.js";
import * as store from "./store.js";

const $ = (id) => document.getElementById(id);
let songs = [], needsDraw = true, saveTimer = null;
const status = (text, bad) => { $("status").textContent = text; $("status").classList.toggle("bad", !!bad); };

// ---------- view: scroll and zoom ----------
function syncScroll() { $("hspace").style.width = (app.L.total * app.view.ppb + 400) + "px"; if (Math.abs($("hscroll").scrollLeft - app.view.scrollX) > 1) $("hscroll").scrollLeft = app.view.scrollX; }
function zoom(factor, atX = 200) {
  const beat = (atX + app.view.scrollX) / app.view.ppb; app.view.ppb = Math.max(6, Math.min(240, app.view.ppb * factor));
  app.view.scrollX = Math.max(0, beat * app.view.ppb - atX); syncScroll(); emit("view");
}
function wheel(e) {
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - e.currentTarget.getBoundingClientRect().left); }
  else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { e.preventDefault(); $("hscroll").scrollLeft += e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX; }
}
function follow() { // keep the playhead on screen while playing
  if (!transport.playing) return; const x = transport.beat() * app.view.ppb - app.view.scrollX, w = $("arr").clientWidth;
  if (x > w - 40 || x < 0) { app.view.scrollX = Math.max(0, transport.beat() * app.view.ppb - 80); syncScroll(); }
}
function frame() { requestAnimationFrame(frame); if (!app.project) return; if (transport.playing) { follow(); needsDraw = true; }
  if (!needsDraw) return; needsDraw = false; arrange.draw(); roll.draw();
  const L = app.L, b = Math.min(transport.beat(), L.total - 1e-6), bar = barAt(L, Math.max(0, b)); $("position").textContent = `${bar + 1} . ${(Math.floor((b - L.start[bar]) * 100) / 100 + 1).toFixed(2)}`; }

// ---------- rendering on change ----------
function renderToolbar() {
  $("play").textContent = transport.playing ? "■ Stop" : "▶ Play"; $("loop").setAttribute("aria-pressed", String(app.loop.on)); $("metro").setAttribute("aria-pressed", String(transport.metronome));
  $("toolDraw").setAttribute("aria-pressed", String(app.view.tool === "draw")); $("toolSelect").setAttribute("aria-pressed", String(app.view.tool === "select"));
  $("undo").disabled = !app.undo.length; $("redo").disabled = !app.redo.length; $("snap").value = String(app.view.snap); $("noteLen").value = String(round(app.view.noteLen));
  if ($("noteLen").value !== String(round(app.view.noteLen))) { $("noteLen").add(new Option(`${round(app.view.noteLen)} beats`, String(round(app.view.noteLen)))); $("noteLen").value = String(round(app.view.noteLen)); }
  $("title").value = app.project.title; document.title = app.project.title + " · Song Workbench";
}
on((what) => {
  needsDraw = true; if (!app.project) return;
  if (what === "open" || what === "project") { syncScroll(); panels.renderHeaders(); panels.renderChords(); panels.renderScales(); }
  if (what === "open") { $("arrScroll").scrollTop = 0; roll.centre($("rollScroll")); }
  if (what === "rename-chord") panels.renderChords(true);
  if (what !== "view") { if (what === "selection") { panels.renderHeaders(); panels.renderChords(); panels.renderScales(); } panels.renderContext(what === "focus-block"); panels.renderKeys(); renderToolbar(); }
  if (what === "project" && app.dirty) { status("Unsaved"); clearTimeout(saveTimer); saveTimer = setTimeout(save, 800); }
});
let lastTrack = -1;
on(() => { if (app.project && app.sel.track !== lastTrack) { lastTrack = app.sel.track; roll.centre($("rollScroll")); } });
function save() { if (!app.project || !app.dirty) return; if (store.saveSong(app.project)) { app.dirty = false; status("Saved in this browser " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })); } else status("Could not save in this browser. Use Export to keep your work.", true); }

// ---------- songs ----------
async function refreshSongs(selectId) {
  songs = await store.listSongs(); const sel = $("song"); sel.replaceChildren(...songs.map((s) => new Option(s.title + (s.bundled && s.edited ? " (edited)" : ""), s.id)));
  if (selectId) sel.value = selectId;
}
async function openSong(id, original = false) {
  save(); transport.stop(); const entry = songs.find((s) => s.id === id); if (!entry) return;
  try { open(entry.bundled ? await store.loadSong(entry, original) : await store.loadSong({ ...entry, file: "" })); lastTrack = -1; status(entry.edited && !original ? "Opened your edited copy" : "Opened"); $("revert").disabled = !(entry.bundled && entry.edited); }
  catch (e) { status("Could not open that song.", true); }
}
function adopt(project) { open(project); app.dirty = true; save(); refreshSongs(app.project.id); lastTrack = -1; }

// ---------- shortcuts ----------
const down = new Set();
function typeNote(e, isDown) {
  const k = e.key.toLowerCase(); if (!(k in panels.TYPING)) return false; const pitch = app.keyBase + panels.TYPING[k];
  if (isDown) { if (e.repeat) return true; if (!down.size) app.held = []; down.add(k); if (!app.held.includes(pitch)) app.held = [...app.held, pitch].sort((a, b) => a - b);
    hear(track().kind === "drums" ? app.project.tracks.find((t) => t.kind !== "drums") || track() : track(), [pitch]); emit("selection"); }
  else { down.delete(k); if (!down.size && app.stepRecord && app.held.length) panels.insertHeld(); }
  return true;
}
function nudge(dBeat, dPitch) {
  const t = track(), L = app.L; if (!app.sel.notes.size) return false; begin();
  for (const i of app.sel.notes) { const n = t.notes[i]; if (dBeat) { const [bar, p0] = place(Math.max(0, Math.min(L.start[n[0]] + n[1] + dBeat, L.total - 1e-3)), L); n[0] = bar; n[1] = p0; } if (dPitch && t.kind !== "drums") n[3] = Math.max(roll.BOTTOM, Math.min(roll.TOP, n[3] + dPitch)); }
  if (dPitch) hear(t, [...app.sel.notes].slice(0, 6).map((i) => t.notes[i][3]), 0.25); commit(); return true;
}
document.addEventListener("keyup", (e) => { if (app.typing) typeNote(e, false); });
document.addEventListener("keydown", (e) => {
  if (!app.project || e.target.matches("input[type=text], input[type=number], select, textarea")) { if (e.key === "Enter" || e.key === "Escape") e.target.blur?.(); return; }
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase(), done = () => e.preventDefault();
  if (mod) { if (k === "z") { e.shiftKey ? redo() : undo(); done(); } else if (k === "y") { redo(); done(); } else if (k === "c") { panels.copy(); done(); } else if (k === "v") { panels.paste(); done(); }
    else if (k === "d") { panels.duplicate(); done(); } else if (k === "a") { app.sel.notes = new Set(track().notes.map((_, i) => i)); app.sel.bars = null; app.sel.block = null; emit("selection"); done(); } else if (k === "s") { app.dirty = true; save(); done(); } return; }
  if (e.code === "Space") { ensure(); transport.toggle(); return done(); }
  if (e.key === "Enter") { panels.insertHeld(); return done(); }
  if (e.key === "Delete" || e.key === "Backspace") { panels.removeSelection(); return done(); }
  if (e.key === "Escape") { app.brush = null; app.sel.notes = new Set(); app.sel.bars = null; app.sel.block = null; emit("selection"); return; }
  if (e.key.startsWith("Arrow")) { const step = app.view.snap, did = e.key === "ArrowLeft" ? nudge(-step, 0) : e.key === "ArrowRight" ? nudge(step, 0) : e.key === "ArrowUp" ? nudge(0, e.shiftKey ? 12 : 1) : nudge(0, e.shiftKey ? -12 : -1);
    if (!did && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { app.playhead = Math.max(0, Math.min(app.L.total, app.playhead + (e.key === "ArrowLeft" ? -step : step))); emit("selection"); } return done(); }
  if (e.key === "Home") { transport.stop(); app.playhead = 0; app.view.scrollX = 0; syncScroll(); emit("selection"); return done(); }
  if (k === "q") { app.typing = !app.typing; emit("selection"); return; }
  if (app.typing) { if (k === "z") { app.keyBase = Math.max(24, app.keyBase - 12); emit("selection"); } else if (k === "x") { app.keyBase = Math.min(72, app.keyBase + 12); emit("selection"); } else typeNote(e, true); return done(); }
  if (k === "b" || k === "d") { app.view.tool = "draw"; emit("selection"); } else if (k === "v") { app.view.tool = "select"; emit("selection"); }
  else if (k === "m") edit(() => { track().mute = !track().mute; }); else if (k === "s") edit(() => { track().solo = !track().solo; });
  else if (k === "l") { app.loop.on = !app.loop.on; emit("selection"); } else if (k === "r") { app.stepRecord = !app.stepRecord; emit("selection"); }
  else if (/^[1-9]$/.test(k) && +k <= app.project.tracks.length) selectTrack(+k - 1);
});

// ---------- boot ----------
function wire() {
  document.documentElement.style.setProperty("--head-w", HEAD_W + "px");
  arrange.mount($("arr")); roll.mount($("roll"), $("rollKeys"), $("rollScroll")); panels.wireKeys();
  for (const c of [$("arr"), $("roll")]) c.addEventListener("wheel", wheel, { passive: false });
  $("hscroll").addEventListener("scroll", () => { app.view.scrollX = $("hscroll").scrollLeft; emit("view"); });
  new ResizeObserver(() => emit("view")).observe($("arr")); window.addEventListener("resize", () => emit("view"));
  $("play").addEventListener("click", () => { ensure(); transport.toggle(); });
  $("rewind").addEventListener("click", () => { transport.stop(); app.playhead = app.loop.on ? app.loop.a : 0; app.view.scrollX = Math.max(0, app.playhead * app.view.ppb - 80); syncScroll(); emit("selection"); });
  $("loop").addEventListener("click", () => { if (!(app.loop.b > app.loop.a) && app.sel.bars) app.loop = { on: false, a: app.L.start[app.sel.bars.a], b: app.L.start[app.sel.bars.b + 1] }; app.loop.on = !app.loop.on && app.loop.b > app.loop.a; emit("selection"); if (!(app.loop.b > app.loop.a)) status("Drag across the bar numbers to choose what to loop."); });
  $("metro").addEventListener("click", () => { transport.metronome = !transport.metronome; emit("project"); });
  $("toolDraw").addEventListener("click", () => { app.view.tool = "draw"; emit("selection"); }); $("toolSelect").addEventListener("click", () => { app.view.tool = "select"; emit("selection"); });
  $("undo").addEventListener("click", undo); $("redo").addEventListener("click", redo);
  $("zoomIn").addEventListener("click", () => zoom(1.3)); $("zoomOut").addEventListener("click", () => zoom(1 / 1.3));
  for (const [v, text] of SNAPS) $("snap").add(new Option(text, String(v)));
  for (const [v, text] of [[4, "4 beats"], [2, "2 beats"], [1, "1 beat"], [0.5, "1/2"], [round(1 / 3), "1/3"], [0.25, "1/4"], [round(1 / 6), "1/6"], [0.125, "1/8"]]) $("noteLen").add(new Option(text, String(v)));
  $("snap").addEventListener("change", (e) => { app.view.snap = +e.target.value; emit("selection"); }); $("noteLen").addEventListener("change", (e) => { app.view.noteLen = +e.target.value; emit("selection"); });
  $("addTrack").addEventListener("click", () => panels.addTrack(false)); $("addDrums").addEventListener("click", () => panels.addTrack(true));
  $("song").addEventListener("change", (e) => openSong(e.target.value));
  $("title").addEventListener("change", (e) => { edit((p) => { p.title = e.target.value.trim() || "Untitled"; }); save(); refreshSongs(app.project.id); });
  $("newSong").addEventListener("click", () => adopt(blank()));
  $("revert").addEventListener("click", async () => { const id = app.project.id; store.forgetSong(id); await refreshSongs(id); openSong(id, true); });
  $("exportJson").addEventListener("click", () => store.download(app.project.title.replace(/[^\w-]+/g, "_") + ".project.json", JSON.stringify(app.project), "application/json"));
  $("exportMidi").addEventListener("click", () => store.download(app.project.title.replace(/[^\w-]+/g, "_") + ".mid", toMidi(app.project), "audio/midi"));
  $("importJson").addEventListener("change", async (e) => { const file = e.target.files[0]; e.target.value = ""; if (!file) return;
    try { const p = JSON.parse(await file.text()); if (!p.tracks) throw new Error("not a song"); p.id = p.id || "song-" + Date.now().toString(36); adopt(p); status("Imported " + file.name); } catch (err) { status("That file is not a song project.", true); } });
  for (const tab of document.querySelectorAll("#tabs button")) tab.addEventListener("click", () => { for (const b of document.querySelectorAll("#tabs button")) { const active = b === tab; b.setAttribute("aria-pressed", String(active)); $("tab-" + b.dataset.tab).hidden = !active; } });
  window.addEventListener("pagehide", save);
}
async function boot() {
  wire(); requestAnimationFrame(frame); await refreshSongs();
  if (window.__song) { adopt(window.__song); return; }
  if (songs.length) await openSong(songs[0].id); else { adopt(blank("My first song")); status("No bundled songs found. Started an empty one."); }
}
boot();
