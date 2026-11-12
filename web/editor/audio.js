// Sound: a small built-in synth and the transport. For judging notes and timing, not tone.
import { app, emit, on } from "./app.js";
import { audible, beatAtTime, timeAt } from "./model.js";

let ctx = null, master = null, noise = null;
export function ensure() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    ctx = new AC(); master = ctx.createGain(); master.gain.value = 0.7;
    master.connect(ctx.createDynamicsCompressor()).connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

function drum(pitch, when, g, peak) {
  const tone = (f0, f1, len, level) => { const o = ctx.createOscillator(); o.frequency.setValueAtTime(f0, when); o.frequency.exponentialRampToValueAtTime(f1, when + len * 0.5);
    g.gain.setValueAtTime(peak * level, when); g.gain.exponentialRampToValueAtTime(0.001, when + len); o.connect(g); o.start(when); o.stop(when + len + 0.02); };
  const hiss = (type, freq, len, level) => { const s = ctx.createBufferSource(); s.buffer = noise; const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    g.gain.setValueAtTime(peak * level, when); g.gain.exponentialRampToValueAtTime(0.001, when + len); s.connect(f).connect(g); s.start(when); s.stop(when + len + 0.02); };
  if (pitch === 36) tone(140, 45, 0.28, 2.2);
  else if (pitch === 45) tone(190, 95, 0.3, 1.6);
  else if (pitch === 38) hiss("bandpass", 1800, 0.16, 1.5);
  else if (pitch === 39) hiss("bandpass", 1200, 0.1, 1.4);
  else if (pitch === 46) hiss("highpass", 6500, 0.32, 0.6);
  else if (pitch === 49) hiss("highpass", 4500, 0.9, 0.7);
  else hiss("highpass", 7000, 0.05, 0.7);
}

/** Schedule one note. `vol` is the track volume. */
export function voice(instrument, pitch, when, dur, vel, vol) {
  const g = ctx.createGain(), out = ctx.createGain(); out.gain.value = vol; g.connect(out).connect(master);
  const peak = 0.12 + 0.3 * vel;
  if (instrument === "kit") return drum(pitch, when, g, peak);
  if (instrument === "click") { const o = ctx.createOscillator(); o.type = "square"; o.frequency.value = pitch > 80 ? 1760 : 1175; g.gain.setValueAtTime(0.18, when); g.gain.exponentialRampToValueAtTime(0.001, when + 0.04); o.connect(g); o.start(when); o.stop(when + 0.05); return; }
  const f = 440 * Math.pow(2, (pitch - 69) / 12), filter = ctx.createBiquadFilter(); filter.type = "lowpass"; filter.connect(g);
  const osc = (type, detune = 0, mult = 1, level = 1) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f * mult; o.detune.value = detune;
    if (level === 1) o.connect(filter); else { const lg = ctx.createGain(); lg.gain.value = level; o.connect(lg).connect(filter); } return o; };
  let nodes, end;
  const held = (level, attack, release) => { end = when + dur + release; g.gain.setValueAtTime(0.0001, when); g.gain.linearRampToValueAtTime(peak * level, when + attack);
    g.gain.setValueAtTime(peak * level, when + Math.max(dur, attack + 0.01)); g.gain.linearRampToValueAtTime(0.0001, end); };
  if (instrument === "pad") { nodes = [osc("sawtooth", -7), osc("sawtooth", 7)]; filter.frequency.value = 1100; held(0.5, 0.12, 0.35); }
  else if (instrument === "lead") { nodes = [osc("square")]; filter.frequency.value = 1900; held(0.45, 0.01, 0.06); }
  else if (instrument === "organ") { nodes = [osc("sine"), osc("sine", 0, 2, 0.5), osc("sine", 0, 3, 0.3)]; filter.frequency.value = 4000; held(0.6, 0.015, 0.08); }
  else { // pluck, keys, bass: struck and decaying
    const bass = instrument === "bass";
    nodes = instrument === "keys" ? [osc("triangle"), osc("sine", 0, 2, 0.4)] : bass ? [osc("sine"), osc("sawtooth", 0, 1, 0.5)] : [osc("sawtooth"), osc("triangle")];
    filter.frequency.setValueAtTime(bass ? 700 : instrument === "keys" ? 2600 : 3200, when); filter.frequency.exponentialRampToValueAtTime(bass ? 260 : 700, when + 0.5);
    end = when + Math.max(dur, 0.12) + 0.08; const ring = Math.min(dur + 0.06, bass ? 1.6 : 2.2);
    g.gain.setValueAtTime(0.0001, when); g.gain.linearRampToValueAtTime(peak * (bass ? 1.3 : 0.8), when + 0.004);
    g.gain.exponentialRampToValueAtTime(peak * 0.12, when + ring); g.gain.linearRampToValueAtTime(0.0001, end);
  }
  for (const n of nodes) { n.start(when); n.stop(end + 0.02); }
}

/** Play pitches now on a track's sound (auditioning). */
export function hear(t, pitches, dur = 0.5) {
  if (!ensure() || !t) return; const when = ctx.currentTime + 0.01;
  pitches.forEach((p, i) => voice(t.instrument, p, when + (t.kind === "drums" ? 0 : i * 0.01), dur, 0.8, t.volume));
}

export const transport = {
  playing: false, metronome: false, events: [], next: 0, origins: [], timer: null,
  build() { // every note as [time, duration, pitch, velocity, track id]
    const L = app.L, ev = [];
    for (const t of app.project.tracks) for (const n of t.notes) { if (n[0] >= L.n) continue; const spb = 60 / L.bpm[n[0]]; ev.push([L.time[n[0]] + n[1] * spb, n[2] * spb, n[3], n[4], t.id]); }
    if (this.metronome) for (let b = 0; b < L.n; b++) for (let k = 0; k < L.beats[b]; k++) ev.push([L.time[b] + k * 60 / L.bpm[b], 0.05, k === 0 ? 90 : 60, 1, "click"]);
    ev.sort((x, y) => x[0] - y[0]); this.events = ev;
  },
  seek(t) { this.next = this.events.findIndex((e) => e[0] >= t - 1e-6); if (this.next < 0) this.next = this.events.length; },
  now() { let origin = this.origins[0].origin; for (const o of this.origins) if (o.from <= ctx.currentTime) origin = o.origin; return ctx.currentTime - origin; },
  beat() { return this.playing ? beatAtTime(app.L, Math.max(0, this.now())) : app.playhead; },
  start() {
    if (!ensure() || this.playing) return;
    const L = app.L, lp = app.loop; let from = app.playhead >= L.total - 1e-6 ? 0 : app.playhead;
    if (lp.on && lp.b > lp.a && (from < lp.a || from >= lp.b)) from = lp.a;
    this.build(); const t0 = timeAt(L, from); this.seek(t0);
    this.origins = [{ from: 0, origin: ctx.currentTime + 0.06 - t0 }];
    this.playing = true; this.timer = setInterval(() => this.pump(), 30); this.pump(); emit("transport");
  },
  pump() {
    if (!this.playing) return;
    const L = app.L, lp = app.loop, looping = lp.on && lp.b > lp.a, tracks = new Map(audible(app.project).map((t) => [t.id, t]));
    let origin = this.origins[this.origins.length - 1].origin;
    for (let guard = 0; guard < 64; guard++) {
      const horizon = ctx.currentTime + 0.2 - origin, stopAt = looping ? timeAt(L, lp.b) : Infinity;
      while (this.next < this.events.length && this.events[this.next][0] < Math.min(horizon, stopAt)) {
        const e = this.events[this.next++], t = e[4] === "click" ? { instrument: "click", volume: 0.8 } : tracks.get(e[4]);
        if (t) voice(t.instrument, e[2], Math.max(origin + e[0], ctx.currentTime), e[1], e[3], t.volume);
      }
      if (looping && horizon >= stopAt) { const startAt = timeAt(L, lp.a); origin += stopAt - startAt; this.origins.push({ from: origin + startAt, origin }); if (this.origins.length > 8) this.origins.shift(); this.seek(startAt); continue; }
      break;
    }
    if (!looping && this.now() > L.time[L.n] + 0.25) { this.stop(); app.playhead = 0; emit("transport"); }
  },
  stop() { if (!this.playing) return; app.playhead = Math.min(this.beat(), app.L.total); clearInterval(this.timer); this.playing = false; emit("transport"); },
  toggle() { if (this.playing) this.stop(); else this.start(); },
};
// Edits made while playing are heard on the next pass of the scheduler.
on((what) => { if (what === "project" && transport.playing) { const t = transport.now(); transport.build(); transport.seek(t + 0.2); } });
