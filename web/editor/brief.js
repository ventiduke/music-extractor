// A short style prompt for an audio "cover" tool (such as Suno's Cover), written from the song itself.
// Pure: no DOM. The tool gets the notes from the audio you upload; this only tells it how to dress them.
import { layout, sigText } from "./model.js";

/** `sounds` maps instrument ids to display names (from the sound library); ids are used when it is missing. */
export function stylePrompt(p, vibe = "", sounds = {}) {
  const L = layout(p), parts = [];
  if (vibe.trim()) parts.push(vibe.trim().replace(/[.\s]+$/, ""));
  parts.push("instrumental, no vocals");
  const solo = p.tracks.some((t) => t.solo), heard = p.tracks.filter((t) => t.notes.length && (solo ? t.solo : !t.mute));
  const names = [...new Set(heard.map((t) => (t.kind === "drums" ? "drums" : (sounds[t.instrument] || t.instrument).toLowerCase())))];
  if (names.length) parts.push(names.join(", "));
  // the tempo most of the song sits at, and whether it moves
  const barsAt = new Map(); for (let b = 0; b < L.n; b++) barsAt.set(L.bpm[b], (barsAt.get(L.bpm[b]) || 0) + 1);
  const main = [...barsAt].sort((a, b) => b[1] - a[1])[0][0], lo = Math.min(...L.bpm), hi = Math.max(...L.bpm);
  const sig = sigText({ beats: L.beats[0], division: L.division[0] }), feel = L.division[0] === 3 ? `${sig} with a lilting triplet feel` : sig;
  const key = p.scales && p.scales.length ? p.scales[0].name : null;
  parts.push([key, feel, hi / lo > 1.12 ? `tempo building from ${Math.round(L.bpm[0])} to ${Math.round(hi)} bpm` : `about ${Math.round(main)} bpm`].filter(Boolean).join(", "));
  return parts.join(". ") + ".";
}
