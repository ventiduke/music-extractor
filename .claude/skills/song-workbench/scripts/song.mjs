#!/usr/bin/env node
// Work on a Song Workbench song file from the command line.
//   node song.mjs describe SONG.json [--bars 5-8]     what is in the song (add --bars to list every note there)
//   node song.mjs guide                               the edit operations you can use
//   node song.mjs apply SONG.json OPS.json [-o OUT]   apply operations; writes OUT (default: SONG.edited.project.json)
//   node song.mjs check SONG.json                     confirm the file is a valid song
//   node song.mjs midi SONG.json [-o OUT.mid]         export MIDI
import { readFileSync, writeFileSync } from "node:fs";
import { layout, migrate } from "../lib/model.js";
import { GUIDE, applyOps, describe, extractOps } from "../lib/ops.js";
import { toMidi } from "../lib/midi.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest.splice(i, 2)[1] : null; };
const fail = (msg) => { console.error(msg); process.exit(1); };
function load(path) {
  if (!path) fail("Give the song file: a .project.json saved from Song Workbench.");
  let raw; try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (e) { fail(`Could not read ${path}: ${e.message}`); }
  if (!raw || !Array.isArray(raw.tracks)) fail(`${path} is not a song file (it has no tracks).`);
  return migrate(raw);
}
function check(p) {
  const L = layout(p), problems = [];
  for (const t of p.tracks) for (const n of t.notes) {
    if (!(n[0] >= 0 && n[0] < p.bars)) problems.push(`${t.name}: a note in bar ${n[0] + 1}, outside the song`);
    else if (!(n[1] >= 0 && n[1] < L.beats[n[0]])) problems.push(`${t.name}: bar ${n[0] + 1} has a note at beat ${n[1] + 1}, past the end of the bar`);
    if (!(n[3] >= 0 && n[3] <= 127) || !(n[2] > 0)) problems.push(`${t.name}: bar ${n[0] + 1} has a note with a bad pitch or length`);
  }
  return [...new Set(problems)].slice(0, 20);
}

if (cmd === "guide") console.log(GUIDE);
else if (cmd === "describe") { const bars = flag("--bars"), p = load(rest[0]); console.log(describe(p, { bars: bars ? bars.split("-").map(Number) : null })); }
else if (cmd === "check") { const problems = check(load(rest[0])); if (problems.length) fail("Problems:\n- " + problems.join("\n- ")); console.log("The song file is valid."); }
else if (cmd === "midi") { const out = flag("-o"), p = load(rest[0]); const path = out || rest[0].replace(/(\.project)?\.json$/, "") + ".mid"; writeFileSync(path, toMidi(p)); console.log(`MIDI written to ${path}`); }
else if (cmd === "apply") {
  const out = flag("-o"), p = load(rest[0]); if (!rest[1]) fail("Give the operations file: a JSON array of operations (see `guide`).");
  const ops = extractOps(readFileSync(rest[1], "utf8")); if (!ops) fail(`${rest[1]} does not hold a JSON array of operations.`);
  const { done, errors } = applyOps(p, ops), problems = check(p);
  for (const d of done) console.log("done: " + d); for (const e of errors) console.log("SKIPPED: " + e);
  if (problems.length) fail("The result has problems, so nothing was written:\n- " + problems.join("\n- "));
  const path = out || rest[0].replace(/(\.edited)?(\.project)?\.json$/, "") + ".edited.project.json"; writeFileSync(path, JSON.stringify(p));
  console.log(`${done.length} applied, ${errors.length} skipped. Written to ${path}`); if (errors.length) process.exitCode = 2;
} else fail("Usage: song.mjs describe|guide|apply|check|midi  (see the comment at the top of this file)");
