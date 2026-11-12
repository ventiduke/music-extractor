// The context bar: tools for whatever is selected (notes, a block, bars, or just the track).
import { copy, duplicate, paste, removeSelection, saveChord, savePattern, scopeIds } from "./actions.js";
import { app, begin, commit, edit, emit, track } from "./app.js";
import { syncMixer } from "./audio.js";
import { DRUM_ROWS, at, barAt, chordGuess, deleteBars, insertBars, noteName, prune, sigText, splitAt } from "./model.js";
import { toolsMenu } from "./toolbox.js";
import { duplicateTrack, removeTrack } from "./actions.js";
import { btn, el, icon, select } from "./ui.js";

const $ = (id) => document.getElementById(id);
const num = (value, min, max, step, onchange, label) => el("input", { type: "number", value, min, max, step, attrs: { "aria-label": label }, on: { change: (e) => { const v = Math.max(min, Math.min(max, +e.target.value)); if (v) onchange(v); else emit("selection"); } } });
const tag = (text) => el("span", { className: "tag", textContent: text });
const slider = (label, value, min, max, set) => el("label", { className: "mini" }, [el("span", { textContent: label }), el("input", { type: "range", min, max, step: 0.01, value, attrs: { "aria-label": label }, on: { pointerdown: begin, input: (e) => { set(+e.target.value); syncMixer(); emit("view"); }, change: commit } })]);
const toolsBtn = () => btn([icon("wand", 14), " Tools"], (e) => toolsMenu(e.currentTarget), { title: "Write parts from the chords, or reshape what is selected" });

export function renderContext(focus) {
  const p = app.project, L = app.L, bar = $("context"), t = track(), kids = [];
  if (app.sel.notes.size) {
    const ns = [...app.sel.notes].map((i) => t.notes[i]).filter(Boolean), one = ns.length === 1 ? ns[0] : null;
    kids.push(tag(one ? `${t.kind === "drums" ? (DRUM_ROWS.find((d) => d[0] === one[3]) || [0, "drum"])[1] : noteName(one[3])} · bar ${one[0] + 1}, beat ${Math.round((one[1] + 1) * 100) / 100} · ${Math.round(one[2] * 100) / 100} beats` : `${ns.length} notes` + (t.kind === "drums" ? "" : ` · ${chordGuess(ns.map((n) => n[3]))}`)),
      slider("Loudness", ns.length ? ns.reduce((s, n) => s + n[4], 0) / ns.length : 0.8, 0.05, 1, (v) => { for (const n of ns) n[4] = v; }),
      btn("Copy", copy), btn("Duplicate", duplicate, { title: "Repeat right after (Ctrl+D)" }), btn("Delete", removeSelection), toolsBtn(), btn("Save as pattern", savePattern, { title: "Keep these notes as a reusable pattern" }));
    if (t.kind !== "drums" && ns.length > 1) kids.push(btn("Save as chord", () => saveChord(ns.map((n) => n[3]))));
  } else if (app.sel.block && app.sel.block.lane === "chords") {
    const c = p.progression[app.sel.block.index];
    kids.push(tag(`Chord · bar ${c.bar + 1}, beat ${Math.round((c.pos + 1) * 100) / 100} · ${Math.round(c.len * 100) / 100} beats`),
      el("label", { textContent: "Name" }), el("input", { type: "text", value: c.name, attrs: { "aria-label": "Chord name" }, on: { change: (e) => edit(() => { c.name = e.target.value.trim() || chordGuess(c.pitches); }) } }),
      el("label", { textContent: "Change to" }), select([["", c.pitches.map(noteName).join(" ")], ...p.chords.map((x, i) => [i, x.name])], "", (v) => { if (v !== "") edit(() => { c.name = p.chords[+v].name; c.pitches = p.chords[+v].pitches.slice(); }); }, "Change to a chord from the list"),
      btn("Pick up", () => { app.brush = c.pitches.slice(); app.stamp = null; app.view.tool = "draw"; emit("selection"); }, { title: "Draw with this chord" }), btn("Remove", removeSelection),
      el("span", { className: "hint", textContent: "Drag its edges to change where it sounds. Parts written from the Tools menu follow this lane." }));
  } else if (app.sel.block) {
    const { lane, index } = app.sel.block, list = p[lane], e = list[index], lastBar = (index + 1 < list.length ? list[index + 1].bar : p.bars);
    kids.push(tag(`${lane === "sections" ? "Section" : lane === "tempo" ? "Tempo" : "Signature"} · bars ${e.bar + 1}–${lastBar}`));
    if (lane === "tempo") kids.push(el("label", { textContent: "Beats per minute" }), num(Math.round(e.bpm * 10) / 10, 20, 300, 1, (v) => edit(() => { e.bpm = v; }), "Beats per minute"));
    else if (lane === "signature") kids.push(el("label", { textContent: "Beats in a bar" }), select([1, 2, 3, 4, 5, 6, 7, 8, 9, 12].map((v) => [v, v]), e.beats, (v) => edit((pp) => { e.beats = +v; prune(pp); }), "Beats in a bar"),
      el("label", { textContent: "each divides in" }), select([[2, "two"], [3, "three"]], e.division, (v) => edit(() => { e.division = +v; }), "Each beat divides in"), tag(sigText(e)));
    else kids.push(el("label", { textContent: "Name" }), el("input", { type: "text", value: e.name, attrs: { "aria-label": "Section name" }, on: { change: (ev) => edit(() => { e.name = ev.target.value.trim() || "Part"; }) } }));
    kids.push(btn("Split at playhead", () => { const b = barAt(L, Math.min(app.playhead, L.total - 1e-6)); begin(); app.sel.block = { lane, index: splitAt(list, b) }; commit(); emit("focus-block"); }, { title: "Start a new block at the playhead's bar" }),
      btn("Remove block", removeSelection, { disabled: index === 0, title: "Merge into the block before" }), el("span", { className: "hint", textContent: "Drag an edge to move where it starts. Double-click the lane to split." }));
  } else if (app.sel.bars) {
    const { a, b, all } = app.sel.bars;
    kids.push(tag((a === b ? `Bar ${a + 1}` : `Bars ${a + 1}–${b + 1}`) + ` · ${at(p.tempo, a).bpm} bpm · ${sigText(at(p.signature, a))}`),
      btn(all ? "All tracks" : "Only " + t.name, () => { app.sel.bars.all = !all; emit("selection"); }, { title: "What copy, paste and clear apply to. Click to switch.", className: all ? "on" : "" }),
      btn("Copy", copy), btn("Paste", paste, { disabled: !app.clip || app.clip.kind !== "bars" }), btn("Clear", removeSelection),
      btn("Repeat", duplicate, { title: "Play these bars again right after (all tracks, with tempo, signature and chords)" }),
      btn("Insert bar", () => edit((pp) => insertBars(pp, b + 1, 1)), { title: "An empty bar after these" }), btn("Delete bars", () => { begin(); deleteBars(p, a, b); app.sel.bars = null; commit(); }, { disabled: b - a + 1 >= p.bars }),
      btn("Loop", () => { app.loop = { on: true, a: L.start[a], b: L.start[b + 1] }; emit("selection"); }, { title: "Loop these bars" }), toolsBtn(), btn("Save as pattern", savePattern, { title: `Keep ${t.name}'s notes in these bars as a reusable pattern` }));
  } else {
    const i = app.sel.track;
    kids.push(tag(t.name), slider("Pan", t.pan ?? 0, -1, 1, (v) => { t.pan = Math.abs(v) < 0.04 ? 0 : v; }), slider("Reverb", t.reverb ?? 0, 0, 1, (v) => { t.reverb = v; }), toolsBtn(),
      btn("Duplicate track", () => duplicateTrack(i)), btn("Remove track", () => removeTrack(i), { disabled: p.tracks.length < 2 }),
      el("span", { className: "hint", textContent: app.view.tool === "draw" ? "Click or drag in the grid to draw. Drag a note to move it, an edge to resize. Drag across a track above to select bars." : "Drag in the grid to select notes." }));
  }
  if (app.brush) kids.push(btn(`Drawing ${chordGuess(app.brush)} ✕`, () => { app.brush = null; emit("selection"); }, { className: "on pill", title: "Stop drawing this chord (Esc)" }));
  if (app.stamp) kids.push(btn(`Stamping ${app.stamp.name} ✕`, () => { app.stamp = null; emit("selection"); }, { className: "on pill", title: "Stop stamping this pattern (Esc)" }));
  bar.replaceChildren(...kids);
  if (focus) { const input = bar.querySelector("input[type=number], input[type=text]"); if (input) { input.focus(); input.select(); } }
}
/** The menu for a right-click on selected bars in the arrangement. */
export function barsMenuItems() {
  const p = app.project, { a, b } = app.sel.bars;
  return [{ label: "Copy", hint: "Ctrl+C", run: copy }, { label: "Paste", hint: "Ctrl+V", disabled: !app.clip || app.clip.kind !== "bars", run: paste }, { label: "Repeat", hint: "Ctrl+D", run: duplicate }, { label: "Clear", hint: "Del", run: removeSelection }, "-",
    { label: "Insert an empty bar after", run: () => edit((pp) => insertBars(pp, b + 1, 1)) }, { label: "Delete bars", disabled: b - a + 1 >= p.bars, run: () => { begin(); deleteBars(p, a, b); app.sel.bars = null; commit(); } },
    { label: "Loop these bars", run: () => { app.loop = { on: true, a: app.L.start[a], b: app.L.start[b + 1] }; emit("selection"); } }, "-", { label: "Save as pattern", run: savePattern }];
}
export { scopeIds };
