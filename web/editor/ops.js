// The edit language: a small set of JSON operations that change a song.
// The in-app assistant, a pasted reply from any chat, and the Claude skill's command line all speak it.
// Bars and beats are 1-based here (bar 1, beat 1), the way people and models count.
import * as M from "./model.js";
import * as T from "./tools.js";

export const GUIDE = `Reply with a JSON array of operations (and nothing that is not JSON inside the code block). Bars and beats count from 1. "bars" is [first, last] inclusive, a single bar number, or left out for the whole song. A beat is what you would tap; in 6/8 a bar has 2 beats, each dividing in 3, so beat positions run 1, 1.3333, 1.6667, 2 ...
Pitches are note names like "E2", "C#4", "Bb3" (middle C is C4) or MIDI numbers. Velocity is 0-1. Tracks are named by their name or id.

Operations:
{"op":"set_title","title":"..."}
{"op":"set_tempo","bpm":96,"bars":[9,16]}
{"op":"set_signature","beats":3,"division":2,"bars":[17,24]}        division 2 = straight, 3 = triplet feel (beats 2 + division 3 is 6/8)
{"op":"set_section","bar":9,"name":"Chorus"}                        starts or renames a section at that bar
{"op":"insert_bars","after":8,"count":4}   {"op":"delete_bars","bars":[5,8]}   {"op":"repeat_bars","bars":[1,8],"times":1}
{"op":"add_track","name":"Lead","kind":"pitched","instrument":"flute"}        kind "drums" for a drum track
{"op":"set_track","track":"Bass","instrument":"upright","volume":0.8,"pan":-0.2,"reverb":0.1,"mute":false,"solo":false,"name":"..."}
{"op":"remove_track","track":"Pad"}
{"op":"add_notes","track":"Lead","notes":[{"bar":1,"beat":1,"length":1,"pitch":"E4","velocity":0.8}]}      length in beats; creates the track if it does not exist
{"op":"clear","track":"Lead","bars":[1,4]}                          track "all" clears every track
{"op":"set_chords","chords":[{"bar":1,"beat":1,"length":4,"name":"E","notes":["E2","B2","E3","G#3"]}]}     writes the chord lane; generators follow it
{"op":"detect_chords","track":"Guitar"}                             rebuilds the chord lane from what a track plays
{"op":"add_chord","name":"Esus2","notes":["E2","B2","E3","F#3"]}    adds to the chord palette
{"op":"generate","part":"bass","track":"Bass","style":"walking","bars":[1,8]}             bass styles: held, pulse, eighths, root-fifth, octaves, walking
{"op":"generate","part":"pad","track":"Pad"}
{"op":"generate","part":"arpeggio","track":"Arp","shape":"updown","rate":0.5,"octaves":2}  shapes: up, down, updown, random; rate in beats
{"op":"generate","part":"strum","track":"Guitar 2","style":"pop"}                         strum styles: beats, eighths, pop, ballad
{"op":"generate","part":"drums","track":"Drums","style":"rock","fill_every":4}            drum styles: rock, four, half, shuffle, ballad, soft
{"op":"transform","action":"transpose","track":"Guitar","semitones":2,"bars":[9,16]}
{"op":"transform","action":"quantize","track":"Guitar","step":0.5}       {"op":"transform","action":"humanize","track":"Drums","amount":0.5}
{"op":"transform","action":"legato","track":"Lead"}                      {"op":"transform","action":"double","track":"Lead","semitones":12}
{"op":"transform","action":"harmonize","track":"Lead","steps":2,"scale":"E major"}        steps: 2 = a third above, -2 a third below, 5 a sixth above
{"op":"transform","action":"loudness","track":"Pad","scale":0.7}         or "from":0.3,"to":1 for a swell
Generators replace what the target track has in those bars and create the track if needed. Drum pitches: 36 kick, 38 snare, 37 rim, 39 clap, 42 hat, 44 pedal hat, 46 open hat, 41/45/48 toms, 49 crash, 51 ride, 54 tambourine, 70 shaker.
Instruments: piano, epiano, organ, vibes, marimba, steel, nylon, clean, drive, harp, bass, upright, synthbass, strings, cello, violin, pad, choir, brass, sax, flute, saw, square; drum kits: kit, kit-power, kit-808, kit-jazz, kit-brush.`;

const SOUND_FOR = { bass: "bass", pad: "pad", arpeggio: "harp", strum: "steel", drums: "kit" };
const uid = () => "t" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
const bad = (msg) => { throw new Error(msg); };

function barsOf(p, bars) { // 1-based [a, b] or number or nothing -> 0-based inclusive {a, b}
  if (bars == null) return { a: 0, b: p.bars - 1 };
  const [x, y] = Array.isArray(bars) ? bars : [bars, bars], a = Math.round(x) - 1, b = Math.round(y ?? x) - 1;
  if (!(a >= 0 && b >= a && b < p.bars)) bad(`bars ${JSON.stringify(bars)} are outside the song (1-${p.bars})`);
  return { a, b };
}
function findTrack(p, ref) { const s = String(ref ?? "").toLowerCase(); return p.tracks.find((t) => t.id === ref) || p.tracks.find((t) => t.name.toLowerCase() === s) || null; }
function needTrack(p, ref) { return findTrack(p, ref) || bad(`there is no track called "${ref}"`); }
function makeTrack(p, name, kind = "pitched", instrument) {
  const t = { id: uid(), name: name || (kind === "drums" ? "Drums" : "Track " + (p.tracks.length + 1)), kind, instrument: instrument || (kind === "drums" ? "kit" : "piano"), volume: 0.8, pan: 0, reverb: kind === "drums" ? 0.08 : 0.15, mute: false, solo: false, notes: [] };
  p.tracks.push(t); return t;
}
const pitches = (xs) => (xs || []).map((x) => M.parsePitch(x) ?? bad(`"${x}" is not a note`));
function setRange(list, a, b, value, nBars) { // make bars a..b one block holding `value`
  const after = b + 1 < nBars ? { ...M.at(list, b + 1) } : null;
  const kept = list.filter((e) => e.bar < a || e.bar > b); kept.push({ ...M.at(list, a), ...value, bar: a }); if (after) kept.push({ ...after, bar: b + 1 });
  const tidy = M.tidy(kept); list.length = 0;
  for (const e of tidy) { const prev = list[list.length - 1]; const { bar: _b, ...v } = e, { bar: _p, ...pv } = prev || {}; if (prev && JSON.stringify(v) === JSON.stringify(pv)) continue; list.push(e); }
}
function scaleOf(p, name) {
  if (!name) return p.scales[0] || bad("no scale given and none detected");
  const found = p.scales.find((s) => s.name.toLowerCase() === String(name).toLowerCase()); if (found) return found;
  const m = /^([A-Ga-g][#b]?)\s+(.+)$/.exec(String(name).trim()), tonic = m ? M.parsePitch(m[1] + "4") : null;
  if (tonic == null || !M.SCALE_TYPES[m[2].toLowerCase()]) bad(`"${name}" is not a scale I know`);
  return M.makeScale(tonic % 12, m[2].toLowerCase());
}

const RUN = {
  set_title(p, o) { p.title = String(o.title || "Untitled"); return `title set to "${p.title}"`; },
  set_tempo(p, o) { const { a, b } = barsOf(p, o.bars), bpm = +o.bpm; if (!(bpm >= 20 && bpm <= 300)) bad("bpm must be between 20 and 300"); setRange(p.tempo, a, b, { bpm }, p.bars); return `tempo ${bpm} for bars ${a + 1}-${b + 1}`; },
  set_signature(p, o) { const { a, b } = barsOf(p, o.bars), beats = Math.round(+o.beats), division = o.division === 3 ? 3 : 2; if (!(beats >= 1 && beats <= 12)) bad("beats must be 1-12");
    setRange(p.signature, a, b, { beats, division }, p.bars); M.prune(p); return `signature ${M.sigText({ beats, division })} for bars ${a + 1}-${b + 1}`; },
  set_section(p, o) { const { a } = barsOf(p, o.bar ?? 1), i = M.splitAt(p.sections, a); p.sections[i].name = String(o.name || "Part"); return `section "${p.sections[i].name}" from bar ${a + 1}`; },
  insert_bars(p, o) { const after = Math.max(0, Math.min(p.bars, Math.round(o.after ?? p.bars))), count = Math.max(1, Math.min(256, Math.round(o.count || 1))); M.insertBars(p, after, count); return `${count} empty bars after bar ${after}`; },
  delete_bars(p, o) { const { a, b } = barsOf(p, o.bars); M.deleteBars(p, a, b); return `bars ${a + 1}-${b + 1} deleted`; },
  repeat_bars(p, o) { const { a, b } = barsOf(p, o.bars), times = Math.max(1, Math.min(16, Math.round(o.times || 1))); for (let k = 0; k < times; k++) M.duplicateBars(p, a, b); return `bars ${a + 1}-${b + 1} repeated ${times}×`; },
  add_track(p, o) { if (findTrack(p, o.name)) bad(`a track called "${o.name}" already exists`); const t = makeTrack(p, o.name, o.kind === "drums" ? "drums" : "pitched", o.instrument); RUN.set_track(p, { ...o, track: t.id, name: undefined }); return `track "${t.name}" added (${t.instrument})`; },
  set_track(p, o) { const t = needTrack(p, o.track), num = (k, lo, hi) => { if (o[k] != null) t[k] = Math.max(lo, Math.min(hi, +o[k])); };
    if (o.name) t.name = String(o.name); if (o.instrument) t.instrument = String(o.instrument); num("volume", 0, 1); num("pan", -1, 1); num("reverb", 0, 1);
    if (o.mute != null) t.mute = !!o.mute; if (o.solo != null) t.solo = !!o.solo; return `track "${t.name}" updated`; },
  remove_track(p, o) { const t = needTrack(p, o.track); if (p.tracks.length < 2) bad("a song needs at least one track"); p.tracks.splice(p.tracks.indexOf(t), 1); return `track "${t.name}" removed`; },
  add_notes(p, o) {
    const t = findTrack(p, o.track) || makeTrack(p, o.track, o.kind === "drums" ? "drums" : "pitched", o.instrument), L = M.layout(p); let n = 0;
    for (const x of o.notes || []) { const bar = Math.round(x.bar) - 1, pos = (+x.beat || 1) - 1, pitch = M.parsePitch(x.pitch);
      if (!(bar >= 0 && bar < p.bars) || pitch == null || !(pos >= 0 && pos < L.beats[bar])) continue;
      t.notes.push([bar, M.round(pos), M.round(Math.max(0.05, +x.length || 1)), pitch, M.round(Math.max(0.05, Math.min(1, x.velocity ?? 0.8)))]); n++; }
    if (!n && (o.notes || []).length) bad("none of those notes fit inside the song"); return `${n} notes added to "${t.name}"`;
  },
  clear(p, o) { const { a, b } = barsOf(p, o.bars), ids = o.track === "all" || o.track == null ? p.tracks.map((t) => t.id) : [needTrack(p, o.track).id]; M.clearBars(p, a, b, ids); return `cleared bars ${a + 1}-${b + 1} on ${ids.length === 1 ? `"${needTrack(p, ids[0]).name}"` : "all tracks"}`; },
  set_chords(p, o) { const L = M.layout(p); let n = 0;
    for (const c of o.chords || []) { const bar = Math.round(c.bar) - 1; if (!(bar >= 0 && bar < p.bars)) continue; const ps = pitches(c.notes || c.pitches); if (!ps.length) continue;
      T.setChord(p, L.start[bar] + ((+c.beat || 1) - 1), Math.max(0.25, +c.length || L.beats[bar]), { name: c.name, pitches: ps }); n++; }
    return `${n} chords written to the chord lane`; },
  detect_chords(p, o) { const t = o.track ? needTrack(p, o.track) : p.tracks.find((x) => x.kind !== "drums"); p.progression = T.detectProgression(p, t.id); return `chord lane rebuilt from "${t.name}" (${p.progression.length} chords)`; },
  add_chord(p, o) { const ps = pitches(o.notes || o.pitches).sort((x, y) => x - y); if (!ps.length) bad("a chord needs notes"); p.chords.push({ name: o.name || M.chordGuess(ps), pitches: ps }); return `chord "${p.chords[p.chords.length - 1].name}" added to the palette`; },
  generate(p, o) {
    const part = String(o.part), r = barsOf(p, o.bars); if (!SOUND_FOR[part]) bad(`"${part}" is not something I can generate`);
    if (part !== "drums" && !(p.progression || []).length) { const src = p.tracks.find((x) => x.kind !== "drums" && x.notes.length); if (src) p.progression = T.detectProgression(p, src.id); if (!(p.progression || []).length) bad("the chord lane is empty; write chords first with set_chords"); }
    const kind = part === "drums" ? "drums" : "pitched", t = findTrack(p, o.track) || makeTrack(p, o.track || part[0].toUpperCase() + part.slice(1), kind, o.instrument || SOUND_FOR[part]);
    if ((t.kind === "drums") !== (part === "drums")) bad(`track "${t.name}" is ${t.kind === "drums" ? "a drum track" : "not a drum track"}`);
    if (o.instrument) t.instrument = o.instrument;
    if (part === "bass") T.bassLine(p, t, r, T.BASS_STYLES[o.style] ? o.style : "pulse"); else if (part === "pad") T.padPart(p, t, r);
    else if (part === "arpeggio") T.arpeggio(p, t, r, { shape: T.ARP_SHAPES[o.shape] ? o.shape : "up", rate: Math.max(1 / 8, Math.min(4, +o.rate || 0.5)), octaves: Math.max(1, Math.min(3, Math.round(o.octaves || 2))), seed: o.seed || 1 });
    else if (part === "strum") T.strum(p, t, r, T.STRUM_STYLES[o.style] ? o.style : "eighths"); else T.drumPart(p, t, r, { style: T.DRUM_STYLES[o.style] ? o.style : "rock", fillEvery: o.fill_every ?? 4 });
    return `${part} written to "${t.name}", bars ${r.a + 1}-${r.b + 1}`;
  },
  transform(p, o) {
    const t = needTrack(p, o.track), scope = o.bars == null ? null : { bars: barsOf(p, o.bars) }, action = String(o.action);
    if (action === "transpose") T.transpose(p, t, scope, Math.round(+o.semitones || 0)); else if (action === "quantize") T.quantize(p, t, scope, +o.step || 0.5, o.strength ?? 1);
    else if (action === "humanize") T.humanize(p, t, scope, o.amount ?? 0.5, o.seed || 1); else if (action === "legato") T.legato(p, t, scope);
    else if (action === "double") T.double(p, t, scope, Math.round(o.semitones ?? 12)); else if (action === "harmonize") T.harmonize(p, t, scope, scaleOf(p, o.scale), Math.round(o.steps ?? 2));
    else if (action === "loudness") T.loudness(p, t, scope, { scale: o.scale ?? 1, from: o.from ?? null, to: o.to ?? null }); else bad(`"${action}" is not a transform`);
    return `${action} applied to "${t.name}"`;
  },
};

/** Apply operations in order. Returns what was done and what was refused; the project is changed in place. */
export function applyOps(project, ops) {
  const done = [], errors = [];
  for (const o of Array.isArray(ops) ? ops : []) {
    try { const run = RUN[o && o.op]; if (!run) bad(`unknown operation "${o && o.op}"`); done.push(run(project, o)); }
    catch (e) { errors.push(`${o && o.op ? o.op : "?"}: ${e.message}`); }
  }
  return { done, errors };
}

/** Pull the operations out of a model's reply: a ```json block, or the first JSON array or {"ops": [...]} in the text. */
export function extractOps(text) {
  const tries = [], fence = /```(?:json)?\s*([\s\S]*?)```/g; let m; while ((m = fence.exec(text))) tries.push(m[1]);
  const first = text.indexOf("["), last = text.lastIndexOf("]"); if (first >= 0 && last > first) tries.push(text.slice(first, last + 1));
  tries.push(text);
  for (const t of tries) { try { const v = JSON.parse(t.trim()); const ops = Array.isArray(v) ? v : v && Array.isArray(v.ops) ? v.ops : null; if (ops && ops.every((o) => o && typeof o.op === "string")) return ops; } catch (e) { /* try the next candidate */ } }
  return null;
}

/** The song as compact text for a model. With `bars` (1-based [a, b]) it also lists every note in those bars. */
export function describe(p, { bars = null, maxNotes = 1500 } = {}) {
  const L = M.layout(p), span = (list, i) => `bars ${list[i].bar + 1}-${i + 1 < list.length ? list[i + 1].bar : p.bars}`, out = [];
  out.push(`Song "${p.title}": ${p.bars} bars, about ${Math.round(L.time[L.n])} seconds.`);
  out.push("Tempo: " + p.tempo.map((e, i) => `${span(p.tempo, i)} ${e.bpm} bpm`).join("; "));
  out.push("Time signature: " + p.signature.map((e, i) => `${span(p.signature, i)} ${M.sigText(e)} (${e.beats} beats, each dividing in ${e.division})`).join("; "));
  out.push("Sections: " + p.sections.map((e, i) => `${e.name} (${span(p.sections, i)})`).join("; "));
  out.push("Tracks:");
  for (const t of p.tracks) { const ps = t.notes.map((n) => n[3]), range = t.kind === "drums" || !ps.length ? "" : `, range ${M.noteName(Math.min(...ps))}-${M.noteName(Math.max(...ps))}`;
    const used = new Set(t.notes.map((n) => n[0])); out.push(`- "${t.name}" (${t.kind === "drums" ? "drums, " : ""}sound ${t.instrument}): ${t.notes.length} notes in ${used.size} of ${p.bars} bars${range}${t.mute ? ", muted" : ""}`); }
  if (p.scales.length) out.push("Scales that fit: " + p.scales.slice(0, 4).map((s) => s.name + (s.fit != null ? ` ${Math.round(s.fit * 100)}%` : "")).join(", "));
  if (p.chords.length) out.push("Chord palette: " + p.chords.slice(0, 20).map((c) => `${c.name} [${c.pitches.map(M.noteName).join(" ")}]`).join("; "));
  if ((p.progression || []).length) { // chord lane, bar by bar, with runs of the same bar content folded together
    const perBar = Array.from({ length: p.bars }, () => []);
    for (const c of T.chordSlices(p, L, 0, p.bars - 1)) perBar[c.bar].push(Math.abs(c.start - L.start[c.bar]) < 1e-6 ? c.name : `${c.name}@${M.round(c.start - L.start[c.bar] + 1)}`);
    const lines = []; let from = 0;
    for (let b = 1; b <= p.bars; b++) if (b === p.bars || perBar[b].join(" ") !== perBar[from].join(" ")) { lines.push(`${from + 1}${b - 1 > from ? "-" + b : ""}: ${perBar[from].join(" ") || "-"}`); from = b; }
    out.push("Chord lane (bar: chords; @n marks the beat a chord starts on): " + lines.join(" | "));
  }
  if (bars) { const { a, b } = barsOf(p, bars); let count = 0; out.push(`Notes in bars ${a + 1}-${b + 1} (beat pitch length):`);
    for (const t of p.tracks) { const lines = [];
      for (let bar = a; bar <= b; bar++) { const ns = t.notes.filter((n) => n[0] === bar).sort((x, y) => x[1] - y[1] || x[3] - y[3]); if (!ns.length) continue; count += ns.length; if (count > maxNotes) break;
        lines.push(`  bar ${bar + 1}: ` + ns.map((n) => `${M.round(n[1] + 1)} ${t.kind === "drums" ? n[3] : M.noteName(n[3])} ${n[2]}`).join(", ")); }
      if (lines.length) out.push(`- "${t.name}":`, ...lines); } }
  return out.join("\n");
}
