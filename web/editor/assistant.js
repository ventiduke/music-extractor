// The assistant: describe a change in words, get it back as edit operations, apply it as one undoable step.
// Two routes share the same request and reply format: your own Claude API key (the reply is applied for you),
// or copy the request into any Claude chat and paste the reply back.
import { app, begin, commit, track, undo } from "./app.js";
import { preload } from "./audio.js";
import { GUIDE, applyOps, describe, extractOps } from "./ops.js";
import { btn, el, select, toast } from "./ui.js";

const MODELS = [["claude-opus-5-5", "Claude Opus 5.5"], ["claude-sonnet-5-5", "Claude Sonnet 5.5"], ["claude-haiku-5-5", "Claude Haiku 5.5 (fastest)"]];
export const SYSTEM = `You are the arranging assistant inside Song Workbench, a music editor. The user is building a song from ideas they recorded on guitar or hummed. They describe a change in everyday words; you make it by returning edit operations that the editor applies.

How to reply: first one or two plain sentences saying what you are doing and any musical choice you made, then one \`\`\`json code block holding the array of operations. If the request is a question, answer it and return an empty array. If it cannot be done with these operations, say what is missing and return an empty array.

Working well:
- Prefer the generators and transforms to writing long note lists by hand. They follow the chord lane and each bar's time signature, so the result fits the song.
- When you do write notes, keep them inside the scale that fits the song and inside each bar's length, and give them musical shape: a melody that moves mostly by step, rests, and repetition with small changes.
- Change only what was asked. Leave other tracks and bars alone, and do not clear a track the user did not mention.
- "The selection" below is where the user is working; when a request says "here" or names no place, apply it there. With no selection, apply it to the whole song.
- New tracks need a clear name and a fitting sound. Keep volumes sensible so a new part supports the song instead of covering it.

${GUIDE}`;

const read = (k, d = "") => { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* not kept */ } };
let box, log, input, history = [], busy = false;

function request(prompt) {
  const sb = app.sel.bars, bars = sb ? [sb.a + 1, sb.b + 1] : null, sel = sb ? `bars ${sb.a + 1}-${sb.b + 1} on track "${track().name}"` : `nothing selected; the chosen track is "${track().name}"`;
  return `${describe(app.project, { bars })}\n\nThe selection: ${sel}.\n\nRequest: ${prompt}`;
}
function say(kind, text, extra = []) { const m = el("div", { className: "msg " + kind }, [text, ...extra]); log.append(m); m.scrollIntoView({ block: "nearest" }); return m; }

/** Apply a model's reply to the song. Returns false when it held no operations. */
function applyReply(text) {
  const ops = extractOps(text), note = text.replace(/```[\s\S]*?```/g, "").trim();
  if (!ops) { say("bad", note || "The reply had no operations in it."); return false; }
  if (!ops.length) { say("", note || "Nothing to change."); return true; }
  begin(); const { done, errors } = applyOps(app.project, ops); commit(); preload(app.project);
  const steps = app.undo.length;
  say("", note || "Done.", [el("ul", {}, [...done.map((d) => el("li", { textContent: d })), ...errors.map((e) => el("li", { className: "err", textContent: "Skipped — " + e }))]),
    done.length ? el("div", { className: "rowx" }, [btn("Undo this", (e) => { if (app.undo.length === steps) { undo(); e.currentTarget.disabled = true; e.currentTarget.textContent = "Undone"; } else toast("Other changes came after this one; use Undo in the toolbar.", true); }, { className: "small" })]) : null]);
  return true;
}

async function send() {
  const prompt = input.value.trim(), key = read("mx.key"); if (!prompt || busy) return;
  if (!key) { toast("Add your Claude API key under Connection, or use Copy request.", true); box.querySelector("details").open = true; return; }
  busy = true; input.value = ""; say("you", prompt); const waiting = say("", "Thinking…"); const model = read("mx.model", MODELS[0][0]), content = request(prompt);
  try {
    const { default: Anthropic } = await import("./vendor/anthropic-sdk.js");
    // The key is the user's own, kept in this browser and sent only to Anthropic.
    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true }), fallback = model !== "claude-haiku-5-5";
    const message = await client.beta.messages.stream({
      model, max_tokens: 32000, output_config: { effort: "medium" },
      // If the model declines a request, let the API retry it on a fallback model instead of failing.
      ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [...history.slice(-6), { role: "user", content }],
    }).finalMessage();
    waiting.remove();
    if (message.stop_reason === "refusal") { say("bad", "The model declined this request. Try wording it differently."); return; }
    const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (message.stop_reason === "max_tokens") say("bad", "The reply was cut off before it finished, so it may be incomplete. Ask for a smaller change.");
    if (applyReply(text)) history.push({ role: "user", content: `Request: ${prompt}` }, { role: "assistant", content: text });
  } catch (e) {
    waiting.remove(); const { default: Anthropic } = await import("./vendor/anthropic-sdk.js").catch(() => ({ default: null }));
    if (Anthropic && e instanceof Anthropic.AuthenticationError) say("bad", "That API key was not accepted. Check it under Connection.");
    else if (Anthropic && e instanceof Anthropic.PermissionDeniedError) say("bad", "This key is not allowed to use that model. Pick another model under Connection.");
    else if (Anthropic && e instanceof Anthropic.RateLimitError) say("bad", "Too many requests just now. Wait a moment and send it again.");
    else if (Anthropic && e instanceof Anthropic.APIConnectionError) say("bad", "Could not reach Anthropic. Check your connection and try again.");
    else if (Anthropic && e instanceof Anthropic.APIError) say("bad", `The request failed (${e.status}): ${e.message}`);
    else say("bad", "Something went wrong sending the request.");
    input.value = prompt;
  } finally { busy = false; }
}

export function mountAssistant(host) {
  box = host; log = el("div", { className: "chat" });
  input = el("textarea", { placeholder: "Ask for a change: “add a walking bass under part 2”, “make the drums half-time in the last 8 bars”, “write a flute line that answers the guitar”…", attrs: { "aria-label": "Ask for a change" },
    on: { keydown: (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } } } });
  const key = el("input", { type: "password", value: read("mx.key"), placeholder: "sk-ant-…", autocomplete: "off", attrs: { "aria-label": "Claude API key" }, on: { change: (e) => write("mx.key", e.target.value.trim()) } });
  const paste = el("textarea", { placeholder: "Paste the reply here", attrs: { "aria-label": "Paste the reply here" } });
  box.replaceChildren(
    el("p", { className: "hint", textContent: "Describe a change and the assistant makes it as one step you can undo. It sees the song's structure, chords and tracks, plus the notes of any bars you have selected." }),
    log, input,
    el("div", { className: "rowx" }, [btn("Send", send, { className: "primary", title: "Ctrl+Enter" }),
      btn("Copy request", async () => { const prompt = input.value.trim(); if (!prompt) return toast("Type what you want first.", true);
        const text = `${SYSTEM}\n\n---\n\n${request(prompt)}`; try { await navigator.clipboard.writeText(text); toast("Copied. Paste it into a Claude chat, then paste the reply below."); } catch (e) { paste.value = text; paste.select(); toast("Copy the text in the box below.", true); }
        box.querySelector("details").open = true; }, { title: "No key needed: paste this into any Claude chat" })]),
    el("details", {}, [el("summary", { textContent: "Connection" }),
      el("p", { className: "hint", textContent: "With your own Claude API key, replies are applied for you. The key stays in this browser and is sent only to Anthropic. Requests are billed to your account." }), key,
      el("label", { className: "field" }, [el("span", { textContent: "Model" }), select(MODELS, read("mx.model", MODELS[0][0]), (v) => write("mx.model", v), "Model")]),
      el("p", { className: "hint", textContent: "No key? Use Copy request, paste it into a Claude chat, then paste the whole reply here." }), paste,
      btn("Apply pasted reply", () => { if (!paste.value.trim()) return; say("you", input.value.trim() || "(pasted reply)"); if (applyReply(paste.value)) { paste.value = ""; input.value = ""; } })]),
  );
}
export { request };
