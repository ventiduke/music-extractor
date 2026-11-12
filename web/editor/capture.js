// From a recording to a song, all in the browser: record or choose audio, find the notes,
// tap the beat, and build the song (tempo, signature, chords, scales, starter parts).
import { buildProject } from "./analysis/pipeline.js";
import { audioContext } from "./audio.js";
import { btn, dialog, el, icon, toast } from "./ui.js";

const RATE = 22050; // what the note model expects
const MIDI = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Decode any audio the browser can read into mono samples at 22.05 kHz, peak-normalised. */
export async function decode(blob) {
  const ctx = audioContext(), raw = await ctx.decodeAudioData(await blob.arrayBuffer());
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(raw.duration * RATE)), RATE), src = off.createBufferSource();
  src.buffer = raw; src.connect(off.destination); src.start(); const out = await off.startRendering(), data = out.getChannelData(0);
  let peak = 0; for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
  if (peak > 0) for (let i = 0; i < data.length; i++) data[i] = data[i] / peak * 0.9;
  return out;
}
/** Find the notes in a 22.05 kHz mono buffer with the Basic Pitch model. Returns [{pitch, start, end, velocity}]. */
export async function extractNotes(buffer, onProgress = () => {}) {
  const bp = await import("./vendor/basic-pitch.js"), model = new bp.BasicPitch(new URL("./vendor/basic-pitch-model/model.json", import.meta.url).href);
  const frames = [], onsets = [], contours = [];
  await model.evaluateModel(buffer, (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); }, onProgress);
  // Same thresholds as the Python side: onset 0.5, frame 0.3, notes of at least 7 frames (80 ms), D2 to E6.
  const found = bp.noteFramesToTime(bp.addPitchBendsToNoteEvents(contours, bp.outputToNotesPoly(frames, onsets, 0.5, 0.3, 7, true, MIDI(88.5), MIDI(37.5), true)));
  return found.map((n) => ({ pitch: n.pitchMidi, start: n.startTimeSeconds, end: n.startTimeSeconds + n.durationSeconds, velocity: Math.max(0.05, Math.min(1, n.amplitude)) }))
    .filter((n) => n.end - n.start >= 0.08 && n.pitch >= 38 && n.pitch <= 88).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

function peaksOf(buffer, rate = 60) { const ch = buffer.getChannelData(0), step = Math.floor(buffer.sampleRate / rate), data = new Float32Array(Math.floor(ch.length / step)); let top = 0;
  for (let i = 0; i < data.length; i++) { let m = 0; for (let j = i * step; j < (i + 1) * step; j += 4) { const v = Math.abs(ch[j]); if (v > m) m = v; } data[i] = m; if (m > top) top = m; }
  if (top > 0) for (let i = 0; i < data.length; i++) data[i] = Math.sqrt(data[i] / top); return { rate, data }; }

export function startCapture(adopt) {
  const S = { blob: null, name: "Recording", buffer: null, notes: null, taps: [], perBar: 4, division: 2, shift: 0, url: null };
  const steps = el("div", { className: "steps" }, ["1 Record or choose", "2 Find the notes", "3 Tap the beat", "4 Build"].map((t) => el("span", { textContent: t })));
  const body = el("div", { style: "display:flex; flex-direction:column; gap:12px; min-height:300px" });
  let cleanup = () => {};
  const d = dialog({ title: "New song from a recording", wide: true, body: [steps, body], actions: [{ label: "Cancel", run: () => { cleanup(); if (S.url) URL.revokeObjectURL(S.url); } }] });
  const show = (i, ...kids) => { cleanup(); cleanup = () => {}; [...steps.children].forEach((s, k) => s.classList.toggle("on", k === i)); body.replaceChildren(...kids); };

  function source() {
    const file = el("input", { type: "file", accept: "audio/*,video/mp4,.m4a,.mp3,.wav,.ogg,.webm", hidden: true, on: { change: (e) => { const f = e.target.files[0]; if (f) { S.blob = f; S.name = f.name.replace(/\.[^.]+$/, ""); find(); } } } });
    const status = el("p", { className: "hint", textContent: "Play guitar, or hum, one idea at a time. A phone voice memo works. Nothing leaves this browser." });
    let rec = null, chunks = [], stream = null, started = 0, timer = null;
    const recBtn = btn([icon("mic", 22), "Record now"], async () => {
      if (rec) { rec.stop(); return; }
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
      catch (e) { status.textContent = "The microphone is not available here. Choose an audio file instead."; return; }
      rec = new MediaRecorder(stream); chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); S.blob = new Blob(chunks, { type: rec.mimeType }); S.name = "Recording " + new Date().toLocaleDateString(); rec = null; find(); };
      rec.start(); started = Date.now(); recBtn.replaceChildren(icon("stop", 22), "Stop recording"); recBtn.classList.add("on");
      timer = setInterval(() => { const s = Math.floor((Date.now() - started) / 1000); status.textContent = `Recording… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }, 250);
    });
    cleanup = () => { clearInterval(timer); if (rec && rec.state !== "inactive") { rec.onstop = null; rec.stop(); } if (stream) stream.getTracks().forEach((t) => t.stop()); };
    show(0, el("div", { className: "bigrow" }, [recBtn, btn([icon("file", 22), "Choose an audio file"], () => file.click())]), file, status);
  }

  async function find() {
    const bar = el("div", { className: "progress" }, [el("i")]), status = el("p", { className: "hint", textContent: "Reading the audio…" });
    show(1, status, bar, el("p", { className: "hint", textContent: "This runs on your device. A three-minute recording takes roughly half a minute to a few minutes, depending on the computer." }));
    try {
      S.buffer = await decode(S.blob); S.url = URL.createObjectURL(S.blob);
      status.textContent = `Finding the notes in ${Math.round(S.buffer.duration)} seconds of audio…`;
      S.notes = await extractNotes(S.buffer, (p) => { bar.firstChild.style.width = Math.round(p * 100) + "%"; });
      if (S.notes.length < 4) { status.textContent = "Hardly any notes were found. Try a clearer or louder recording."; body.append(btn("Back", source)); return; }
      tap();
    } catch (e) { status.textContent = "This audio could not be read here. Try a WAV, MP3 or M4A file."; body.append(btn("Back", source)); }
  }

  function tap() {
    const audio = new Audio(S.url), peaks = peaksOf(S.buffer), dur = S.buffer.duration, canvas = el("canvas", { id: "tapStrip" }), g = canvas.getContext("2d"), SPAN = 8, HEAD = 0.3;
    const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), info = el("div", { className: "tag" }), stats = el("p", { className: "hint" });
    const isOne = (i) => (((i - S.shift) % S.perBar) + S.perBar) % S.perBar === 0, firstAfter = (t) => { let i = 0; while (i < S.taps.length && S.taps[i] <= t) i++; return i; };
    let clock = { t: 0, at: performance.now() }, raf = 0, lastClick = -1, drag = null; const sync = () => { clock = { t: audio.currentTime, at: performance.now() }; };
    const now = () => (audio.paused ? audio.currentTime : Math.min(clock.t + (performance.now() - clock.at) / 1000 * audio.playbackRate, dur));
    for (const ev of ["timeupdate", "seeked", "play", "playing"]) audio.addEventListener(ev, sync);
    const playBtn = btn([icon("play"), "Play"], () => { audioContext(); if (audio.paused) audio.play(); else audio.pause(); }, { className: "primary" });
    audio.addEventListener("pause", () => playBtn.replaceChildren(icon("play"), "Play")); audio.addEventListener("playing", () => playBtn.replaceChildren(icon("stop"), "Pause"));
    function describeTaps() {
      const n = S.taps.length; info.textContent = n < 2 ? (n ? "1 tap" : "No taps yet") : `${S.perBar} taps a bar, each in ${S.division === 3 ? "three" : "two"}: ${S.division === 3 ? S.perBar * 3 + "/8" : S.perBar + "/4"}`;
      if (n >= 2) { const gaps = []; for (let i = 1; i < n; i++) gaps.push(S.taps[i] - S.taps[i - 1]); gaps.sort((a, b) => a - b); stats.textContent = `${n} taps · about ${Math.round(60 / gaps[gaps.length >> 1])} a minute · beat 1 is tap ${S.shift + 1}`; } else stats.textContent = "Press Play, then tap along the way your foot would. Skip the silence at the start. Stop tapping in a break and pick it up after.";
      for (const b of perBar.children) b.setAttribute("aria-pressed", String(+b.dataset.v === S.perBar)); for (const b of division.children) b.setAttribute("aria-pressed", String(+b.dataset.v === S.division));
      useBtn.disabled = n < 4;
    }
    function doTap() { if (audio.paused) return; const t = Math.round(now() * 1000) / 1000, i = firstAfter(t); if (i > 0 && t - S.taps[i - 1] < 0.12) return; S.taps.splice(i, 0, t); lastClick = i; describeTaps(); }
    function blip(strong) { const ctx = audioContext(); if (!ctx) return; const o = ctx.createOscillator(), gn = ctx.createGain(), t = ctx.currentTime; o.type = "square"; o.frequency.value = strong ? 1568 : 1046; gn.gain.setValueAtTime(strong ? 0.2 : 0.12, t); gn.gain.exponentialRampToValueAtTime(0.001, t + 0.05); o.connect(gn).connect(ctx.destination); o.start(t); o.stop(t + 0.06); }
    function draw() {
      raf = requestAnimationFrame(draw); const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight; if (!w) return;
      if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h); const t = now(), t0 = t - SPAN * HEAD, t1 = t0 + SPAN, x = (s) => (s - t0) / SPAN * w, waveH = h * 0.42;
      g.fillStyle = cssv("--muted"); g.globalAlpha = 0.6; for (let i = Math.max(0, Math.floor(t0 * peaks.rate)); i < Math.min(peaks.data.length, t1 * peaks.rate); i++) { const a = peaks.data[i] * (waveH / 2 - 2); g.fillRect(x(i / peaks.rate), waveH / 2 + 2 - a, Math.max(1, w / (SPAN * peaks.rate) - 0.5), Math.max(1, 2 * a)); } g.globalAlpha = 1;
      g.fillStyle = cssv("--t0"); for (const n of S.notes) { if (n.end < t0 || n.start > t1) continue; g.fillRect(x(n.start), waveH + 8 + (h - waveH - 26) * (1 - (Math.min(Math.max(n.pitch, 38), 84) - 38) / 46), Math.max(2, x(n.end) - x(n.start) - 1), 3); }
      g.font = "600 11px " + cssv("--mono"); g.textBaseline = "top";
      for (let i = firstAfter(t0); i < S.taps.length && S.taps[i] <= t1; i++) { const one = isOne(i), px = x(S.taps[i]); g.fillStyle = one ? cssv("--accent") : cssv("--hot"); g.fillRect(px - (one ? 1.5 : 0.75), one ? 2 : 14, one ? 3 : 1.5, h - (one ? 4 : 28)); if (one) g.fillText(String(Math.floor((i - S.shift) / S.perBar) + 1), px + 5, 3); }
      g.fillStyle = cssv("--fg"); g.fillRect(w * HEAD - 1, 0, 2, h);
      if (!audio.paused && clickOn) { const i = firstAfter(t) - 1; if (i > lastClick && i >= 0 && t - S.taps[i] < 0.08) blip(isOne(i)); lastClick = Math.max(lastClick, i); }
    }
    canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, t: audio.currentTime }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", (e) => { if (drag) { audio.currentTime = Math.min(Math.max(0, drag.t - (e.clientX - drag.x) / canvas.clientWidth * SPAN), dur - 0.05); sync(); lastClick = firstAfter(audio.currentTime) - 1; } });
    canvas.addEventListener("pointerup", () => { drag = null; });
    let clickOn = true; const seg = (values, key) => { const box = el("span", { className: "seg" }, values.map(([v, text]) => btn(text, () => { S[key] = v; if (key === "perBar") S.shift %= v; describeTaps(); }, { attrs: { "data-v": v } }))); return box; };
    const perBar = seg([[2, "2"], [3, "3"], [4, "4"], [6, "6"]], "perBar"), division = seg([[2, "two"], [3, "three"]], "division");
    const useBtn = btn("Use these taps", () => build(true), { className: "primary" });
    const pad = btn("TAP  (space bar)", () => {}, { id: "tapPad", on: { pointerdown: (e) => { e.preventDefault(); doTap(); } } });
    const onKey = (e) => { if (e.code === "Space" && !e.target.matches("input, select, textarea")) { e.preventDefault(); e.stopPropagation(); if (!e.repeat) doTap(); } };
    document.addEventListener("keydown", onKey, true);
    show(2, el("div", { className: "rowx" }, [playBtn, btn("−5 s", () => { audio.currentTime = Math.max(0, audio.currentTime - 5); sync(); }), btn("Start", () => { audio.currentTime = 0; sync(); lastClick = -1; }),
        btn("Click on taps", (e) => { clickOn = !clickOn; e.currentTarget.setAttribute("aria-pressed", String(clickOn)); }, { attrs: { "aria-pressed": "true" } }),
        el("label", { className: "f" }, ["Speed", (() => { const s = el("select", { on: { change: (e) => { audio.playbackRate = +e.target.value; sync(); } } }, [["1", "1×"], ["0.75", "0.75×"], ["0.5", "0.5×"]].map(([v, t]) => el("option", { value: v, textContent: t }))); return s; })()])]),
      canvas, pad,
      el("div", { className: "rowx" }, [el("label", { className: "f" }, ["Taps in a bar", perBar]), el("label", { className: "f" }, ["Each tap divides in", division]),
        btn("Beat 1 earlier", () => { S.shift = (S.shift - 1 + S.perBar) % S.perBar; describeTaps(); }), btn("Beat 1 later", () => { S.shift = (S.shift + 1) % S.perBar; describeTaps(); }),
        btn("Undo tap", () => { S.taps.pop(); describeTaps(); }), btn("Clear after playhead", () => { S.taps = S.taps.filter((t) => t <= now()); describeTaps(); })]),
      info, stats,
      el("div", { className: "rowx", style: "justify-content:flex-end" }, [btn("Skip: work the beat out for me", () => build(false), { title: "Less reliable, especially when the tempo moves or the rhythm is syncopated" }), useBtn]));
    cleanup = () => { cancelAnimationFrame(raf); audio.pause(); document.removeEventListener("keydown", onKey, true); };
    describeTaps(); draw();
  }

  function build(withTaps) {
    show(3, el("p", { className: "hint", textContent: "Building the song…" }));
    try {
      const id = "rec-" + Date.now().toString(36), opts = { id, title: S.name, duration: S.buffer.duration };
      if (withTaps) Object.assign(opts, { taps: S.taps, beats_per_bar: S.perBar, division: S.division, downbeat_shift: S.shift });
      const project = buildProject(S.notes, opts);
      for (const t of project.tracks) { if (t.id === "guitar") t.instrument = "steel"; }
      if (S.url) URL.revokeObjectURL(S.url); d.close(); adopt(project);
      toast(`${project.title}: ${project.bars} bars, ${project.tracks[0].notes.length} notes. ${withTaps ? "Built from your taps." : "The beat was worked out automatically; check the tempo and bar lines."}`);
    } catch (e) { show(3, el("p", { className: "hint", textContent: "The song could not be built from this recording: " + e.message }), btn("Back to tapping", tap)); }
  }
  source();
}
