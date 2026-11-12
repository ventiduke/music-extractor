// The arrangement: section, tempo and signature lanes made of blocks; the bar ruler; one lane per track.
import { app, begin, commit, emit, selectTrack, touch } from "./app.js";
import { transport } from "./audio.js";
import { barAt, moveStart, prune, setLength, sigText, snapDown, splitAt } from "./model.js";

export const LANES = [["sections", 22, "Sections"], ["tempo", 22, "Tempo"], ["signature", 22, "Signature"]];
export const RULER = 24, TRACK_H = 48;
const LANES_H = LANES.reduce((s, l) => s + l[1], 0);
export const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const trackColor = (i) => css("--t" + (i % 6));

let canvas, g, drag = null;
const X = (beat) => beat * app.view.ppb - app.view.scrollX;
const beatAt = (x) => (x + app.view.scrollX) / app.view.ppb;
const label = (lane, e) => (lane === "tempo" ? `${Math.round(e.bpm * 10) / 10} bpm` : lane === "signature" ? sigText(e) : e.name);

export function height() { return LANES_H + RULER + app.project.tracks.length * TRACK_H; }

export function draw() {
  const p = app.project, L = app.L, w = canvas.clientWidth, h = height(), dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); canvas.style.height = h + "px"; }
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const C = { line: css("--line"), fg: css("--fg"), muted: css("--muted"), soft: css("--soft"), sel: css("--sel"), selSoft: css("--sel-soft"), panel: css("--panel"), bg: css("--bg") };
  const first = barAt(L, Math.max(0, beatAt(0))), last = barAt(L, beatAt(w));
  // lanes of blocks
  let y = 0;
  for (const [lane, lh] of LANES) {
    const list = p[lane];
    list.forEach((e, i) => {
      const x0 = X(L.start[e.bar]), x1 = X(L.start[i + 1 < list.length ? list[i + 1].bar : L.n]); if (x1 < 0 || x0 > w) return;
      const on = app.sel.block && app.sel.block.lane === lane && app.sel.block.index === i;
      g.fillStyle = lane === "sections" ? trackColor(i) : on ? C.selSoft : C.soft; g.globalAlpha = lane === "sections" ? (on ? 1 : 0.8) : 1;
      g.fillRect(x0 + 1, y + 2, x1 - x0 - 2, lh - 4); g.globalAlpha = 1;
      if (on) { g.strokeStyle = C.sel; g.lineWidth = 2; g.strokeRect(x0 + 2, y + 3, x1 - x0 - 4, lh - 6); g.lineWidth = 1; }
      g.fillStyle = lane === "sections" ? C.panel : C.fg; g.font = "600 11px " + css("--body"); g.textBaseline = "middle";
      const tx = Math.max(x0, 0) + 7; if (x1 - tx > 24) g.fillText(label(lane, e), tx, y + lh / 2 + 0.5, x1 - tx - 6);
    });
    g.strokeStyle = C.line; g.beginPath(); g.moveTo(0, y + lh + 0.5); g.lineTo(w, y + lh + 0.5); g.stroke();
    y += lh;
  }
  // ruler
  g.fillStyle = C.panel; g.fillRect(0, y, w, RULER);
  if (app.loop.b > app.loop.a) { g.fillStyle = app.loop.on ? C.sel : C.muted; g.globalAlpha = app.loop.on ? 0.35 : 0.2; g.fillRect(X(app.loop.a), y, X(app.loop.b) - X(app.loop.a), RULER); g.globalAlpha = 1; }
  const every = app.view.ppb * 4 >= 34 ? 1 : app.view.ppb * 4 >= 16 ? 2 : app.view.ppb * 4 >= 8 ? 4 : 8;
  g.font = "600 11px " + css("--mono"); g.textBaseline = "middle";
  for (let b = first; b <= last; b++) {
    const x = Math.round(X(L.start[b])) + 0.5;
    g.strokeStyle = C.muted; g.globalAlpha = 0.6; g.beginPath(); g.moveTo(x, y + (b % every ? 14 : 4)); g.lineTo(x, h); g.stroke(); g.globalAlpha = 1;
    if (b % every === 0) { g.fillStyle = C.muted; g.fillText(String(b + 1), x + 4, y + RULER / 2); }
  }
  y += RULER;
  // tracks
  p.tracks.forEach((t, ti) => {
    const ty = y + ti * TRACK_H, picked = ti === app.sel.track;
    g.fillStyle = picked ? C.panel : C.bg; g.fillRect(0, ty, w, TRACK_H);
    const sb = app.sel.bars;
    if (sb && (sb.all || picked)) { g.fillStyle = C.selSoft; g.fillRect(X(L.start[sb.a]), ty, X(L.start[sb.b + 1]) - X(L.start[sb.a]), TRACK_H); }
    let lo = 127, hi = 0; for (const n of t.notes) { if (n[3] < lo) lo = n[3]; if (n[3] > hi) hi = n[3]; } if (hi - lo < 6) { lo -= 3; hi += 3; }
    const dim = t.mute || (p.tracks.some((x) => x.solo) && !t.solo);
    g.fillStyle = trackColor(ti); g.globalAlpha = dim ? 0.3 : 1;
    for (const n of t.notes) { if (n[0] < first || n[0] > last) continue; g.fillRect(X(L.start[n[0]] + n[1]), ty + 5 + (TRACK_H - 13) * (1 - (n[3] - lo) / (hi - lo)), Math.max(2, n[2] * app.view.ppb - 1), 3); }
    g.globalAlpha = 1; g.strokeStyle = C.line; g.beginPath(); g.moveTo(0, ty + TRACK_H + 0.5); g.lineTo(w, ty + TRACK_H + 0.5); g.stroke();
  });
  const end = X(L.total); if (end < w) { g.fillStyle = C.bg; g.globalAlpha = 0.7; g.fillRect(end, 0, w - end, h); g.globalAlpha = 1; }
  const ph = X(transport.beat()); g.fillStyle = css("--head"); g.fillRect(ph - 1, LANES_H, 2, h - LANES_H);
}

function zone(yy) { // which part of the view a y coordinate is in
  let top = 0;
  for (const [lane, lh] of LANES) { if (yy < top + lh) return { lane }; top += lh; }
  if (yy < top + RULER) return { ruler: true };
  const ti = Math.floor((yy - top - RULER) / TRACK_H);
  return ti < app.project.tracks.length ? { track: ti } : {};
}
function edgeOf(lane, x) { // a block edge near x: {index} means "the start of block index"; {end} means the end of the song
  const list = app.project[lane], L = app.L;
  for (let i = 1; i < list.length; i++) if (Math.abs(X(L.start[list[i].bar]) - x) <= 5) return { index: i };
  if (Math.abs(X(L.total) - x) <= 5) return { end: true };
  return null;
}
const nearestBarLine = (beat) => { const L = app.L;
  if (beat >= L.total) return L.n + Math.round((beat - L.total) / L.beats[L.n - 1]); // past the end: count on in bars like the last one
  const b = barAt(L, beat); return beat - L.start[b] > (L.start[b + 1] - L.start[b]) / 2 ? b + 1 : b; };

export function mount(el) {
  canvas = el; g = canvas.getContext("2d");
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return; const [x, y] = pos(e), z = zone(y), L = app.L, beat = Math.max(0, Math.min(beatAt(x), L.total - 1e-6)), bar = barAt(L, beat);
    canvas.setPointerCapture(e.pointerId);
    if (z.lane) {
      const edge = edgeOf(z.lane, x);
      if (edge) { drag = { kind: "edge", lane: z.lane, ...edge }; if (edge.index) app.sel.block = { lane: z.lane, index: edge.index }; }
      else { app.sel.block = { lane: z.lane, index: app.project[z.lane].findLastIndex((b2) => b2.bar <= bar) }; app.sel.bars = null; app.sel.notes = new Set(); }
      emit("selection");
    } else if (z.ruler) { app.playhead = snapDown(beat, app.view.snap); drag = { kind: "loop", x, bar }; emit("selection"); }
    else if (z.track !== undefined) {
      selectTrack(z.track); app.playhead = snapDown(beat, app.view.snap); app.sel.block = null; app.sel.notes = new Set();
      app.sel.bars = { a: bar, b: bar, all: e.shiftKey }; drag = { kind: "bars", bar, x }; emit("selection");
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    const [x, y] = pos(e), L = app.L;
    if (!drag) { const z = zone(y); canvas.style.cursor = z.lane && edgeOf(z.lane, x) ? "ew-resize" : z.ruler ? "text" : "default"; return; }
    const beat = Math.max(0, beatAt(x));
    if (drag.kind === "edge") {
      begin(); const line = nearestBarLine(Math.min(beat, L.total + 64));
      if (drag.end) setLength(app.project, Math.max(1, Math.min(line, 999))); else moveStart(app.project[drag.lane], drag.index, line, app.project.bars);
      if (drag.lane === "signature") prune(app.project);
      touch();
    } else if (drag.kind === "loop" && Math.abs(x - drag.x) > 4) {
      const bar = barAt(L, Math.min(beat, L.total - 1e-6)), a = Math.min(drag.bar, bar), b = Math.max(drag.bar, bar);
      app.loop = { on: true, a: L.start[a], b: L.start[b + 1] }; emit("selection");
    } else if (drag.kind === "bars") {
      const bar = barAt(L, Math.min(beat, L.total - 1e-6)); app.sel.bars.a = Math.min(drag.bar, bar); app.sel.bars.b = Math.max(drag.bar, bar); emit("selection");
    }
  });
  const end = () => { if (drag && drag.kind === "edge") commit(); drag = null; };
  canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("dblclick", (e) => { // split a block at the bar under the pointer
    const [x, y] = pos(e), z = zone(y); if (!z.lane) return;
    const bar = barAt(app.L, Math.max(0, Math.min(beatAt(x), app.L.total - 1e-6)));
    begin(); const list = app.project[z.lane], index = splitAt(list, bar);
    if (z.lane === "sections" && list[index].name === list[index - 1]?.name) list[index].name = "Part " + (list.length);
    app.sel.block = { lane: z.lane, index }; commit(); emit("focus-block");
  });
}
