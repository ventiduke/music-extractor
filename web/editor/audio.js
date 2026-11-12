// Sound: a sampled instrument library with a synth fallback, a mixer (volume, pan, reverb send,
// meters), the transport, and offline rendering to a WAV file.
import { app, emit, on } from "./app.js";
import { audible, beatAtTime, timeAt } from "./model.js";

// ---------- the library ----------
export const library = { instruments: [], byId: new Map(), ready: false };
const buffers = new Map(); // instrument id -> { state: "loading" | "ready" | "failed", samples: [{pitch, buffer}], promise }

export async function loadLibrary() {
  try {
    const r = await fetch("sounds/library.json"); if (!r.ok) throw new Error("no library");
    const data = await r.json(); library.instruments = data.instruments; library.source = data.source;
    for (const i of data.instruments) library.byId.set(i.id, i);
    library.ready = true;
  } catch (e) { library.ready = false; }
  emit("sounds");
}
export const instrumentsFor = (kind) => library.instruments.filter((i) => i.kind === kind);
export const instrumentState = (id) => (buffers.get(id) || {}).state || "idle";

/** Fetch and decode one instrument (once). Resolves true when it can be played from samples. */
export function loadInstrument(id) {
  const info = library.byId.get(id); if (!info) return Promise.resolve(false);
  const have = buffers.get(id); if (have) return have.promise;
  const entry = { state: "loading", samples: [] };
  entry.promise = (async () => {
    try {
      const ctx = ensure(); if (!ctx) throw new Error("no audio");
      const data = await (await fetch("sounds/" + info.file)).arrayBuffer();
      const sprite = await new Promise((ok, no) => ctx.decodeAudioData(data, ok, no)), sr = sprite.sampleRate, all = sprite.getChannelData(0);
      for (const s of info.samples) { // cut the sprite into one small buffer per sampled note
        const a = Math.floor(s.start * sr), n = Math.min(Math.floor(s.length * sr), all.length - a); if (n <= 0) continue;
        const buffer = ctx.createBuffer(1, n, sr); buffer.copyToChannel(all.subarray(a, a + n), 0); entry.samples.push({ pitch: s.pitch, buffer });
      }
      entry.state = "ready"; emit("sounds"); return true;
    } catch (e) { entry.state = "failed"; emit("sounds"); return false; }
  })();
  buffers.set(id, entry); emit("sounds"); return entry.promise;
}
export function preload(project) { for (const t of project.tracks) loadInstrument(t.instrument); }

// ---------- one audio graph (live, or offline for export) ----------
function impulse(ctx, seconds = 2.4) { // a plain algorithmic room: decaying noise, darker as it fades
  const n = Math.floor(seconds * ctx.sampleRate), buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); let low = 0;
    for (let i = 0; i < n; i++) { const t = i / n, white = Math.random() * 2 - 1; low += (white - low) * (0.55 - 0.45 * t); d[i] = low * Math.pow(1 - t, 2.6) * (i < 400 ? i / 400 : 1); } }
  return buf;
}
class Graph {
  constructor(ctx) {
    this.ctx = ctx; this.tracks = new Map(); this.openHats = new Map();
    this.master = ctx.createGain(); this.master.gain.value = 0.8;
    const limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = -6; limiter.ratio.value = 12; limiter.attack.value = 0.003; limiter.release.value = 0.2;
    this.master.connect(limiter).connect(ctx.destination);
    this.reverb = ctx.createConvolver(); this.reverb.buffer = impulse(ctx); const back = ctx.createGain(); back.gain.value = 0.9; this.reverb.connect(back).connect(this.master);
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate); const d = this.noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    if (ctx.createAnalyser) { this.meter = ctx.createAnalyser(); this.meter.fftSize = 512; limiter.connect(this.meter); }
  }
  /** The mixer strip of a track: input -> volume -> pan -> master, with a send to the reverb. */
  strip(t) {
    let s = this.tracks.get(t.id);
    if (!s) {
      const ctx = this.ctx; s = { input: ctx.createGain(), pan: ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain(), send: ctx.createGain() };
      s.input.connect(s.pan).connect(this.master); s.pan.connect(s.send).connect(this.reverb);
      if (ctx.createAnalyser) { s.meter = ctx.createAnalyser(); s.meter.fftSize = 256; s.pan.connect(s.meter); }
      this.tracks.set(t.id, s);
    }
    s.input.gain.value = t.volume ?? 0.8; if (s.pan.pan) s.pan.pan.value = t.pan ?? 0; s.send.gain.value = t.reverb ?? 0;
    return s;
  }
  /** Play one note of a track at time `when` for `dur` seconds. */
  note(t, pitch, when, dur, vel) {
    const ctx = this.ctx, out = this.strip(t).input, entry = buffers.get(t.instrument), info = library.byId.get(t.instrument);
    if (!entry || entry.state !== "ready" || !entry.samples.length) return this.synth(t.kind === "drums" ? "kit" : info ? info.category : "Keys", pitch, when, dur, vel, out);
    const level = 0.18 + 0.82 * Math.pow(vel, 1.4), g = ctx.createGain(), src = ctx.createBufferSource();
    if (t.kind === "drums") {
      const s = entry.samples.find((x) => x.pitch === pitch) || entry.samples[0]; src.buffer = s.buffer; g.gain.value = level; src.connect(g).connect(out); src.start(when);
      const key = t.id; if (pitch === 42 || pitch === 44) { const open = this.openHats.get(key); if (open) { open.gain.cancelScheduledValues(when); open.gain.setTargetAtTime(0, when, 0.015); } } // a closed hat chokes the open one
      if (pitch === 46) this.openHats.set(key, g); return;
    }
    let s = entry.samples[0]; for (const x of entry.samples) if (Math.abs(x.pitch - pitch) < Math.abs(s.pitch - pitch)) s = x;
    src.buffer = s.buffer; src.playbackRate.value = Math.pow(2, (pitch - s.pitch) / 12);
    const tone = ctx.createBiquadFilter(); tone.type = "lowpass"; tone.frequency.value = 900 + 15000 * vel * vel; // softer notes are darker
    src.connect(tone).connect(g).connect(out);
    const sustained = info.sustained, release = sustained ? 0.22 : 0.16, end = when + Math.max(dur, 0.06);
    if (sustained && info.loop && dur * src.playbackRate.value > info.loop[1]) { src.loop = true; src.loopStart = info.loop[0]; src.loopEnd = Math.min(info.loop[1], s.buffer.duration - 0.05); }
    g.gain.setValueAtTime(0.0001, when); g.gain.linearRampToValueAtTime(level, when + (sustained ? 0.012 : 0.003));
    g.gain.setValueAtTime(level, end); g.gain.setTargetAtTime(0, end, release / 3);
    src.start(when); src.stop(end + release * 2);
  }
  /** Fallback while samples load (or if they cannot): simple oscillators by family. */
  synth(family, pitch, when, dur, vel, out) {
    const ctx = this.ctx, g = ctx.createGain(); g.connect(out); const peak = 0.1 + 0.25 * vel;
    if (family === "kit") {
      if (pitch === 36 || pitch === 41 || pitch === 45 || pitch === 48) { const o = ctx.createOscillator(), f0 = pitch === 36 ? 140 : 120 + (pitch - 41) * 14; o.frequency.setValueAtTime(f0, when); o.frequency.exponentialRampToValueAtTime(f0 / 3, when + 0.12);
        g.gain.setValueAtTime(peak * 2, when); g.gain.exponentialRampToValueAtTime(0.001, when + 0.28); o.connect(g); o.start(when); o.stop(when + 0.3); return; }
      const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), long = pitch === 46 || pitch === 49 || pitch === 51, snare = pitch === 38 || pitch === 39 || pitch === 37;
      src.buffer = this.noise; f.type = snare ? "bandpass" : "highpass"; f.frequency.value = snare ? 1700 : 6500; const len = long ? 0.4 : snare ? 0.15 : 0.05;
      g.gain.setValueAtTime(peak * (snare ? 1.4 : 0.6), when); g.gain.exponentialRampToValueAtTime(0.001, when + len); src.connect(f).connect(g); src.start(when); src.stop(when + len + 0.02); return;
    }
    if (family === "click") { const o = ctx.createOscillator(); o.type = "square"; o.frequency.value = pitch > 80 ? 1760 : 1175; g.gain.setValueAtTime(0.16, when); g.gain.exponentialRampToValueAtTime(0.001, when + 0.04); o.connect(g); o.start(when); o.stop(when + 0.05); return; }
    const f = 440 * Math.pow(2, (pitch - 69) / 12), filter = ctx.createBiquadFilter(); filter.type = "lowpass"; filter.connect(g);
    const struck = family === "Keys" || family === "Guitar" || family === "Bass", o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    o1.type = struck ? "triangle" : "sawtooth"; o2.type = "sawtooth"; o1.frequency.value = f; o2.frequency.value = f; o2.detune.value = struck ? 0 : 9; o1.connect(filter); o2.connect(filter);
    const end = when + Math.max(dur, 0.1);
    if (struck) { filter.frequency.setValueAtTime(family === "Bass" ? 700 : 3000, when); filter.frequency.exponentialRampToValueAtTime(family === "Bass" ? 250 : 700, when + 0.5);
      g.gain.setValueAtTime(0.0001, when); g.gain.linearRampToValueAtTime(peak * 0.7, when + 0.004); g.gain.exponentialRampToValueAtTime(peak * 0.1, when + Math.min(dur + 0.06, 2)); g.gain.linearRampToValueAtTime(0.0001, end + 0.08); }
    else { filter.frequency.value = 1400; g.gain.setValueAtTime(0.0001, when); g.gain.linearRampToValueAtTime(peak * 0.4, when + 0.06); g.gain.setValueAtTime(peak * 0.4, end); g.gain.linearRampToValueAtTime(0.0001, end + 0.25); }
    for (const o of [o1, o2]) { o.start(when); o.stop(end + 0.3); }
  }
}

let ctx = null, live = null;
export function ensure() {
  if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; ctx = new AC({ latencyHint: "interactive" }); live = new Graph(ctx); }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}
export const audioContext = () => ensure();
/** Push a track's volume, pan and reverb to the mixer straight away. */
export function syncMixer() { if (live && app.project) for (const t of app.project.tracks) live.strip(t); }
/** Peak level (0..1) of a track or of the whole mix, for meters. */
export function level(trackId) {
  if (!live) return 0; const m = trackId ? (live.tracks.get(trackId) || {}).meter : live.meter; if (!m) return 0;
  const data = new Float32Array(m.fftSize); m.getFloatTimeDomainData(data); let peak = 0; for (const v of data) { const a = Math.abs(v); if (a > peak) peak = a; } return Math.min(1, peak);
}
/** Play pitches now on a track's sound (auditioning). */
export function hear(t, pitches, dur = 0.5) {
  if (!ensure() || !t) return; loadInstrument(t.instrument); const when = ctx.currentTime + 0.01;
  pitches.forEach((p, i) => live.note(t, p, when + (t.kind === "drums" ? 0 : i * 0.008), dur, 0.8));
}

function eventsOf(project, L, metronome) { // every note as [time, seconds, pitch, velocity, track id]
  const ev = [];
  for (const t of project.tracks) for (const n of t.notes) { if (n[0] >= L.n) continue; const spb = 60 / L.bpm[n[0]]; ev.push([L.time[n[0]] + n[1] * spb, n[2] * spb, n[3], n[4], t.id]); }
  if (metronome) for (let b = 0; b < L.n; b++) for (let k = 0; k < L.beats[b]; k++) ev.push([L.time[b] + k * 60 / L.bpm[b], 0.05, k === 0 ? 90 : 60, 1, "click"]);
  return ev.sort((x, y) => x[0] - y[0]);
}

export const transport = {
  playing: false, metronome: false, events: [], next: 0, origins: [], timer: null,
  build() { this.events = eventsOf(app.project, app.L, this.metronome); },
  seek(t) { this.next = this.events.findIndex((e) => e[0] >= t - 1e-6); if (this.next < 0) this.next = this.events.length; },
  now() { let origin = this.origins[0].origin; for (const o of this.origins) if (o.from <= ctx.currentTime) origin = o.origin; return ctx.currentTime - origin; },
  beat() { return this.playing ? beatAtTime(app.L, Math.max(0, this.now())) : app.playhead; },
  start() {
    if (!ensure() || this.playing) return;
    const L = app.L, lp = app.loop; let from = app.playhead >= L.total - 1e-6 ? 0 : app.playhead;
    if (lp.on && lp.b > lp.a && (from < lp.a || from >= lp.b)) from = lp.a;
    preload(app.project); syncMixer(); this.build(); const t0 = timeAt(L, from); this.seek(t0);
    this.origins = [{ from: 0, origin: ctx.currentTime + 0.08 - t0 }];
    this.playing = true; this.timer = setInterval(() => this.pump(), 25); this.pump(); emit("transport");
  },
  pump() {
    if (!this.playing) return;
    const L = app.L, lp = app.loop, looping = lp.on && lp.b > lp.a, tracks = new Map(audible(app.project).map((t) => [t.id, t]));
    let origin = this.origins[this.origins.length - 1].origin;
    for (let guard = 0; guard < 64; guard++) {
      const horizon = ctx.currentTime + 0.18 - origin, stopAt = looping ? timeAt(L, lp.b) : Infinity;
      while (this.next < this.events.length && this.events[this.next][0] < Math.min(horizon, stopAt)) {
        const e = this.events[this.next++], when = Math.max(origin + e[0], ctx.currentTime);
        if (e[4] === "click") live.synth("click", e[2], when, e[1], 1, live.master); else { const t = tracks.get(e[4]); if (t) live.note(t, e[2], when, e[1], e[3]); }
      }
      if (looping && horizon >= stopAt) { const startAt = timeAt(L, lp.a); origin += stopAt - startAt; this.origins.push({ from: origin + startAt, origin }); if (this.origins.length > 8) this.origins.shift(); this.seek(startAt); continue; }
      break;
    }
    if (!looping && this.now() > L.time[L.n] + 0.4) { this.stop(); app.playhead = 0; emit("transport"); }
  },
  stop() { if (!this.playing) return; app.playhead = Math.min(this.beat(), app.L.total); clearInterval(this.timer); this.playing = false; emit("transport"); },
  toggle() { if (this.playing) this.stop(); else this.start(); },
};
// Edits made while playing are heard straight away; mixer moves apply at once.
on((what) => { if (what !== "project") return; syncMixer(); if (transport.playing) { const t = transport.now(); transport.build(); transport.seek(t + 0.18); } });

// ---------- export ----------
/** Render the whole song (what is audible now) to an AudioBuffer, faster than real time. */
export async function renderSong(project, L) {
  if (!ensure()) throw new Error("no audio");
  const tracks = audible(project); await Promise.all(tracks.map((t) => loadInstrument(t.instrument)));
  const seconds = L.time[L.n] + 3, off = new OfflineAudioContext(2, Math.ceil(seconds * 44100), 44100), graph = new Graph(off), byId = new Map(tracks.map((t) => [t.id, t]));
  for (const e of eventsOf(project, L, false)) { const t = byId.get(e[4]); if (t) graph.note(t, e[2], e[0] + 0.05, e[1], e[3]); }
  return off.startRendering();
}
export function toWav(buffer) { // 16-bit stereo PCM
  const n = buffer.length, ch = Math.min(2, buffer.numberOfChannels), out = new DataView(new ArrayBuffer(44 + n * ch * 2)), text = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  text(0, "RIFF"); out.setUint32(4, 36 + n * ch * 2, true); text(8, "WAVEfmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, buffer.sampleRate, true); out.setUint32(28, buffer.sampleRate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); text(36, "data"); out.setUint32(40, n * ch * 2, true);
  const data = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c)); let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, data[c][i])); out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
  return new Uint8Array(out.buffer);
}

/** Play a short run of notes now, [offset in beats, length, pitch, velocity], at a tempo (auditioning a pattern). */
export function playNotes(t, notes, bpm = 110) {
  if (!ensure() || !t) return; loadInstrument(t.instrument); const when = ctx.currentTime + 0.03, spb = 60 / bpm;
  for (const n of notes.slice(0, 400)) live.note(t, n[2], when + n[0] * spb, n[1] * spb, n[3]);
}
