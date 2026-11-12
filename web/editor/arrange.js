// The arrangement: block lanes for sections, chords, tempo and signature; the bar ruler; one lane per track.
import { app, begin, commit, emit, selectTrack, touch } from "./app.js";
import { transport } from "./audio.js";
import { barAt, moveStart, place, prune, round, setLength, sigText, snapDown, snapTo, splitAt } from "./model.js";
import { setChord } from "./tools.js";

export const LANES = [["sections", 22, "Sections"], ["chords", 24, "Chords"], ["tempo", 20, "Tempo"], ["signature", 20, "Signature"]];
export const RULER = 22, TRACK_H = 58;
const LANES_H = LANES.reduce((s, l) => s + l[1], 0);
export const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const trackColor = (i) => css("--t" + (i % 8));

let canvas, g, drag = null, onMenu = null;
const X = (beat) => beat * app.view.ppb - app.view.scrollX;
const beatAt = (x) => (x + app.view.scrollX) / app.view.ppb;
const label = (lane, e) => (lane === "tempo" ? `${Math.round(e.bpm * 10) / 10} bpm` : lane === "signature" ? sigText(e) : e.name);
const chordSpan = (c) => { const s = app.L.start[c.bar] + c.pos; return [s, s + c.len]; };

export function height() { return LANES_H + RULER + app.project.tracks.length * TRACK_H + 8; }

function roundRect(x, y, w, h, r) { g.beginPath(); if (g.roundRect) g.roundRect(x, y, Math.max(1, w), h, Math.min(r, Math.max(1, w) / 2)); else g.rect(x, y, Math.max(1, w), h); }

export function draw() {
  const p = app.project, L = app.L, w = canvas.clientWidth, h = height(), dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); canvas.style.height = h + "px"; }
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const C = { line: css("--line"), fg: css("--fg"), muted: css("--muted"), soft: css("--soft"), sel: css("--accent"), selSoft: css("--accent-soft"), panel: css("--panel"), bg: css("--bg"), lane: css("--lane") };
  const first = barAt(L, Math.max(0, beatAt(0))), last = barAt(L, beatAt(w));
  g.textBaseline = "middle";
  // lanes of blocks
  let y = 0;
  for (const [lane, lh] of LANES) {
    g.fillStyle = C.lane; g.fillRect(0, y, w, lh);
    const blocks = lane === "chords" ? p.progression.map((c, i) => ({ i, a: chordSpan(c)[0], b: chordSpan(c)[1], text: c.name })) : p[lane].map((e, i, list) => ({ i, a: L.start[e.bar], b: L.start[i + 1 < list.length ? list[i + 1].bar : L.n], text: label(lane, e) }));
    for (const blk of blocks) {
      const x0 = X(blk.a), x1 = X(blk.b); if (x1 < 0 || x0 > w) continue;
      const on = app.sel.block && app.sel.block.lane === lane && app.sel.block.index === blk.i;
      g.fillStyle = lane === "sections" ? trackColor(blk.i) : lane === "chords" ? css("--chord") : C.soft; g.globalAlpha = lane === "sections" ? 0.85 : 1;
      roundRect(x0 + 1, y + 2, x1 - x0 - 2, lh - 4, 4); g.fill(); g.globalAlpha = 1;
      if (on) { g.strokeStyle = C.sel; g.lineWidth = 2; roundRect(x0 + 2, y + 3, x1 - x0 - 4, lh - 6, 3); g.stroke(); g.lineWidth = 1; }
      g.fillStyle = lane === "sections" ? css("--on-color") : lane === "chords" ? css("--chord-fg") : C.fg; g.font = (lane === "chords" ? "600 12px " : "600 11px ") + css("--body");
      const tx = Math.max(x0, 0) + 6; if (x1 - tx > 14) g.fillText(blk.text, tx, y + lh / 2 + 0.5, x1 - tx - 4);
    }
    g.strokeStyle = C.line; g.beginPath(); g.moveTo(0, y + lh + 0.5); g.lineTo(w, y + lh + 0.5); g.stroke();
    y += lh;
  }
  // ruler
  g.fillStyle = C.panel; g.fillRect(0, y, w, RULER);
  if (app.loop.b > app.loop.a) { g.fillStyle = app.loop.on ? C.sel : C.muted; g.globalAlpha = app.loop.on ? 0.4 : 0.2; g.fillRect(X(app.loop.a), y, X(app.loop.b) - X(app.loop.a), RULER); g.globalAlpha = 1; }
  const barPx = app.view.ppb * 4, every = barPx >= 34 ? 1 : barPx >= 16 ? 2 : barPx >= 8 ? 4 : 8;
  g.font = "600 10.5px " + css("--mono");
  for (let b = first; b <= last; b++) { const x = Math.round(X(L.start[b])) + 0.5;
    g.strokeStyle = C.muted; g.globalAlpha = 0.5; g.beginPath(); g.moveTo(x, y + (b % every ? 14 : 4)); g.lineTo(x, y + RULER); g.stroke(); g.globalAlpha = 1;
    if (b % every === 0) { g.fillStyle = C.muted; g.fillText(String(b + 1), x + 4, y + RULER / 2); } }
  y += RULER;
  // tracks: notes drawn as clips, bar by bar
  const anySolo = p.tracks.some((x) => x.solo);
  p.tracks.forEach((t, ti) => {
    const ty = y + ti * TRACK_H, picked = ti === app.sel.track, color = trackColor(ti), dim = t.mute || (anySolo && !t.solo);
    g.fillStyle = picked ? C.panel : C.bg; g.fillRect(0, ty, w, TRACK_H);
    for (let b = first; b <= last; b++) { const x = Math.round(X(L.start[b])) + 0.5; g.strokeStyle = C.line; g.globalAlpha = 0.7; g.beginPath(); g.moveTo(x, ty); g.lineTo(x, ty + TRACK_H); g.stroke(); g.globalAlpha = 1; }
    const used = new Set(); for (const n of t.notes) if (n[0] >= first && n[0] <= last) used.add(n[0]);
    g.fillStyle = color; g.globalAlpha = dim ? 0.07 : 0.16; // a tinted strip under every bar that has notes
    let run = null; for (let b = first; b <= last + 1; b++) { if (used.has(b)) { if (run === null) run = b; } else if (run !== null) { roundRect(X(L.start[run]) + 1, ty + 3, X(L.start[b]) - X(L.start[run]) - 2, TRACK_H - 7, 4); g.fill(); run = null; } }
    let lo = 127, hi = 0; for (const n of t.notes) { if (n[3] < lo) lo = n[3]; if (n[3] > hi) hi = n[3]; } if (hi - lo < 8) { lo -= 4; hi += 4; }
    g.globalAlpha = dim ? 0.3 : 1;
    for (const n of t.notes) { if (n[0] < first || n[0] > last) continue; g.fillRect(X(L.start[n[0]] + n[1]), ty + 7 + (TRACK_H - 18) * (1 - (n[3] - lo) / (hi - lo)), Math.max(2, n[2] * app.view.ppb - 1), 2.5); }
    g.globalAlpha = 1;
    const sb = app.sel.bars; if (sb && (sb.all || picked)) { g.fillStyle = C.sel; g.globalAlpha = 0.18; g.fillRect(X(L.start[sb.a]), ty, X(L.start[sb.b + 1]) - X(L.start[sb.a]), TRACK_H); g.globalAlpha = 1; g.strokeStyle = C.sel; g.strokeRect(X(L.start[sb.a]) + 0.5, ty + 0.5, X(L.start[sb.b + 1]) - X(L.start[sb.a]) - 1, TRACK_H - 1); }
    g.strokeStyle = C.line; g.beginPath(); g.moveTo(0, ty + TRACK_H + 0.5); g.lineTo(w, ty + TRACK_H + 0.5); g.stroke();
  });
  const end = X(L.total); if (end < w) { g.fillStyle = C.bg; g.globalAlpha = 0.75; g.fillRect(end, 0, w - end, h); g.globalAlpha = 1; g.fillStyle = C.muted; g.fillRect(end - 1, 0, 2, h); }
  const ph = X(transport.beat()); g.fillStyle = css("--hot"); g.fillRect(ph - 0.75, LANES_H, 1.5, h - LANES_H); g.beginPath(); g.moveTo(ph - 5, LANES_H); g.lineTo(ph + 5, LANES_H); g.lineTo(ph, LANES_H + 7); g.fill();
}

function zone(yy) { // which part of the view a y coordinate is in
  let top = 0;
  for (const [lane, lh] of LANES) { if (yy < top + lh) return { lane }; top += lh; }
  if (yy < top + RULER) return { ruler: true };
  const ti = Math.floor((yy - top - RULER) / TRACK_H);
  return ti >= 0 && ti < app.project.tracks.length ? { track: ti } : {};
}
function edgeOf(lane, x) { // a block edge near x
  const L = app.L;
  if (lane === "chords") { const list = app.project.progression; for (let i = 0; i < list.length; i++) { const [a, b] = chordSpan(list[i]); if (Math.abs(X(b) - x) <= 4) return { chord: i, side: "end" }; if (Math.abs(X(a) - x) <= 4) return { chord: i, side: "start" }; } return null; }
  const list = app.project[lane];
  for (let i = 1; i < list.length; i++) if (Math.abs(X(L.start[list[i].bar]) - x) <= 5) return { index: i };
  if (Math.abs(X(L.total) - x) <= 5) return { end: true };
  return null;
}
const nearestBarLine = (beat) => { const L = app.L;
  if (beat >= L.total) return L.n + Math.round((beat - L.total) / L.beats[L.n - 1]); // past the end: count on in bars like the last one
  const b = barAt(L, beat); return beat - L.start[b] > (L.start[b + 1] - L.start[b]) / 2 ? b + 1 : b; };

/** Stamp a picked-up pattern onto a track from an absolute beat. */
export function stampAt(track, beat) {
  const L = app.L, s = app.stamp; if (!s) return; begin(); const first = track.notes.length;
  for (const n of s.notes) { const at = beat + n[0]; if (at < L.total - 1e-6) track.notes.push([...place(at, L), n[1], n[2], n[3]]); }
  app.sel.notes = new Set(track.notes.slice(first).map((_, k) => first + k)); app.sel.bars = null; commit();
}

export function mount(el, { menu } = {}) {
  canvas = el; g = canvas.getContext("2d"); onMenu = menu;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return; const [x, y] = pos(e), z = zone(y), L = app.L, beat = Math.max(0, Math.min(beatAt(x), L.total - 1e-6)), bar = barAt(L, beat);
    canvas.setPointerCapture(e.pointerId);
    if (z.lane === "chords") {
      const edge = edgeOf("chords", x), list = app.project.progression, hit = list.findIndex((c) => { const [a, b] = chordSpan(c); return beat >= a && beat < b; });
      app.sel.bars = null; app.sel.notes = new Set();
      if (edge && !app.brush) { app.sel.block = { lane: "chords", index: edge.chord }; drag = { kind: "chord", ...edge }; }
      else if (app.brush) { const start = snapDown(beat, 1); drag = { kind: "lay", start, len: 1, chord: { pitches: app.brush.slice() } }; begin(); setChord(app.project, start, 1, drag.chord); app.sel.block = null; touch(); }
      else app.sel.block = hit >= 0 ? { lane: "chords", index: hit } : null;
      emit("selection");
    } else if (z.lane) {
      const edge = edgeOf(z.lane, x);
      if (edge) { drag = { kind: "edge", lane: z.lane, ...edge }; if (edge.index) app.sel.block = { lane: z.lane, index: edge.index }; }
      else { app.sel.block = { lane: z.lane, index: app.project[z.lane].findLastIndex((b2) => b2.bar <= bar) }; app.sel.bars = null; app.sel.notes = new Set(); }
      emit("selection");
    } else if (z.ruler) { app.playhead = snapDown(beat, app.view.snap); drag = { kind: "loop", x, bar }; emit("selection"); }
    else if (z.track !== undefined) {
      selectTrack(z.track); app.sel.block = null; app.sel.notes = new Set();
      if (app.stamp && (app.stamp.kind === "drums") === (app.project.tracks[z.track].kind === "drums")) { stampAt(app.project.tracks[z.track], L.start[bar]); return; }
      app.playhead = snapDown(beat, app.view.snap); app.sel.bars = { a: bar, b: bar, all: e.shiftKey }; drag = { kind: "bars", bar, x }; emit("selection");
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    const [x, y] = pos(e), L = app.L;
    if (!drag) { const z = zone(y); canvas.style.cursor = z.lane && edgeOf(z.lane, x) ? "ew-resize" : z.lane === "chords" && app.brush ? "copy" : z.ruler ? "text" : "default"; return; }
    const beat = Math.max(0, beatAt(x));
    if (drag.kind === "edge") {
      begin(); const line = nearestBarLine(Math.min(beat, L.total + 64));
      if (drag.end) setLength(app.project, Math.max(1, Math.min(line, 999))); else moveStart(app.project[drag.lane], drag.index, line, app.project.bars);
      if (drag.lane === "signature") prune(app.project);
      touch();
    } else if (drag.kind === "chord") { // resize one chord block, kept clear of its neighbours
      begin(); const list = app.project.progression, c = list[drag.chord], [a, b] = chordSpan(c), step = Math.max(app.view.snap, 0.25), to = snapTo(Math.min(beat, L.total), step);
      const prevEnd = Math.max(0, ...list.filter((_, i) => i !== drag.chord).map((o) => chordSpan(o)[1]).filter((v) => v <= a + 1e-6)), nextStart = Math.min(L.total, ...list.filter((_, i) => i !== drag.chord).map((o) => chordSpan(o)[0]).filter((v) => v >= b - 1e-6));
      if (drag.side === "end") c.len = round(Math.max(step, Math.min(to, nextStart) - a)); else { const na = Math.max(prevEnd, Math.min(to, b - step)); [c.bar, c.pos] = place(na, L); c.len = round(b - na); }
      touch();
    } else if (drag.kind === "lay") { const len = Math.max(1, snapTo(beat - drag.start, 1)); if (len !== drag.len) { drag.len = len; setChord(app.project, drag.start, len, drag.chord); touch(); } }
    else if (drag.kind === "loop" && Math.abs(x - drag.x) > 4) { const bar = barAt(L, Math.min(beat, L.total - 1e-6)), a = Math.min(drag.bar, bar), b = Math.max(drag.bar, bar); app.loop = { on: true, a: L.start[a], b: L.start[b + 1] }; emit("selection"); }
    else if (drag.kind === "bars") { const bar = barAt(L, Math.min(beat, L.total - 1e-6)); app.sel.bars.a = Math.min(drag.bar, bar); app.sel.bars.b = Math.max(drag.bar, bar); emit("selection"); }
  });
  const end = () => { if (drag && (drag.kind === "edge" || drag.kind === "chord" || drag.kind === "lay")) commit(); drag = null; };
  canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("dblclick", (e) => { // split a block at the bar under the pointer
    const [x, y] = pos(e), z = zone(y); if (!z.lane || z.lane === "chords") return;
    const bar = barAt(app.L, Math.max(0, Math.min(beatAt(x), app.L.total - 1e-6)));
    begin(); const list = app.project[z.lane], index = splitAt(list, bar);
    if (z.lane === "sections" && list[index].name === list[index - 1]?.name) list[index].name = "Part " + (list.length);
    app.sel.block = { lane: z.lane, index }; commit(); emit("focus-block");
  });
  canvas.addEventListener("contextmenu", (e) => { e.preventDefault(); const [x, y] = pos(e), z = zone(y); if (z.track === undefined || !onMenu) return;
    const L = app.L, bar = barAt(L, Math.max(0, Math.min(beatAt(x), L.total - 1e-6))); selectTrack(z.track);
    if (!app.sel.bars || bar < app.sel.bars.a || bar > app.sel.bars.b) app.sel.bars = { a: bar, b: bar, all: false }; app.sel.notes = new Set(); app.sel.block = null; emit("selection"); onMenu({ x: e.clientX, y: e.clientY }); });
}
