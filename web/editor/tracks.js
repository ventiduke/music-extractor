// Track headers: name, sound, mute, solo, volume, and a level meter.
import { addTrack, duplicateTrack, removeTrack } from "./actions.js";
import { app, begin, commit, edit, selectTrack } from "./app.js";
import { LANES, RULER, TRACK_H, trackColor } from "./arrange.js";
import { hear, instrumentState, instrumentsFor, level, library, loadInstrument, transport } from "./audio.js";
import { toolsMenu } from "./toolbox.js";
import { btn, el, menu, select } from "./ui.js";

const $ = (id) => document.getElementById(id);
let meters = [];
function soundSelect(t) {
  const list = instrumentsFor(t.kind), groups = [...new Set(list.map((i) => i.category))].map((c) => ({ group: c, options: list.filter((i) => i.category === c).map((i) => [i.id, i.name]) }));
  const options = list.some((i) => i.id === t.instrument) || !library.ready ? groups : [...groups, [t.instrument, t.instrument]];
  const s = select(library.ready ? options : [[t.instrument, t.instrument]], t.instrument, (v) => { edit(() => { t.instrument = v; }); loadInstrument(v).then(() => hear(t, [t.kind === "drums" ? 38 : 60])); }, "Sound");
  s.className = "tinst"; s.title = instrumentState(t.instrument) === "loading" ? "Loading this sound…" : "Sound"; return s;
}
export function trackMenu(i, anchor) {
  menu(anchor, [{ label: "Duplicate track", run: () => duplicateTrack(i) }, { label: "Remove track", disabled: app.project.tracks.length < 2, run: () => removeTrack(i) }, "-", { label: "Tools for this track…", run: () => toolsMenu(anchor) }]);
}
export function renderHeaders() {
  const p = app.project, box = $("heads"); box.replaceChildren(); meters = [];
  for (const [, h, name] of LANES) box.append(el("div", { className: "lanehead", textContent: name, style: `height:${h}px` }));
  box.append(el("div", { className: "lanehead", textContent: "Bars", style: `height:${RULER}px` }));
  p.tracks.forEach((t, i) => {
    const name = el("input", { type: "text", value: t.name, className: "tname", attrs: { "aria-label": "Track name" }, on: { change: (e) => edit(() => { t.name = e.target.value.trim() || "Track"; }), pointerdown: () => selectTrack(i) } });
    const vol = el("input", { type: "range", min: 0, max: 1, step: 0.01, value: t.volume, className: "tvol", title: "Volume", attrs: { "aria-label": "Volume" }, on: { pointerdown: begin, input: (e) => { t.volume = +e.target.value; commitLive(); }, change: commit } });
    const meter = el("div", { className: "meter" }, [el("i")]); meters.push([t.id, meter.firstChild]);
    const loading = instrumentState(t.instrument) === "loading";
    box.append(el("div", { className: "thead" + (i === app.sel.track ? " on" : "") + (loading ? " loading" : ""), style: `height:${TRACK_H}px; --c:${trackColor(i)}`,
      on: { pointerdown: (e) => { if (!e.target.closest("input,select,button")) selectTrack(i); }, contextmenu: (e) => { e.preventDefault(); selectTrack(i); trackMenu(i, { x: e.clientX, y: e.clientY }); } } }, [
      el("div", { className: "tmain" }, [
        el("div", { className: "trow" }, [name,
          btn("M", () => edit(() => { t.mute = !t.mute; }), { className: "sq" + (t.mute ? " on" : ""), title: "Mute (M)", attrs: { "aria-pressed": String(!!t.mute) } }),
          btn("S", () => edit(() => { t.solo = !t.solo; }), { className: "sq solo" + (t.solo ? " on" : ""), title: "Solo: hear only this track (S)", attrs: { "aria-pressed": String(!!t.solo) } })]),
        el("div", { className: "trow" }, [soundSelect(t), vol])]),
      meter]));
  });
  box.append(el("div", { className: "addrow" }, [btn("+ Track", () => addTrack(false)), btn("+ Drums", () => addTrack(true))]));
}
function commitLive() { import("./audio.js").then((a) => a.syncMixer()); }
/** Called every frame while playing. */
export function drawMeters() { for (const [id, bar] of meters) { const v = transport.playing ? level(id) : 0, shown = Math.max(v, (parseFloat(bar.dataset.v) || 0) * 0.86); bar.dataset.v = shown; bar.style.height = Math.round(Math.min(1, Math.sqrt(shown)) * 100) + "%"; } }
