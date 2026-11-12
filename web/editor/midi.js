// Standard MIDI file export. Notes sit exactly on the bar grid; tempo and
// signature changes are written where the song's blocks start.
import { layout } from "./model.js";

const PPQ = 480;
const vlq = (n) => { const out = [n & 0x7f]; while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80); return out; };
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const text = (s) => [...s].map((c) => c.charCodeAt(0) & 0x7f);
const PROGRAMS = { pluck: 25, keys: 0, bass: 33, pad: 89, lead: 80, organ: 16 };

function chunk(events) { // events: [tick, bytes]
  events.sort((a, b) => a[0] - b[0]);
  const body = []; let now = 0;
  for (const [tick, bytes] of events) { body.push(...vlq(tick - now), ...bytes); now = tick; }
  body.push(0, 0xff, 0x2f, 0);
  return [...text("MTrk"), ...u32(body.length), ...body];
}

export function toMidi(project) {
  const L = layout(project);
  // A beat that divides in three is a dotted quarter: 1.5 quarter notes.
  const ticksAt = new Float64Array(L.n + 1);
  for (let b = 0; b < L.n; b++) ticksAt[b + 1] = ticksAt[b] + L.beats[b] * PPQ * (L.division[b] === 3 ? 1.5 : 1);
  const tick = (bar, pos) => Math.round(ticksAt[bar] + pos * PPQ * (L.division[bar] === 3 ? 1.5 : 1));
  const conductor = [];
  for (let b = 0; b < L.n; b++) {
    const compound = L.division[b] === 3;
    if (b === 0 || L.bpm[b] !== L.bpm[b - 1] || L.division[b] !== L.division[b - 1]) {
      const us = Math.round(60e6 / (L.bpm[b] * (compound ? 1.5 : 1)));
      conductor.push([ticksAt[b], [0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255]]);
    }
    if (b === 0 || L.beats[b] !== L.beats[b - 1] || L.division[b] !== L.division[b - 1])
      conductor.push([ticksAt[b], [0xff, 0x58, 4, compound ? L.beats[b] * 3 : L.beats[b], compound ? 3 : 2, compound ? 36 : 24, 8]]);
  }
  const chunks = [chunk(conductor)];
  let channel = 0;
  for (const t of project.tracks) {
    const drums = t.kind === "drums", ch = drums ? 9 : (channel === 9 ? ++channel : channel);
    if (!drums) channel = Math.min(15, channel + 1);
    const events = [[0, [0xff, 0x03, ...vlq(text(t.name).length), ...text(t.name)]]];
    if (!drums) events.push([0, [0xc0 | ch, PROGRAMS[t.instrument] ?? 0]]);
    for (const n of t.notes) {
      if (n[0] >= L.n) continue;
      const on = tick(n[0], n[1]), off = Math.max(on + 1, tick(n[0], n[1] + n[2])), vel = Math.max(1, Math.min(127, Math.round(30 + 97 * n[4])));
      events.push([on, [0x90 | ch, n[3], vel]], [off, [0x80 | ch, n[3], 0]]);
    }
    chunks.push(chunk(events));
  }
  return new Uint8Array([...text("MThd"), ...u32(6), 0, 1, 0, chunks.length, PPQ >> 8, PPQ & 255, ...chunks.flat()]);
}
