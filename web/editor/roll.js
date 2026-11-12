// The piano roll for the chosen track: draw, select, drag to move or re-pitch, drag an edge to resize.
import { app, begin, commit, emit, scalePcs, touch, track } from "./app.js";
import { hear, transport } from "./audio.js";
import { css, trackColor } from "./arrange.js";
import { DRUM_ROWS, absOf, barAt, intoScale, noteName, place, round, snapDown, snapTo } from "./model.js";

export const TOP = 96, BOTTOM = 24; // highest and lowest pitch shown (C7 .. C1)
let canvas, keys, g, kg, drag = null;
const isDrums = () => track().kind === "drums";
export const rowH = () => (isDrums() ? 30 : 14);
export const rows = () => (isDrums() ? DRUM_ROWS.map((d) => d[0]) : Array.from({ length: TOP - BOTTOM + 1 }, (_, i) => TOP - i));
export const height = () => rows().length * rowH();
const X = (beat) => beat * app.view.ppb - app.view.scrollX;
const beatAt = (x) => (x + app.view.scrollX) / app.view.ppb;
const rowOf = (pitch) => rows().indexOf(pitch);

export function draw() {
  const L = app.L, t = track(), R = rows(), rh = rowH(), w = canvas.clientWidth, h = height(), dpr = window.devicePixelRatio || 1;
  for (const [c, cw] of [[canvas, w], [keys, keys.clientWidth]]) if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(cw * dpr); c.height = Math.round(h * dpr); c.style.height = h + "px"; }
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const C = { line: css("--line"), fg: css("--fg"), muted: css("--muted"), soft: css("--soft"), panel: css("--panel"), sel: css("--sel"), selSoft: css("--sel-soft") };
  const pcs = scalePcs(), drums = isDrums(), black = (p) => [1, 3, 6, 8, 10].includes(p % 12);
  R.forEach((p, i) => { g.fillStyle = drums ? (i % 2 ? C.soft : C.panel) : pcs ? (pcs.has(p % 12) ? css("--scale") : css("--offscale")) : black(p) ? C.soft : C.panel; g.fillRect(0, i * rh, w, rh);
    if (!drums && p % 12 === 0) { g.strokeStyle = C.line; g.beginPath(); g.moveTo(0, (i + 1) * rh + 0.5); g.lineTo(w, (i + 1) * rh + 0.5); g.stroke(); } });
  // grid: bar lines, beats, snap steps
  const first = barAt(L, Math.max(0, beatAt(0))), last = barAt(L, beatAt(w)), step = app.view.snap >= 1 / 8 ? app.view.snap : 0.25;
  for (let b = first; b <= last; b++) {
    if (app.view.ppb * step >= 6) for (let s = step; s < L.beats[b] - 1e-6; s += step) { const whole = Math.abs(s - Math.round(s)) < 1e-6, x = Math.round(X(L.start[b] + s)) + 0.5;
      g.strokeStyle = C.line; g.globalAlpha = whole ? 1 : 0.45; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    else for (let s = 1; s < L.beats[b]; s++) { const x = Math.round(X(L.start[b] + s)) + 0.5; g.strokeStyle = C.line; g.globalAlpha = 0.6; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    g.globalAlpha = 1; g.strokeStyle = C.muted; const x = Math.round(X(L.start[b])) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
  }
  const sb = app.sel.bars; if (sb) { g.fillStyle = C.selSoft; g.globalAlpha = 0.35; g.fillRect(X(L.start[sb.a]), 0, X(L.start[sb.b + 1]) - X(L.start[sb.a]), h); g.globalAlpha = 1; }
  const end = X(L.total); if (end < w) { g.fillStyle = css("--bg"); g.globalAlpha = 0.7; g.fillRect(end, 0, w - end, h); g.globalAlpha = 1; }
  // notes
  const color = trackColor(app.sel.track), selColor = css("--note-sel");
  t.notes.forEach((n, i) => {
    if (n[0] < first - 8 || n[0] > last) return; const ri = rowOf(n[3]); if (ri < 0) return;
    const x = X(absOf(n, L)), wd = Math.max(4, n[2] * app.view.ppb - 1), on = app.sel.notes.has(i);
    g.fillStyle = on ? selColor : color; g.globalAlpha = on ? 1 : 0.5 + 0.5 * n[4]; g.fillRect(x, ri * rh + 1, wd, rh - 2); g.globalAlpha = 1;
    g.strokeStyle = on ? C.fg : C.panel; g.strokeRect(x + 0.5, ri * rh + 1.5, wd - 1, rh - 3);
    if (!drums && wd > 26 && rh >= 13) { g.fillStyle = C.panel; g.font = "9px " + css("--mono"); g.textBaseline = "middle"; g.fillText(noteName(n[3]), x + 3, ri * rh + rh / 2 + 0.5); }
  });
  if (drag && drag.kind === "marquee") { g.strokeStyle = C.sel; g.fillStyle = C.selSoft; g.globalAlpha = 0.4; g.fillRect(drag.x0, drag.y0, drag.x1 - drag.x0, drag.y1 - drag.y0); g.globalAlpha = 1; g.strokeRect(drag.x0 + 0.5, drag.y0 + 0.5, drag.x1 - drag.x0, drag.y1 - drag.y0); }
  const ph = X(transport.beat()); g.fillStyle = css("--head"); g.fillRect(ph - 1, 0, 2, h);
  // the keys column
  const kw = keys.clientWidth; kg.setTransform(dpr, 0, 0, dpr, 0, 0); kg.clearRect(0, 0, kw, h); kg.textBaseline = "middle";
  const heldSet = new Set(app.held);
  R.forEach((p, i) => {
    const yy = i * rh;
    if (drums) { kg.fillStyle = i % 2 ? C.soft : C.panel; kg.fillRect(0, yy, kw, rh); kg.fillStyle = C.fg; kg.font = "12px " + css("--body"); kg.fillText(DRUM_ROWS[i][1], 12, yy + rh / 2); }
    else {
      kg.fillStyle = heldSet.has(p) ? selColor : black(p) ? C.fg : C.panel; kg.fillRect(0, yy, black(p) ? kw * 0.62 : kw, rh);
      if (!black(p)) { kg.strokeStyle = C.line; kg.strokeRect(0.5, yy + 0.5, kw - 1, rh); }
      if (pcs && pcs.has(p % 12)) { kg.fillStyle = C.sel; kg.fillRect(kw - 5, yy + 2, 3, rh - 4); }
      if (p % 12 === 0 || heldSet.has(p)) { kg.fillStyle = black(p) || heldSet.has(p) ? C.panel : C.muted; kg.font = "10px " + css("--mono"); kg.fillText(noteName(p), kw - 34, yy + rh / 2 + 0.5); }
    }
  });
}

function hit(x, y) { // the note under a point, and which part of it
  const L = app.L, t = track(), rh = rowH(), pitch = rows()[Math.floor(y / rh)];
  for (let i = t.notes.length - 1; i >= 0; i--) {
    const n = t.notes[i]; if (n[3] !== pitch || n[0] >= L.n) continue;
    const x0 = X(absOf(n, L)), wd = Math.max(4, n[2] * app.view.ppb - 1); if (x < x0 || x > x0 + wd) continue;
    const grip = Math.min(7, wd / 3); return { index: i, part: isDrums() ? "body" : x > x0 + wd - grip ? "end" : x < x0 + grip ? "start" : "body" };
  }
  return null;
}
function newPitch(pitch) { return isDrums() || !app.scaleLock ? pitch : intoScale(pitch, scalePcs()); }

export function mount(el, keysEl, scroller) {
  canvas = el; keys = keysEl; g = canvas.getContext("2d"); kg = keys.getContext("2d");
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener("contextmenu", (e) => { e.preventDefault(); const [x, y] = pos(e), h2 = hit(x, y); if (h2) { begin(); track().notes.splice(h2.index, 1); app.sel.notes = new Set(); commit(); } });
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return; const [x, y] = pos(e), L = app.L, t = track(), rh = rowH(), R = rows(), ri = Math.floor(y / rh); if (ri < 0 || ri >= R.length) return;
    canvas.setPointerCapture(e.pointerId); app.sel.block = null; app.sel.bars = null;
    const h2 = hit(x, y), beat = Math.max(0, Math.min(beatAt(x), L.total - 1e-6)), snap = app.view.snap;
    if (h2) {
      if (isDrums() && app.view.tool === "draw") { begin(); t.notes.splice(h2.index, 1); app.sel.notes = new Set(); commit(); return; } // click a hit to remove it
      if (e.shiftKey) { if (app.sel.notes.has(h2.index)) app.sel.notes.delete(h2.index); else app.sel.notes.add(h2.index); }
      else if (!app.sel.notes.has(h2.index)) app.sel.notes = new Set([h2.index]);
      hear(t, [t.notes[h2.index][3]], 0.3);
      drag = { kind: h2.part, beat, row: ri, orig: [...app.sel.notes].map((i) => [i, absOf(t.notes[i], L), t.notes[i][2], t.notes[i][3]]), moved: false };
      emit("selection"); return;
    }
    if (app.view.tool === "select") { if (!e.shiftKey) app.sel.notes = new Set(); drag = { kind: "marquee", x0: x, y0: y, x1: x, y1: y, keep: new Set(app.sel.notes) }; emit("selection"); return; }
    // draw: a note, a drum hit, or the picked-up chord
    const start = snapDown(beat, snap), pitches = app.brush && !isDrums() ? app.brush : [newPitch(R[ri])];
    begin(); const [bar, p0] = place(start, L), len = isDrums() ? Math.min(snap, 0.25) : app.view.noteLen, first = t.notes.length;
    for (const p of pitches) t.notes.push([bar, p0, len, p, 0.8]);
    app.sel.notes = new Set(pitches.map((_, k) => first + k)); hear(t, pitches, 0.4);
    drag = { kind: isDrums() ? "none" : "end", beat: start + len, row: ri, orig: pitches.map((p, k) => [first + k, start, len, p]), moved: true, fresh: true, x0: x, start };
    touch();
  });
  canvas.addEventListener("pointermove", (e) => {
    const [x, y] = pos(e), L = app.L, t = track(), snap = app.view.snap;
    if (!drag) { const h2 = hit(x, y); canvas.style.cursor = h2 ? (h2.part === "body" ? "grab" : "ew-resize") : app.view.tool === "draw" ? "crosshair" : "default"; return; }
    if (drag.kind === "marquee") {
      drag.x1 = x; drag.y1 = y; const rh = rowH(), R = rows(), xa = Math.min(drag.x0, x), xb = Math.max(drag.x0, x), ya = Math.min(drag.y0, y), yb = Math.max(drag.y0, y);
      app.sel.notes = new Set(drag.keep);
      t.notes.forEach((n, i) => { const ri = R.indexOf(n[3]); if (ri < 0) return; const nx = X(absOf(n, L)); if (nx < xb && nx + n[2] * app.view.ppb > xa && ri * rh < yb && (ri + 1) * rh > ya) app.sel.notes.add(i); });
      emit("selection"); return;
    }
    if (drag.kind === "none") return;
    if (drag.fresh) { // a new note: a plain click keeps the set length; dragging stretches it out to the pointer
      if (Math.abs(x - drag.x0) < 5) return;
      const len = Math.max(Math.min(snap, 1), snapTo(beatAt(x) - drag.start, snap));
      for (const [i] of drag.orig) if (t.notes[i]) t.notes[i][2] = round(len);
      touch(); return;
    }
    const beat = beatAt(x), dBeat = snapTo(beat - drag.beat, snap), dRow = Math.floor(y / rowH()) - drag.row;
    if (!drag.moved && dBeat === 0 && (drag.kind !== "body" || dRow === 0)) return;
    if (!drag.moved) { begin(); drag.moved = true; }
    const R = rows(); let heard = null;
    for (const [i, a0, len0, pitch0] of drag.orig) {
      const n = t.notes[i]; if (!n) continue;
      if (drag.kind === "body") {
        const [bar, p0] = place(Math.max(0, Math.min(a0 + dBeat, L.total - 1e-3)), L); n[0] = bar; n[1] = p0;
        const ri = Math.max(0, Math.min(R.length - 1, R.indexOf(pitch0) + dRow)), np = isDrums() ? R[ri] : Math.max(BOTTOM, Math.min(TOP, pitch0 - dRow));
        if (np !== n[3]) { n[3] = np; heard = heard || []; heard.push(np); }
      } else if (drag.kind === "end") n[2] = round(Math.max(Math.min(snap, len0), len0 + dBeat));
      else { const na = Math.max(0, Math.min(a0 + dBeat, a0 + len0 - Math.min(snap, len0))); const [bar, p0] = place(na, L); n[0] = bar; n[1] = p0; n[2] = round(a0 + len0 - na); }
    }
    if (heard) hear(t, heard.slice(0, 6), 0.25);
    touch();
  });
  const end = () => {
    if (!drag) return; const d = drag; drag = null;
    if (d.kind === "marquee") { emit("selection"); return; }
    if (d.moved) { if (d.kind === "end" && !isDrums()) { const n = track().notes[d.orig[0][0]]; if (n) app.view.noteLen = n[2]; } commit(); if (d.fresh) emit("selection"); }
  };
  canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("dblclick", (e) => { const [x, y] = pos(e), h2 = hit(x, y); if (h2 && app.view.tool === "select") { begin(); track().notes.splice(h2.index, 1); app.sel.notes = new Set(); commit(); } });
  keys.addEventListener("pointerdown", (e) => { const r = keys.getBoundingClientRect(), p = rows()[Math.floor((e.clientY - r.top) / rowH())]; if (p !== undefined) hear(track(), [p], 0.5); });
  scroller.addEventListener("scroll", () => emit("view"));
}

/** Scroll the roll so the chosen track's notes are in view. */
export function centre(scroller) {
  if (isDrums()) { scroller.scrollTop = 0; return; }
  const t = track(); let lo = 127, hi = 0; for (const n of t.notes) { if (n[3] < lo) lo = n[3]; if (n[3] > hi) hi = n[3]; } if (lo > hi) { lo = 55; hi = 65; }
  scroller.scrollTop = Math.max(0, (TOP - (lo + hi) / 2) * rowH() - scroller.clientHeight / 2);
}
