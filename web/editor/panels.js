// Everything that is plain HTML: track headers, the context bar, and the chord / scale / keys panels.
import { app, begin, commit, edit, emit, selectTrack, track } from "./app.js";
import { hear } from "./audio.js";
import { LANES, RULER, TRACK_H, trackColor } from "./arrange.js";
import { DRUM_ROWS, INSTRUMENTS, at, chordGuess, clearBars, copyBars, deleteBars, duplicateBars, insertBars, noteName, pasteBars, place, prune, removeBlock, sigText, splitAt, barAt } from "./model.js";

const $ = (id) => document.getElementById(id);
export function el(tag, props = {}, kids = []) {
  const { on: handlers, attrs, style, ...rest } = props, n = Object.assign(document.createElement(tag), rest);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  if (style) n.style.cssText = style;
  for (const [k, fn] of Object.entries(handlers || {})) n.addEventListener(k, fn);
  n.append(...kids.filter((k) => k != null)); return n;
}
const btn = (text, onclick, props = {}) => el("button", { type: "button", textContent: text, ...props, on: { click: onclick } });
const pitchedTrack = () => (track().kind === "drums" ? app.project.tracks.find((t) => t.kind !== "drums") || track() : track());
const uid = () => "t" + Date.now().toString(36) + Math.floor(Math.random() * 99);

// ---------- track headers ----------
export function renderHeaders() {
  const p = app.project, box = $("heads"); box.replaceChildren();
  for (const [, h, name] of LANES) box.append(el("div", { className: "lanehead", textContent: name, style: `height:${h}px` }));
  box.append(el("div", { className: "lanehead", textContent: "Bars", style: `height:${RULER}px` }));
  p.tracks.forEach((t, i) => {
    const name = el("input", { type: "text", value: t.name, className: "tname", attrs: { "aria-label": "Track name" }, on: { change: (e) => edit(() => { t.name = e.target.value.trim() || "Track"; }), pointerdown: () => selectTrack(i) } });
    const inst = el("select", { className: "tinst", attrs: { "aria-label": "Sound" }, disabled: t.kind === "drums", on: { change: (e) => { edit(() => { t.instrument = e.target.value; }); hear(t, [60]); } } },
      (t.kind === "drums" ? ["kit"] : INSTRUMENTS).map((v) => el("option", { value: v, textContent: v })));
    inst.value = t.instrument;
    const vol = el("input", { type: "range", min: 0, max: 1, step: 0.01, value: t.volume, className: "tvol", attrs: { "aria-label": "Volume" }, on: { pointerdown: begin, input: (e) => { t.volume = +e.target.value; }, change: commit } });
    box.append(el("div", { className: "thead" + (i === app.sel.track ? " on" : ""), style: `height:${TRACK_H}px; --c:${trackColor(i)}`, on: { pointerdown: (e) => { if (!e.target.closest("input,select,button")) selectTrack(i); } } }, [
      el("div", { className: "trow" }, [name,
        btn("M", () => edit(() => { t.mute = !t.mute; }), { className: "sq" + (t.mute ? " on" : ""), title: "Mute (M)", attrs: { "aria-pressed": String(!!t.mute) } }),
        btn("S", () => edit(() => { t.solo = !t.solo; }), { className: "sq solo" + (t.solo ? " on" : ""), title: "Solo: hear only this track (S)", attrs: { "aria-pressed": String(!!t.solo) } })]),
      el("div", { className: "trow" }, [inst, vol, btn("×", () => { if (p.tracks.length > 1) edit(() => { p.tracks.splice(i, 1); }); }, { className: "sq", title: "Remove track", disabled: p.tracks.length < 2 })]),
    ]));
  });
}
export function addTrack(drums) {
  edit((p) => { p.tracks.push({ id: uid(), name: drums ? "Drums" : "Track " + (p.tracks.length + 1), kind: drums ? "drums" : "pitched", instrument: drums ? "kit" : "keys", volume: 0.8, mute: false, solo: false, notes: [] }); });
  selectTrack(app.project.tracks.length - 1);
}

// ---------- context bar: tools for whatever is selected ----------
const scopeIds = () => (app.sel.bars && app.sel.bars.all ? app.project.tracks.map((t) => t.id) : [track().id]);
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
  const t = track();
  if (app.sel.notes.size) { begin(); t.notes = t.notes.filter((_, i) => !app.sel.notes.has(i)); app.sel.notes = new Set(); commit(); }
  else if (app.sel.block && app.sel.block.index > 0) { begin(); removeBlock(app.project[app.sel.block.lane], app.sel.block.index); if (app.sel.block.lane === "signature") prune(app.project); app.sel.block = null; commit(); }
  else if (app.sel.bars) edit((p) => clearBars(p, app.sel.bars.a, app.sel.bars.b, scopeIds()));
}
export function duplicate() {
  const t = track(), L = app.L;
  if (app.sel.notes.size) { begin(); const ns = [...app.sel.notes].map((i) => t.notes[i]), a0 = Math.min(...ns.map((n) => L.start[n[0]] + n[1])), a1 = Math.max(...ns.map((n) => L.start[n[0]] + n[1] + n[2])), first = t.notes.length;
    for (const n of ns) { const a = L.start[n[0]] + n[1] + (a1 - a0); if (a < L.total) t.notes.push([...place(a, L), n[2], n[3], n[4]]); }
    app.sel.notes = new Set(t.notes.slice(first).map((_, k) => first + k)); commit(); }
  else if (app.sel.bars) { const { a, b } = app.sel.bars; begin(); duplicateBars(app.project, a, b); app.sel.bars = { ...app.sel.bars, a: b + 1, b: b + 1 + (b - a) }; commit(); }
}
const num = (value, min, max, step, onchange, label) => el("input", { type: "number", value, min, max, step, attrs: { "aria-label": label }, on: { change: (e) => { const v = Math.max(min, Math.min(max, +e.target.value)); if (v) onchange(v); else emit("selection"); } } });
const tag = (text) => el("span", { className: "tag", textContent: text });

export function renderContext(focus) {
  const p = app.project, L = app.L, bar = $("context"), t = track(), kids = [];
  if (app.sel.notes.size) {
    const ns = [...app.sel.notes].map((i) => t.notes[i]).filter(Boolean), one = ns.length === 1 ? ns[0] : null;
    kids.push(tag(one ? `${t.kind === "drums" ? (DRUM_ROWS.find((d) => d[0] === one[3]) || [0, "drum"])[1] : noteName(one[3])} · bar ${one[0] + 1}, beat ${Math.round((one[1] + 1) * 100) / 100} · ${Math.round(one[2] * 100) / 100} beats` : `${ns.length} notes` + (t.kind === "drums" ? "" : ` · ${chordGuess(ns.map((n) => n[3]))}`)),
      el("label", { textContent: "Loudness" }), el("input", { type: "range", min: 0.05, max: 1, step: 0.01, value: ns.length ? ns.reduce((s, n) => s + n[4], 0) / ns.length : 0.8, attrs: { "aria-label": "Loudness" }, on: { pointerdown: begin, input: (e) => { for (const n of ns) n[4] = +e.target.value; emit("view"); }, change: commit } }),
      btn("Copy", copy), btn("Duplicate", duplicate, { title: "Repeat right after (Ctrl+D)" }), btn("Delete", removeSelection));
    if (t.kind !== "drums" && ns.length > 1) kids.push(btn("Save as chord", () => saveChord([...new Set(ns.map((n) => n[3]))])));
  } else if (app.sel.block) {
    const { lane, index } = app.sel.block, list = p[lane], e = list[index], lastBar = (index + 1 < list.length ? list[index + 1].bar : p.bars);
    kids.push(tag(`${lane === "sections" ? "Section" : lane === "tempo" ? "Tempo" : "Signature"} · bars ${e.bar + 1}–${lastBar}`));
    if (lane === "tempo") kids.push(el("label", { textContent: "Beats per minute" }), num(Math.round(e.bpm * 10) / 10, 20, 300, 1, (v) => edit(() => { e.bpm = v; }), "Beats per minute"));
    else if (lane === "signature") {
      const beats = el("select", { attrs: { "aria-label": "Beats in a bar" }, on: { change: (ev) => edit((pp) => { e.beats = +ev.target.value; prune(pp); }) } }, [1, 2, 3, 4, 5, 6, 7, 8, 9].map((v) => el("option", { value: v, textContent: v })));
      const div = el("select", { attrs: { "aria-label": "Each beat divides in" }, on: { change: (ev) => edit(() => { e.division = +ev.target.value; }) } }, [el("option", { value: 2, textContent: "two" }), el("option", { value: 3, textContent: "three" })]);
      beats.value = e.beats; div.value = e.division;
      kids.push(el("label", { textContent: "Beats in a bar" }), beats, el("label", { textContent: "each divides in" }), div, tag(sigText(e)));
    } else kids.push(el("label", { textContent: "Name" }), el("input", { type: "text", value: e.name, attrs: { "aria-label": "Section name" }, on: { change: (ev) => edit(() => { e.name = ev.target.value.trim() || "Part"; }) } }));
    kids.push(btn("Split at playhead", () => { const b = barAt(L, Math.min(app.playhead, L.total - 1e-6)); begin(); app.sel.block = { lane, index: splitAt(list, b) }; commit(); emit("focus-block"); }, { title: "Start a new block at the playhead's bar" }),
      btn("Remove block", removeSelection, { disabled: index === 0, title: "Merge into the block before" }), el("span", { className: "hint", textContent: "Drag a block's edge to move where it starts. Double-click a lane to split." }));
  } else if (app.sel.bars) {
    const { a, b, all } = app.sel.bars;
    kids.push(tag((a === b ? `Bar ${a + 1}` : `Bars ${a + 1}–${b + 1}`) + ` · ${at(p.tempo, a).bpm} bpm · ${sigText(at(p.signature, a))}`),
      btn(all ? "All tracks" : "Only " + t.name, () => { app.sel.bars.all = !all; emit("selection"); }, { title: "What copy, paste and clear apply to. Click to switch.", className: all ? "on" : "" }),
      btn("Copy", copy), btn("Paste", paste, { disabled: !app.clip || app.clip.kind !== "bars" }), btn("Clear", removeSelection),
      btn("Repeat", duplicate, { title: "Play these bars again right after (all tracks, with tempo and signature)" }),
      btn("Insert empty bar", () => edit((pp) => insertBars(pp, b + 1, 1))), btn("Delete bars", () => { begin(); deleteBars(p, a, b); app.sel.bars = null; commit(); }, { disabled: b - a + 1 >= p.bars }),
      btn("Loop these", () => { app.loop = { on: true, a: L.start[a], b: L.start[b + 1] }; emit("selection"); }));
  } else kids.push(el("span", { className: "hint", textContent: `${t.name}: ${app.view.tool === "draw" ? "click or drag in the grid to draw" + (app.brush ? " the chord " + chordGuess(app.brush) : " a note") : "drag in the grid to select notes"}. Drag a note to move it, its edge to resize. Drag across a track above to select bars.` }));
  if (app.brush) kids.push(btn(`Drawing ${chordGuess(app.brush)} ✕`, () => { app.brush = null; emit("selection"); }, { className: "on", title: "Stop drawing this chord (Esc)" }));
  bar.replaceChildren(...kids);
  if (focus) { const input = bar.querySelector("input[type=number], input[type=text]"); if (input) { input.focus(); input.select(); } }
}

// ---------- chords ----------
export function saveChord(pitches, name) {
  pitches = pitches.slice().sort((a, b) => a - b); if (!pitches.length) return;
  edit((p) => { p.chords.push({ name: name || chordGuess(pitches), pitches }); });
  app.brush = pitches; emit("rename-chord");
}
export function renderChords(renameLast) {
  const p = app.project, box = $("chords"); box.replaceChildren();
  p.chords.forEach((c, i) => {
    const active = app.brush && app.brush.join() === c.pitches.join();
    const name = el("input", { type: "text", value: c.name, className: "cname", attrs: { "aria-label": "Chord name" }, on: { change: (e) => edit(() => { c.name = e.target.value.trim() || chordGuess(c.pitches); }) } });
    box.append(el("div", { className: "chord" + (active ? " on" : "") }, [
      btn("▶", () => { hear(pitchedTrack(), c.pitches, 0.8); app.brush = active ? null : c.pitches.slice(); app.view.tool = "draw"; emit("selection"); }, { className: "sq", title: active ? "Put it down" : "Hear it and pick it up to draw with" }),
      el("div", { className: "cbody" }, [name, el("span", { className: "cnotes", textContent: c.pitches.map(noteName).join(" ") })]),
      btn("⌨", () => { app.held = c.pitches.slice(); app.keyBase = Math.max(24, Math.min(72, Math.floor(Math.min(...c.pitches) / 12) * 12)); emit("selection"); }, { className: "sq", title: "Load onto the keys to change it" }),
      btn("×", () => edit(() => { p.chords.splice(i, 1); }), { className: "sq", title: "Remove from the list" }),
    ]));
  });
  if (!p.chords.length) box.append(el("p", { className: "hint", textContent: "No chords yet. Hold some keys and save them, or select notes in the grid and choose Save as chord." }));
  if (renameLast) { const inputs = box.querySelectorAll(".cname"), last = inputs[inputs.length - 1]; if (last) { last.focus(); last.select(); } }
}

// ---------- scales ----------
export function renderScales() {
  const p = app.project, box = $("scales"); box.replaceChildren();
  p.scales.forEach((s, i) => { const whole = !s.bars || (s.bars[0] === 1 && s.bars[1] >= p.bars - 1);
    box.append(btn("", () => { app.scale = app.scale === i ? -1 : i; emit("selection"); }, { className: "scale" + (i === app.scale ? " on" : ""), innerHTML: "" }));
    box.lastChild.append(el("b", { textContent: s.name }), el("span", { textContent: (s.fit != null ? `${Math.round(s.fit * 100)}% of the playing` : "") + (whole ? "" : ` · bars ${s.bars[0]}–${s.bars[1]}`) })); });
  if (!p.scales.length) box.append(el("p", { className: "hint", textContent: "No scales were detected for this song." }));
  $("scaleLock").setAttribute("aria-pressed", String(app.scaleLock)); $("scaleLock").disabled = app.scale < 0;
}

// ---------- keys ----------
export const TYPING = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ";": 16, "'": 17 };
export function insertHeld() { // put the held notes at the playhead on the chosen track, and step forward
  const t = pitchedTrack(), L = app.L; if (!app.held.length || app.playhead >= L.total) return;
  if (t !== track()) selectTrack(app.project.tracks.indexOf(t));
  begin(); const first = t.notes.length; for (const pitch of app.held) t.notes.push([...place(app.playhead, L), app.view.noteLen, pitch, 0.8]);
  app.sel.notes = new Set(app.held.map((_, k) => first + k)); app.playhead = Math.min(L.total, app.playhead + app.view.noteLen); commit();
}
export function renderKeys() {
  const box = $("keys"), pcs = app.scale >= 0 && app.project.scales[app.scale] ? new Set(app.project.scales[app.scale].pitch_classes) : null, held = new Set(app.held);
  const letters = Object.fromEntries(Object.entries(TYPING).map(([k, v]) => [v, k]));
  box.replaceChildren(...Array.from({ length: 25 }, (_, k) => { const pitch = app.keyBase + k, black = [1, 3, 6, 8, 10].includes(pitch % 12);
    return btn(app.typing && letters[k] ? letters[k].toUpperCase() : pitch % 12 === 0 ? noteName(pitch) : "", () => { hear(pitchedTrack(), [pitch]); app.held = held.has(pitch) ? app.held.filter((x) => x !== pitch) : [...app.held, pitch].sort((a, b) => a - b); emit("selection"); },
      { className: "key" + (black ? " black" : "") + (pcs && pcs.has(pitch % 12) ? " inscale" : "") + (held.has(pitch) ? " held" : ""), attrs: { "aria-label": noteName(pitch) } }); }));
  $("heldName").textContent = app.held.length ? `${chordGuess(app.held)}  ·  ${app.held.map(noteName).join(" ")}` : "Nothing held";
  for (const id of ["heldPlay", "heldInsert", "heldBrush", "heldSave", "heldClear"]) $(id).disabled = !app.held.length;
  $("typing").setAttribute("aria-pressed", String(app.typing)); $("stepRecord").setAttribute("aria-pressed", String(app.stepRecord));
}
export function wireKeys() {
  $("heldPlay").addEventListener("click", () => hear(pitchedTrack(), app.held, 0.8));
  $("heldInsert").addEventListener("click", insertHeld);
  $("heldBrush").addEventListener("click", () => { app.brush = app.held.slice(); app.view.tool = "draw"; emit("selection"); });
  $("heldSave").addEventListener("click", () => saveChord(app.held));
  $("heldClear").addEventListener("click", () => { app.held = []; emit("selection"); });
  $("octDown").addEventListener("click", () => { app.keyBase = Math.max(24, app.keyBase - 12); emit("selection"); });
  $("octUp").addEventListener("click", () => { app.keyBase = Math.min(72, app.keyBase + 12); emit("selection"); });
  $("typing").addEventListener("click", () => { app.typing = !app.typing; emit("selection"); });
  $("stepRecord").addEventListener("click", () => { app.stepRecord = !app.stepRecord; emit("selection"); });
  $("scaleLock").addEventListener("click", () => { app.scaleLock = !app.scaleLock; emit("selection"); });
}
