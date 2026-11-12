// Small UI building blocks: elements, icons, popover menus, dialogs, toasts.
export function el(tag, props = {}, kids = []) {
  const { on: handlers, attrs, style, ...rest } = props, n = Object.assign(document.createElement(tag), rest);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) n.setAttribute(k, v);
  if (style) n.style.cssText = style;
  for (const [k, fn] of Object.entries(handlers || {})) n.addEventListener(k, fn);
  n.append(...[].concat(kids).filter((k) => k != null && k !== false)); return n;
}
const ICONS = { // 20 x 20, drawn with strokes unless marked as filled
  play: ["M6 4l10 6-10 6z", 1], stop: ["M5 5h10v10H5z", 1], rewind: ["M5 4v12M16 4l-8 6 8 6z", 1], loop: ["M4 10a5 5 0 0 1 5-5h6M12 2l3 3-3 3M16 10a5 5 0 0 1-5 5H5M8 18l-3-3 3-3"],
  click: ["M7 17h6l-2-13H9zM10 12l5-6"], pencil: ["M4 16l1-4 8-8 3 3-8 8zM12 5l3 3"], pointer: ["M5 3l10 8-5 1-2 5z"], undo: ["M7 5L3 9l4 4M3 9h8a5 5 0 0 1 0 10H9"], redo: ["M13 5l4 4-4 4M17 9H9a5 5 0 0 0 0 10h2"],
  plus: ["M10 4v12M4 10h12"], minus: ["M4 10h12"], spark: ["M10 2l1.8 4.7L16.5 8.5l-4.7 1.8L10 15l-1.8-4.7L3.5 8.5l4.7-1.8zM16 13l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z", 1], wand: ["M4 16L14 6M12 4l4 4M15 12l.6 1.4L17 14l-1.4.6L15 16l-.6-1.4L13 14l1.4-.6zM5 3l.6 1.4L7 5l-1.4.6L5 7l-.6-1.4L3 5l1.4-.6z"],
  sun: ["M10 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM10 1v2M10 17v2M1 10h2M17 10h2M3.6 3.6l1.4 1.4M15 15l1.4 1.4M3.6 16.4L5 15M15 5l1.4-1.4"], moon: ["M16 12A7 7 0 0 1 8 4a7 7 0 1 0 8 8z"],
  help: ["M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM7.5 7.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M10 14.5v.01"], down: ["M5 8l5 5 5-5"], mic: ["M10 2a2.5 2.5 0 0 0-2.5 2.5v5a2.5 2.5 0 0 0 5 0v-5A2.5 2.5 0 0 0 10 2zM5 9.5a5 5 0 0 0 10 0M10 14.5V18M7 18h6"],
  file: ["M5 2h7l4 4v12H5zM12 2v4h4"], save: ["M10 3v10M6 9l4 4 4-4M4 16h12"], trash: ["M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11"], copy: ["M7 7h9v10H7zM4 13V3h9"], keys: ["M2 5h16v10H2zM6 5v6M10 5v6M14 5v6"], panel: ["M3 4h14v12H3zM12 4v12"], x: ["M5 5l10 10M15 5L5 15"],
};
export function icon(name, size = 16) {
  const [d, filled] = ICONS[name] || ICONS.plus, svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20"); svg.setAttribute("width", size); svg.setAttribute("height", size); svg.setAttribute("aria-hidden", "true"); svg.classList.add("icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", d);
  path.setAttribute("fill", filled ? "currentColor" : "none"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", filled ? "0.5" : "1.6"); path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
  svg.append(path); return svg;
}
export const btn = (label, onclick, props = {}) => el("button", { type: "button", ...props, on: { click: onclick, ...(props.on || {}) } }, [].concat(label));
export const iconBtn = (name, title, onclick, props = {}) => btn(icon(name), onclick, { title, className: "ib " + (props.className || ""), attrs: { "aria-label": title, ...(props.attrs || {}) }, ...Object.fromEntries(Object.entries(props).filter(([k]) => k !== "className" && k !== "attrs")) });
export function select(options, value, onchange, label) { // options: [[value, text]] or [{group, options}]
  const opt = ([v, text]) => el("option", { value: String(v), textContent: text });
  const s = el("select", { attrs: { "aria-label": label }, on: { change: (e) => onchange(e.target.value) } }, options.map((o) => (Array.isArray(o) ? opt(o) : el("optgroup", { label: o.group }, o.options.map(opt)))));
  s.value = String(value); return s;
}
export const field = (label, control) => el("label", { className: "field" }, [el("span", { textContent: label }), control]);

let openMenu = null;
export function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; document.removeEventListener("pointerdown", outside, true); } }
function outside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
/** A popover menu at an element or a point. items: {label, hint, run, disabled, checked}, "-" for a rule, or {heading}. */
export function menu(anchor, items) {
  closeMenu();
  const box = el("div", { className: "menu", attrs: { role: "menu" } }, items.map((it) => {
    if (it === "-") return el("hr"); if (it.heading) return el("div", { className: "mhead", textContent: it.heading });
    return btn([el("span", { textContent: (it.checked ? "✓ " : "") + it.label }), it.hint ? el("kbd", { textContent: it.hint }) : null], () => { closeMenu(); it.run(); }, { disabled: !!it.disabled, attrs: { role: "menuitem" } });
  }));
  document.body.append(box); openMenu = box;
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y, top: anchor.y }, w = box.offsetWidth, h = box.offsetHeight;
  box.style.left = Math.max(6, Math.min(r.left, window.innerWidth - w - 6)) + "px";
  box.style.top = (r.bottom + h + 6 > window.innerHeight ? Math.max(6, r.top - h - 4) : r.bottom + 4) + "px";
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  box.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  const first = box.querySelector("button:not(:disabled)"); if (first) first.focus();
  return box;
}
/** A modal dialog. `actions`: [{label, primary, run}] where run may return false to keep it open. */
export function dialog({ title, body, actions = [], wide = false }) {
  const d = el("dialog", { className: "dlg" + (wide ? " wide" : "") }), close = () => { d.close(); d.remove(); };
  d.append(el("header", {}, [el("h2", { textContent: title }), iconBtn("x", "Close", close)]), el("div", { className: "dbody" }, body),
    el("footer", {}, actions.map((a) => btn(a.label, async () => { if ((await a.run?.()) !== false) close(); }, { className: a.primary ? "primary" : "" }))));
  d.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  document.body.append(d); d.showModal(); return { close, el: d };
}
export function toast(text, bad = false) {
  const host = document.getElementById("toasts"); if (!host) return;
  const t = el("div", { className: "toast" + (bad ? " bad" : ""), textContent: text, attrs: { role: "status" } }); host.append(t); setTimeout(() => t.remove(), bad ? 6000 : 3200);
}
