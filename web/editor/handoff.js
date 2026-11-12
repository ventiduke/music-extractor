// "Finish it elsewhere": the audio and a style prompt for an audio cover tool such as Suno.
import { app, edit } from "./app.js";
import { library, renderSong, toWav } from "./audio.js";
import { stylePrompt } from "./brief.js";
import * as store from "./store.js";
import { btn, dialog, el, toast } from "./ui.js";

export function finishElsewhere() {
  const p = app.project, sounds = Object.fromEntries(library.instruments.map((i) => [i.id, i.name]));
  const prompt = el("textarea", { readOnly: true, style: "width:100%; min-height:84px; padding:7px 9px; line-height:1.4", attrs: { "aria-label": "Style prompt" } }), count = el("span", { className: "hint" });
  const vibe = el("textarea", { value: p.vibe || "", placeholder: "In your own words: genre, mood, what it should feel like. For example: warm indie folk, intimate, late-night, brushed drums", style: "width:100%; min-height:64px; padding:7px 9px; line-height:1.4", attrs: { "aria-label": "The vibe" } });
  const refresh = () => { prompt.value = stylePrompt(p, vibe.value, sounds); count.textContent = `${prompt.value.length} characters`; };
  vibe.addEventListener("input", refresh); vibe.addEventListener("change", () => edit((pp) => { pp.vibe = vibe.value.trim(); })); refresh();
  const name = p.title.replace(/[^\w-]+/g, "_") || "song";
  dialog({ title: "Finish it in Suno (or another cover tool)", body: [
    el("p", { className: "hint", textContent: "A cover tool re-produces the audio you upload in the style you describe, keeping your tune and chords. Upload the audio, choose Cover, and paste the prompt as the style." }),
    el("h3", { textContent: "1. The vibe" }), vibe,
    el("h3", { textContent: "2. The style prompt" }), prompt,
    el("div", { className: "rowx" }, [btn("Copy prompt", async () => { try { await navigator.clipboard.writeText(prompt.value); toast("Prompt copied."); } catch (e) { prompt.select(); toast("Select the text and copy it.", true); } }, { className: "primary" }), count]),
    el("h3", { textContent: "3. The audio" }),
    el("p", { className: "hint", textContent: "Export what you hear now (muted tracks are left out), or upload your original recording instead if you want the tool to follow your real playing." }),
    el("div", { className: "rowx" }, [btn("Export audio (WAV)", async (e) => { const b = e.currentTarget; b.disabled = true; b.textContent = "Rendering…";
      try { store.download(name + ".wav", toWav(await renderSong(app.project, app.L)), "audio/wav"); toast("Audio exported."); } catch (err) { toast("Could not render the audio in this browser.", true); }
      b.disabled = false; b.textContent = "Export audio (WAV)"; })]),
  ], actions: [{ label: "Done", primary: true }] });
}
