// The side panel's library: chords (from the recording and from the scale), scales, and patterns.
import { pitchedTrack, savePattern } from "./actions.js";
import { app, edit, emit, track } from "./app.js";
import { hear, playNotes } from "./audio.js";
import { stampAt } from "./arrange.js";
import { NOTE_NAMES, SCALE_TYPES, at, chordGuess, makeScale, noteName } from "./model.js";
import { diatonicChords } from "./tools.js";
import { btn, el, select, toast } from "./ui.js";

const $ = (id) => document.getElementById(id);
let sevenths = false, pick = { tonic: 0, type: "major" };
const same = (a, b) => a && b && a.join() === b.join();
function pickUp(pitches, on) { hear(pitchedTrack(), pitches, 0.8); app.brush = on ? null : pitches.slice(); app.stamp = null; app.view.tool = "draw"; emit("selection"); }

export function renderChords(renameLast) {
  const p = app.project, box = $("chords"); box.replaceChildren();
  p.chords.forEach((c, i) => {
    const active = same(app.brush, c.pitches);
    const name = el("input", { type: "text", value: c.name, className: "cname", attrs: { "aria-label": "Chord name" }, on: { change: (e) => edit(() => { c.name = e.target.value.trim() || chordGuess(c.pitches); }) } });
    box.append(el("div", { className: "item" + (active ? " on" : "") }, [
      btn("▶", () => pickUp(c.pitches, active), { className: "sq", title: active ? "Put it down" : "Hear it and pick it up to draw with" }),
      el("div", { className: "ibody" }, [name, el("span", { className: "sub", textContent: c.pitches.map(noteName).join(" ") })]),
      btn("⌨", () => { app.held = c.pitches.slice(); app.keyBase = Math.max(24, Math.min(72, Math.floor(Math.min(...c.pitches) / 12) * 12)); emit("selection"); }, { className: "sq", title: "Load onto the keys to change it" }),
      btn("×", () => edit(() => { p.chords.splice(i, 1); }), { className: "sq", title: "Remove from the list" }),
    ]));
  });
  if (!p.chords.length) box.append(el("p", { className: "hint", textContent: "No chords yet. Hold some keys below and press Save chord, or select notes in the grid and choose Save as chord." }));
  // chords that belong to the chosen scale
  const sc = app.scale >= 0 ? p.scales[app.scale] : null, family = sc ? diatonicChords(sc, sevenths) : [], fam = $("family"); fam.replaceChildren();
  if (family.length) {
    fam.append(el("div", { className: "rowx" }, [el("h3", { textContent: `In ${sc.name}` }), btn(sevenths ? "Sevenths" : "Triads", () => { sevenths = !sevenths; renderChords(); }, { title: "Switch between three-note and four-note chords", className: "small" })]),
      el("div", { className: "chips" }, family.map((c) => { const active = same(app.brush, c.pitches);
        return btn([el("b", { textContent: c.name }), el("span", { textContent: c.numeral })], () => pickUp(c.pitches, active), { className: "chip" + (active ? " on" : ""), title: c.pitches.map(noteName).join(" ") }); })));
    if (app.brush && !p.chords.some((c) => same(c.pitches, app.brush))) fam.append(btn(`Keep ${chordGuess(app.brush)} in my list`, () => { const pitches = app.brush.slice(); edit((pp) => { pp.chords.push({ name: chordGuess(pitches), pitches }); }); }, { className: "small" }));
  } else fam.append(el("p", { className: "hint", textContent: sc ? "This scale has no three-note chord family." : "Choose a scale in the Scales tab to see the chords that belong to it." }));
  if (renameLast) { const inputs = box.querySelectorAll(".cname"), last = inputs[inputs.length - 1]; if (last) { last.focus(); last.select(); last.scrollIntoView({ block: "nearest" }); } }
}

export function renderScales() {
  const p = app.project, box = $("scales"); box.replaceChildren();
  p.scales.forEach((s, i) => { const whole = !s.bars || (s.bars[0] === 1 && s.bars[1] >= p.bars - 1);
    box.append(el("div", { className: "item" + (i === app.scale ? " on" : "") }, [
      btn([el("b", { textContent: s.name }), el("span", { className: "sub", textContent: (s.fit != null ? `${Math.round(s.fit * 100)}% of the playing` : "added by you") + (whole ? "" : ` · bars ${s.bars[0]}–${s.bars[1]}`) })], () => { app.scale = app.scale === i ? -1 : i; emit("selection"); }, { className: "wide" }),
      s.fit == null ? btn("×", () => { edit(() => { p.scales.splice(i, 1); }); app.scale = Math.min(app.scale, p.scales.length - 1); emit("selection"); }, { className: "sq", title: "Remove" }) : null])); });
  if (!p.scales.length) box.append(el("p", { className: "hint", textContent: "No scale yet. Add one below." }));
  $("scaleAdd").replaceChildren(select(NOTE_NAMES.map((n, i) => [i, n]), pick.tonic, (v) => { pick.tonic = +v; }, "Tonic"), select(Object.keys(SCALE_TYPES).map((t) => [t, t]), pick.type, (v) => { pick.type = v; }, "Scale type"),
    btn("Add", () => { const sc = makeScale(pick.tonic, pick.type); if (!p.scales.some((s) => s.name === sc.name)) edit((pp) => { pp.scales.push({ name: sc.name, tonic: sc.tonic, pitch_classes: sc.pitch_classes, bars: [1, pp.bars] }); }); app.scale = p.scales.findIndex((s) => s.name === sc.name); emit("selection"); }));
  $("scaleLock").setAttribute("aria-pressed", String(app.scaleLock)); $("scaleLock").disabled = app.scale < 0;
}

export function renderPatterns(renameLast) {
  const p = app.project, box = $("patterns"); box.replaceChildren();
  p.patterns.forEach((pt, i) => {
    const active = app.stamp === pt, target = () => (track().kind === pt.kind ? track() : p.tracks.find((t) => t.kind === pt.kind));
    const name = el("input", { type: "text", value: pt.name, className: "cname", attrs: { "aria-label": "Pattern name" }, on: { change: (e) => edit(() => { pt.name = e.target.value.trim() || "Pattern"; }) } });
    box.append(el("div", { className: "item" + (active ? " on" : "") }, [
      btn("▶", () => { const t = target(); if (t) playNotes(t, pt.notes, at(p.tempo, 0).bpm); }, { className: "sq", title: "Hear it" }),
      el("div", { className: "ibody" }, [name, el("span", { className: "sub", textContent: `${pt.notes.length} notes · ${pt.length} beats · ${pt.kind === "drums" ? "drums" : "notes"}` })]),
      btn(active ? "Down" : "Pick up", () => { app.stamp = active ? null : pt; app.brush = null; app.view.tool = "draw"; emit("selection"); }, { className: "small", title: "Then click in the grid, or on a track's lane, to stamp it there" }),
      btn("↓", () => { const t = target(); if (!t) return toast(`Add a ${pt.kind === "drums" ? "drum" : "pitched"} track first.`, true); const keep = app.stamp; app.stamp = pt; stampAt(t, app.playhead); app.stamp = keep; app.playhead = Math.min(app.L.total, app.playhead + pt.length); emit("selection"); }, { className: "sq", title: "Insert at the playhead and step forward" }),
      btn("×", () => { if (app.stamp === pt) app.stamp = null; edit(() => { p.patterns.splice(i, 1); }); }, { className: "sq", title: "Remove" }),
    ]));
  });
  if (!p.patterns.length) box.append(el("p", { className: "hint", textContent: "Patterns are bits of a part you want to reuse: a riff, a strum, a drum bar. Select notes or bars, then Save as pattern." }));
  if (renameLast) { const inputs = box.querySelectorAll(".cname"), last = inputs[inputs.length - 1]; if (last) { last.focus(); last.select(); } }
}
export function wireLibrary() {
  $("scaleLock").addEventListener("click", () => { app.scaleLock = !app.scaleLock; emit("selection"); });
  $("patternSave").addEventListener("click", () => { if (!savePattern()) toast("Select some notes, or drag across bars on a track, first.", true); });
}
