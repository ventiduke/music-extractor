// Wires the page together: toolbar, song menu, shortcuts, redraw loop, loading, saving and export.
import { addTrack, copy, duplicate, paste, removeSelection } from "./actions.js";
import { HEAD_W, app, begin, commit, edit, emit, on, open, redo, selectTrack, track, undo } from "./app.js";
import * as arrange from "./arrange.js";
import { ensure, hear, level, loadLibrary, preload, renderSong, toWav, transport } from "./audio.js";
import { barsMenuItems, renderContext } from "./context.js";
import { insertHeld, renderKeys, typeNote, wireKeys } from "./keys.js";
import { renderChords, renderPatterns, renderScales, wireLibrary } from "./library.js";
import { toMidi } from "./midi.js";
import { SNAPS, at, barAt, blank, place, round, sigText, timeAt } from "./model.js";
import * as roll from "./roll.js";
import * as store from "./store.js";
import { toolsMenu } from "./toolbox.js";
import { drawMeters, renderHeaders } from "./tracks.js";
import { dialog, el, icon, menu, toast } from "./ui.js";

const $ = (id) => document.getElementById(id);
let songs = [], needsDraw = true, saveTimer = null, lastTrack = -1;
const status = (text, bad) => { $("status").textContent = text; $("status").classList.toggle("bad", !!bad); };
const fileName = () => app.project.title.replace(/[^\w-]+/g, "_") || "song";

// ---------- view: scroll and zoom ----------
function syncScroll() { $("hspace").style.width = (app.L.total * app.view.ppb + 400) + "px"; if (Math.abs($("hscroll").scrollLeft - app.view.scrollX) > 1) $("hscroll").scrollLeft = app.view.scrollX; }
function zoom(factor, atX = 200) {
  const beat = (atX + app.view.scrollX) / app.view.ppb; app.view.ppb = Math.max(5, Math.min(260, app.view.ppb * factor));
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
function frame() {
  requestAnimationFrame(frame); if (!app.project) return;
  if (transport.playing) { follow(); needsDraw = true; }
  drawMeters(); const m = $("masterMeter").firstChild, v = transport.playing ? level() : 0, shown = Math.max(v, (parseFloat(m.dataset.v) || 0) * 0.88); m.dataset.v = shown; m.style.width = Math.round(Math.min(1, Math.sqrt(shown)) * 100) + "%";
  if (!needsDraw) return; needsDraw = false; arrange.draw(); roll.draw();
  const L = app.L, b = Math.max(0, Math.min(transport.beat(), L.total - 1e-6)), bar = barAt(L, b), secs = timeAt(L, b);
  $("position").textContent = `${bar + 1} . ${(Math.floor((b - L.start[bar]) * 100) / 100 + 1).toFixed(2)}`;
  $("posTime").textContent = `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")} / ${Math.floor(L.time[L.n] / 60)}:${String(Math.floor(L.time[L.n] % 60)).padStart(2, "0")}`;
  $("posInfo").textContent = `${Math.round(L.bpm[bar] * 10) / 10} bpm · ${sigText({ beats: L.beats[bar], division: L.division[bar] })}`;
}

// ---------- rendering on change ----------
function renderToolbar() {
  const playing = transport.playing; $("play").replaceChildren(icon(playing ? "stop" : "play", 16)); $("play").classList.toggle("stop", playing); $("play").setAttribute("aria-label", playing ? "Stop" : "Play");
  $("loop").setAttribute("aria-pressed", String(app.loop.on)); $("metro").setAttribute("aria-pressed", String(transport.metronome));
  $("toolDraw").setAttribute("aria-pressed", String(app.view.tool === "draw")); $("toolSelect").setAttribute("aria-pressed", String(app.view.tool === "select"));
  $("undo").disabled = !app.undo.length; $("redo").disabled = !app.redo.length; $("snap").value = String(app.view.snap);
  const len = String(round(app.view.noteLen)); $("noteLen").value = len; if ($("noteLen").value !== len) { $("noteLen").add(new Option(`${len} beats`, len)); $("noteLen").value = len; }
  $("title").value = app.project.title; $("songName").textContent = app.project.title; document.title = app.project.title + " · Song Workbench"; $("rollTitle").textContent = `Notes · ${track().name}`;
}
on((what) => {
  needsDraw = true; if (!app.project) return;
  if (what === "open" || what === "project" || what === "sounds") { syncScroll(); renderHeaders(); }
  if (what === "open" || what === "project") { renderChords(); renderScales(); renderPatterns(); }
  if (what === "open") { $("arrScroll").scrollTop = 0; preload(app.project); }
  if (what === "rename-chord") { showTab("chords"); renderChords(true); }
  if (what === "rename-pattern") { showTab("patterns"); renderPatterns(true); }
  if (what !== "view" && what !== "sounds") { if (what === "selection") { renderHeaders(); renderChords(); renderScales(); renderPatterns(); } renderContext(what === "focus-block"); renderKeys(); renderToolbar(); }
  if (app.sel.track !== lastTrack || what === "open") { lastTrack = app.sel.track; requestAnimationFrame(() => { roll.draw(); roll.centre($("rollScroll")); needsDraw = true; }); }
  if (what === "project" && app.dirty) { status("Unsaved"); clearTimeout(saveTimer); saveTimer = setTimeout(save, 700); }
});
function save() { if (!app.project || !app.dirty) return; if (store.saveSong(app.project)) { app.dirty = false; status("Saved " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })); } else status("Could not save in this browser. Export the song to keep your work.", true); }
function showTab(name) { $("side").classList.remove("closed"); for (const b of document.querySelectorAll("#tabs button")) { const active = b.dataset.tab === name; b.setAttribute("aria-pressed", String(active)); $("tab-" + b.dataset.tab).hidden = !active; } emit("view"); }

// ---------- songs ----------
async function refreshSongs() { songs = await store.listSongs(); }
async function openSong(id, original = false) {
  save(); transport.stop(); const entry = songs.find((s) => s.id === id); if (!entry) return;
  try { open(await store.loadSong(entry.bundled ? entry : { ...entry, file: "" }, original)); status(entry.edited && !original ? "Your edited copy" : "Opened"); }
  catch (e) { status("Could not open that song.", true); }
}
export function adopt(project) { open(project); app.dirty = true; save(); refreshSongs(); }
async function exportAudio() {
  toast("Rendering the audio…"); status("Rendering audio…");
  try { const buf = await renderSong(app.project, app.L); store.download(fileName() + ".wav", toWav(buf), "audio/wav"); status("Audio exported"); }
  catch (e) { toast("Could not render the audio in this browser.", true); status(""); }
}
function songMenu() {
  const current = songs.find((s) => s.id === app.project.id);
  menu($("songMenu"), [
    { heading: "Songs" }, ...songs.map((s) => ({ label: s.title + (s.bundled && s.edited ? " (edited)" : ""), checked: s.id === app.project.id, run: () => openSong(s.id) })), "-",
    { label: "New empty song", run: () => adopt(blank()) },
    { label: "New song from a recording…", run: () => import("./capture.js").then((m) => m.startCapture(adopt)).catch(() => toast("Recording import could not be loaded.", true)) },
    { label: "Open a song file…", run: () => $("importJson").click() }, "-",
    { label: "Save a song file", hint: "to keep or share", run: () => store.download(fileName() + ".project.json", JSON.stringify(app.project), "application/json") },
    { label: "Finish it in Suno…", hint: "audio + style prompt", run: () => import("./handoff.js").then((m) => m.finishElsewhere()) },
    { label: "Export audio (WAV)", run: exportAudio }, { label: "Export MIDI", run: () => store.download(fileName() + ".mid", toMidi(app.project), "audio/midi") }, "-",
    { label: "Revert to the original", disabled: !(current && current.bundled && current.edited), run: async () => { const id = app.project.id; store.forgetSong(id); await refreshSongs(); openSong(id, true); } },
    { label: "Delete this song from this browser", disabled: !(current && !current.bundled), run: async () => { store.forgetSong(app.project.id); await refreshSongs(); if (songs.length) openSong(songs[0].id); else adopt(blank()); } },
  ]);
}
function helpDialog() {
  const rows = (pairs) => el("table", { className: "keysheet" }, pairs.map(([k, v]) => el("tr", {}, [el("td", { textContent: k }), el("td", { textContent: v })])));
  dialog({ title: "Shortcuts and gestures", wide: true, actions: [{ label: "Close", primary: true }], body: [el("div", { className: "cols" }, [
    rows([["Space", "Play / stop"], ["Home", "Back to the start"], ["L", "Loop on / off"], ["Drag the bar numbers", "Choose the loop range"], ["← →", "Move the playhead (or nudge selected notes)"]]),
    rows([["B, V", "Draw tool, select tool"], ["Click / drag in the grid", "Draw a note; drag to stretch it"], ["Drag a note", "Move it; up or down changes pitch"], ["Drag a note's edge", "Longer or shorter"], ["Right-click a note", "Delete it"], ["↑ ↓ (Shift: octave)", "Re-pitch selected notes"], ["Drag in the Loudness lane", "Set how hard notes are played"]]),
    rows([["Ctrl+C, V, D", "Copy, paste at the playhead, repeat"], ["Ctrl+A", "Select every note on the track"], ["Delete", "Delete what is selected"], ["Ctrl+Z, Ctrl+Shift+Z", "Undo, redo"], ["Esc", "Put down the chord or pattern, clear selection"]]),
    rows([["1–9", "Choose a track"], ["M, S", "Mute, solo the chosen track"], ["Drag across a track", "Select bars (Shift: all tracks)"], ["Right-click a track or bars", "More actions"], ["T", "Open the Tools menu"]]),
    rows([["Double-click a lane", "Split a section, tempo or signature block"], ["Drag a block's edge", "Move where it starts"], ["Drag the song's end", "Add or remove bars"], ["Pick up a chord, drag on Chords", "Lay that chord along the chord lane"]]),
    rows([["Q", "Type notes on / off"], ["A W S E D F T G Y H U J K", "Notes while typing (Z, X: octave)"], ["Enter", "Write the held notes at the playhead"], ["R", "Step record: write on release"], ["Ctrl + scroll, Shift + scroll", "Zoom, scroll sideways"]]),
  ])] });
}

// ---------- shortcuts ----------
function nudge(dBeat, dPitch) {
  const t = track(), L = app.L; if (!app.sel.notes.size) return false; begin();
  for (const i of app.sel.notes) { const n = t.notes[i]; if (dBeat) { const [bar, p0] = place(Math.max(0, Math.min(L.start[n[0]] + n[1] + dBeat, L.total - 1e-3)), L); n[0] = bar; n[1] = p0; } if (dPitch && t.kind !== "drums") n[3] = Math.max(roll.BOTTOM, Math.min(roll.TOP, n[3] + dPitch)); }
  if (dPitch) hear(t, [...app.sel.notes].slice(0, 6).map((i) => t.notes[i][3]), 0.25); commit(); return true;
}
document.addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]")) return;
  if (!app.project || e.target.matches("input[type=text], input[type=number], input[type=password], select, textarea")) { if (e.key === "Enter" && !e.target.matches("textarea") || e.key === "Escape") e.target.blur?.(); return; }
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase(), done = () => e.preventDefault();
  if (mod) { if (k === "z") { e.shiftKey ? redo() : undo(); done(); } else if (k === "y") { redo(); done(); } else if (k === "c") { copy(); done(); } else if (k === "v") { paste(); done(); }
    else if (k === "d") { duplicate(); done(); } else if (k === "a") { app.sel.notes = new Set(track().notes.map((_, i) => i)); app.sel.bars = null; app.sel.block = null; emit("selection"); done(); } else if (k === "s") { app.dirty = true; save(); done(); } return; }
  if (e.code === "Space") { ensure(); transport.toggle(); return done(); }
  if (e.key === "Enter") { insertHeld(); return done(); }
  if (e.key === "Delete" || e.key === "Backspace") { removeSelection(); return done(); }
  if (e.key === "Escape") { app.brush = null; app.stamp = null; app.sel.notes = new Set(); app.sel.bars = null; app.sel.block = null; emit("selection"); return; }
  if (e.key.startsWith("Arrow")) { const step = app.view.snap, did = e.key === "ArrowLeft" ? nudge(-step, 0) : e.key === "ArrowRight" ? nudge(step, 0) : e.key === "ArrowUp" ? nudge(0, e.shiftKey ? 12 : 1) : nudge(0, e.shiftKey ? -12 : -1);
    if (!did && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { app.playhead = Math.max(0, Math.min(app.L.total, app.playhead + (e.key === "ArrowLeft" ? -step : step))); emit("selection"); } return done(); }
  if (e.key === "Home") { transport.stop(); app.playhead = 0; app.view.scrollX = 0; syncScroll(); emit("selection"); return done(); }
  if (k === "q") { app.typing = !app.typing; emit("selection"); return; }
  if (app.typing) { if (k === "z") { app.keyBase = Math.max(24, app.keyBase - 12); emit("selection"); } else if (k === "x") { app.keyBase = Math.min(72, app.keyBase + 12); emit("selection"); } else typeNote(e, true); return done(); }
  if (k === "b" || k === "d") { app.view.tool = "draw"; emit("selection"); } else if (k === "v") { app.view.tool = "select"; emit("selection"); }
  else if (k === "m") edit(() => { track().mute = !track().mute; }); else if (k === "s") edit(() => { track().solo = !track().solo; });
  else if (k === "l") { app.loop.on = !app.loop.on && app.loop.b > app.loop.a; emit("selection"); } else if (k === "r") { app.stepRecord = !app.stepRecord; emit("selection"); }
  else if (k === "t") toolsMenu($("tools")); else if (k === "?") helpDialog();
  else if (/^[1-9]$/.test(k) && +k <= app.project.tracks.length) selectTrack(+k - 1);
});

// ---------- boot ----------
function wire() {
  document.documentElement.style.setProperty("--head-w", HEAD_W + "px");
  for (const [id, name] of [["rewind", "rewind"], ["loop", "loop"], ["metro", "click"], ["toolDraw", "pencil"], ["toolSelect", "pointer"], ["undo", "undo"], ["redo", "redo"], ["zoomOut", "minus"], ["zoomIn", "plus"], ["help", "help"]]) $(id).append(icon(name));
  $("tools").append(icon("wand", 14), " Tools"); $("askAi").append(icon("spark", 14), " Assistant");
  const themeIcon = () => $("theme").replaceChildren(icon(document.documentElement.dataset.theme === "light" ? "moon" : "sun")); themeIcon();
  $("theme").addEventListener("click", () => { const next = document.documentElement.dataset.theme === "light" ? "dark" : "light"; document.documentElement.dataset.theme = next; try { localStorage.setItem("mx.theme", next); } catch (e) { /* not kept */ } themeIcon(); emit("view"); });
  arrange.mount($("arr"), { menu: (at2) => menu(at2, barsMenuItems()) }); roll.mount($("roll"), $("rollKeys"), $("rollScroll"), $("vel")); wireKeys(); wireLibrary();
  for (const c of [$("arr"), $("roll"), $("vel")]) c.addEventListener("wheel", wheel, { passive: false });
  $("hscroll").addEventListener("scroll", () => { app.view.scrollX = $("hscroll").scrollLeft; emit("view"); });
  new ResizeObserver(() => emit("view")).observe($("main")); window.addEventListener("resize", () => emit("view"));
  // the bar between the arrangement and the notes: drag to give one more room
  let resizing = null; const arrScroll = $("arrScroll");
  try { const h = +localStorage.getItem("mx.arrH"); if (h > 80) arrScroll.style.height = h + "px"; } catch (e) { /* default height */ }
  $("split").addEventListener("pointerdown", (e) => { resizing = { y: e.clientY, h: arrScroll.offsetHeight }; $("split").setPointerCapture(e.pointerId); });
  $("split").addEventListener("pointermove", (e) => { if (!resizing) return; arrScroll.style.height = Math.max(90, Math.min($("main").offsetHeight - 200, resizing.h + e.clientY - resizing.y)) + "px"; emit("view"); });
  $("split").addEventListener("pointerup", () => { if (resizing) { try { localStorage.setItem("mx.arrH", String(arrScroll.offsetHeight)); } catch (e) { /* not kept */ } resizing = null; } });
  $("play").addEventListener("click", () => { ensure(); transport.toggle(); });
  $("rewind").addEventListener("click", () => { transport.stop(); app.playhead = app.loop.on ? app.loop.a : 0; app.view.scrollX = Math.max(0, app.playhead * app.view.ppb - 80); syncScroll(); emit("selection"); });
  $("loop").addEventListener("click", () => { if (!(app.loop.b > app.loop.a) && app.sel.bars) app.loop = { on: false, a: app.L.start[app.sel.bars.a], b: app.L.start[app.sel.bars.b + 1] }; app.loop.on = !app.loop.on && app.loop.b > app.loop.a; emit("selection"); if (!(app.loop.b > app.loop.a)) toast("Drag across the bar numbers to choose what to loop."); });
  $("metro").addEventListener("click", () => { transport.metronome = !transport.metronome; emit("project"); });
  $("toolDraw").addEventListener("click", () => { app.view.tool = "draw"; emit("selection"); }); $("toolSelect").addEventListener("click", () => { app.view.tool = "select"; emit("selection"); });
  $("undo").addEventListener("click", undo); $("redo").addEventListener("click", redo);
  $("zoomIn").addEventListener("click", () => zoom(1.3)); $("zoomOut").addEventListener("click", () => zoom(1 / 1.3));
  $("tools").addEventListener("click", () => toolsMenu($("tools"))); $("help").addEventListener("click", helpDialog); $("songMenu").addEventListener("click", songMenu);
  $("askAi").addEventListener("click", () => { showTab("assistant"); const box = $("assistant").querySelector("textarea"); if (box) box.focus(); });
  for (const [v, text] of SNAPS) $("snap").add(new Option(text, String(v)));
  for (const [v, text] of [[4, "4 beats"], [2, "2 beats"], [1, "1 beat"], [0.5, "1/2"], [round(1 / 3), "1/3"], [0.25, "1/4"], [round(1 / 6), "1/6"], [0.125, "1/8"]]) $("noteLen").add(new Option(text, String(v)));
  $("snap").addEventListener("change", (e) => { app.view.snap = +e.target.value; emit("selection"); }); $("noteLen").addEventListener("change", (e) => { app.view.noteLen = +e.target.value; emit("selection"); });
  $("title").addEventListener("change", (e) => { edit((p) => { p.title = e.target.value.trim() || "Untitled"; }); save(); refreshSongs(); });
  $("importJson").addEventListener("change", async (e) => { const file = e.target.files[0]; e.target.value = ""; if (!file) return;
    try { const p = JSON.parse(await file.text()); if (!p.tracks) throw new Error("not a song"); p.id = p.id || "song-" + Date.now().toString(36); adopt(p); toast("Opened " + file.name); } catch (err) { toast("That file is not a song.", true); } });
  for (const tab of document.querySelectorAll("#tabs button")) tab.addEventListener("click", () => showTab(tab.dataset.tab));
  window.addEventListener("pagehide", save);
  import("./assistant.js").then((m) => m.mountAssistant($("assistant"))).catch(() => { $("assistant").append(el("p", { className: "hint", textContent: "The assistant could not be loaded." })); });
}
async function boot() {
  wire(); requestAnimationFrame(frame); loadLibrary(); await refreshSongs();
  if (window.__song) { adopt(window.__song); return; }
  let last = null; try { last = localStorage.getItem("mx.last"); } catch (e) { /* first visit */ }
  if (songs.length) await openSong((songs.find((s) => s.id === last) || songs[0]).id); else { adopt(blank("My first song")); status("Started an empty song"); }
}
on((what) => { if (what === "open" && app.project) { try { localStorage.setItem("mx.last", app.project.id); } catch (e) { /* not kept */ } } });
boot();
