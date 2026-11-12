// The Tools menu: generators that follow the chord lane, and transforms on existing notes.
import { addTrack, barRegion, scope } from "./actions.js";
import { app, edit, emit, scalePcs, selectTrack, track } from "./app.js";
import { instrumentsFor, loadInstrument } from "./audio.js";
import * as T from "./tools.js";
import { btn, dialog, el, field, menu, select, toast } from "./ui.js";

const PARTS = {
  bass: { title: "Bass line", sound: "bass", styles: T.BASS_STYLES, style: "pulse", run: (p, t, r, o) => T.bassLine(p, t, r, o.style) },
  pad: { title: "Pad", sound: "pad", run: (p, t, r) => T.padPart(p, t, r) },
  arpeggio: { title: "Arpeggio", sound: "harp", styles: T.ARP_SHAPES, style: "up", run: (p, t, r, o) => T.arpeggio(p, t, r, { shape: o.style, rate: +o.rate, octaves: +o.octaves }) },
  strum: { title: "Strummed chords", sound: "steel", styles: T.STRUM_STYLES, style: "eighths", run: (p, t, r, o) => T.strum(p, t, r, o.style) },
  drums: { title: "Drum part", sound: "kit", styles: T.DRUM_STYLES, style: "rock", drums: true, run: (p, t, r, o) => T.drumPart(p, t, r, { style: o.style, fillEvery: +o.fill }) },
};

function ensureChords(p) { // generators need a chord lane; read one off the first track that has notes
  if (p.progression.length) return true; const src = p.tracks.find((t) => t.kind !== "drums" && t.notes.length); if (src) p.progression = T.detectProgression(p, src.id); return p.progression.length > 0;
}
export function generate(part) {
  const P = PARTS[part], p = app.project, kind = P.drums ? "drums" : "pitched", r = barRegion(), o = { style: P.style, rate: "0.5", octaves: "2", fill: "4", target: "new", sound: P.sound };
  const same = p.tracks.filter((t) => t.kind === kind), likely = same.find((t) => t.name.toLowerCase().includes(part === "arpeggio" ? "arp" : part === "strum" ? "strum" : part)); if (likely) o.target = likely.id;
  const sounds = instrumentsFor(kind).map((i) => [i.id, i.name]), body = [
    el("p", { className: "hint", textContent: P.drums ? "Writes a drum part shaped to each bar's time signature." : "Follows the chord lane. Change the chords there and run this again to follow them." }),
    field("Write to", select([["new", "A new track"], ...same.map((t) => [t.id, `${t.name} (replaces what is there)`])], o.target, (v) => { o.target = v; soundRow.hidden = v !== "new"; }, "Write to")),
  ];
  const soundRow = field("Sound", select(sounds.length ? sounds : [[P.sound, P.sound]], o.sound, (v) => { o.sound = v; }, "Sound")); soundRow.hidden = o.target !== "new"; body.push(soundRow);
  if (P.styles) body.push(field(part === "arpeggio" ? "Shape" : "Style", select(Object.entries(P.styles), o.style, (v) => { o.style = v; }, "Style")));
  if (part === "arpeggio") body.push(field("A note every", select([["1", "beat"], ["0.5", "1/2 beat"], ["0.3333", "1/3 beat"], ["0.25", "1/4 beat"]], o.rate, (v) => { o.rate = v; }, "Rate")), field("Spread over", select([["1", "1 octave"], ["2", "2 octaves"], ["3", "3 octaves"]], o.octaves, (v) => { o.octaves = v; }, "Octaves")));
  if (part === "drums") body.push(field("Fill", select([["0", "never"], ["2", "every 2 bars"], ["4", "every 4 bars"], ["8", "every 8 bars"]], o.fill, (v) => { o.fill = v; }, "Fill")));
  body.push(el("p", { className: "hint", textContent: r ? `Bars ${r.a + 1}–${r.b + 1} (your selection).` : "The whole song. Select bars first to write only there." }));
  dialog({ title: P.title, body, actions: [{ label: "Cancel" }, { label: "Write it", primary: true, run: () => {
    if (!P.drums && !ensureChords(p)) { toast("The chord lane is empty. Pick up a chord and drag it along the Chords lane first.", true); return false; }
    let t = p.tracks.find((x) => x.id === o.target);
    if (!t) t = addTrack(P.drums, { name: P.title.split(" ")[0] === "Strummed" ? "Strum" : P.title.split(" ")[0], instrument: o.sound });
    edit((pp) => P.run(pp, pp.tracks.find((x) => x.id === t.id), r, o)); selectTrack(p.tracks.findIndex((x) => x.id === t.id)); loadInstrument(t.instrument);
    toast(`${P.title} written to ${t.name}.`);
  } }] });
}

function shape(label, fn) { const { scope: sc, text } = scope(), t = track(); edit((p) => fn(p, p.tracks[app.sel.track], sc)); toast(`${label}: ${text} of ${t.name}.`); }
function transposeDialog() {
  let n = 0; const input = el("input", { type: "number", value: 0, min: -48, max: 48, step: 1, on: { change: (e) => { n = Math.round(+e.target.value || 0); } } });
  dialog({ title: "Transpose", body: [field("Semitones (up or down)", input), el("p", { className: "hint", textContent: `Applies to ${scope().text}.` })], actions: [{ label: "Cancel" }, { label: "Move", primary: true, run: () => { n = Math.round(+input.value || 0); if (n) shape("Transposed", (p, t, sc) => T.transpose(p, t, sc, n)); } }] });
}
function harmony(steps, label) {
  const sc = app.scale >= 0 ? app.project.scales[app.scale] : app.project.scales[0];
  if (!sc || !scalePcs()) { toast("Pick a scale in the Scales tab first; the new line stays inside it.", true); return; }
  shape(`${label} added in ${sc.name}`, (p, t, s) => T.harmonize(p, t, s, sc, steps));
}

export function toolsMenu(anchor) {
  const t = track(), drums = t.kind === "drums", snap = app.view.snap;
  menu(anchor, [
    { heading: "Write a part from the chords" },
    { label: "Bass line…", run: () => generate("bass") }, { label: "Pad…", run: () => generate("pad") }, { label: "Arpeggio…", run: () => generate("arpeggio") }, { label: "Strummed chords…", run: () => generate("strum") }, { label: "Drum part…", run: () => generate("drums") },
    "-", { heading: `Shape ${scope().text}` },
    { label: `Snap to the grid (${snap >= 1 ? "beats" : "1/" + Math.round(1 / snap)})`, run: () => shape("Snapped", (p, tr, sc) => T.quantize(p, tr, sc, snap)) },
    { label: "Loosen the timing a little", run: () => shape("Loosened", (p, tr, sc) => T.humanize(p, tr, sc, 0.6, Date.now() % 9973)) },
    { label: "Join notes up", disabled: drums, run: () => shape("Joined", (p, tr, sc) => T.legato(p, tr, sc)) },
    { label: "Octave up", disabled: drums, run: () => shape("Up an octave", (p, tr, sc) => T.transpose(p, tr, sc, 12)) }, { label: "Octave down", disabled: drums, run: () => shape("Down an octave", (p, tr, sc) => T.transpose(p, tr, sc, -12)) },
    { label: "Transpose…", disabled: drums, run: transposeDialog },
    { label: "Add a third above", disabled: drums, run: () => harmony(2, "A third above") }, { label: "Add a third below", disabled: drums, run: () => harmony(-2, "A third below") }, { label: "Add a sixth above", disabled: drums, run: () => harmony(5, "A sixth above") },
    { label: "Double an octave up", disabled: drums, run: () => shape("Doubled", (p, tr, sc) => T.double(p, tr, sc, 12)) },
    { label: "Louder", run: () => shape("Louder", (p, tr, sc) => T.loudness(p, tr, sc, { scale: 1.2 })) }, { label: "Softer", run: () => shape("Softer", (p, tr, sc) => T.loudness(p, tr, sc, { scale: 0.82 })) },
    { label: "Swell (soft to loud)", run: () => shape("Swell", (p, tr, sc) => T.loudness(p, tr, sc, { from: 0.3, to: 1 })) }, { label: "Fade (loud to soft)", run: () => shape("Fade", (p, tr, sc) => T.loudness(p, tr, sc, { from: 1, to: 0.3 })) },
    "-", { heading: "Chord lane" },
    { label: `Read the chords from ${t.name}`, disabled: drums, run: () => { edit((p) => { p.progression = T.detectProgression(p, t.id); }); toast(`Chord lane rebuilt from ${t.name}.`); } },
    { label: "Clear the chord lane", run: () => edit((p) => { p.progression = []; }) },
  ]);
}
export { btn, emit };
