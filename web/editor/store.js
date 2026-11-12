// Where songs live: bundled with the site (web/editor/projects), with your edits kept in this browser.
// Nothing is uploaded anywhere. Export a song to move it or send it on.
const KEY = "mx.song.", INDEX = "mx.songs";
const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };

export async function listSongs() {
  let bundled = [];
  try { const r = await fetch("projects/index.json", { cache: "no-cache" }); if (r.ok) bundled = await r.json(); } catch (e) { /* offline or opened from disk */ }
  const local = read(INDEX) || [];
  const ids = new Set(bundled.map((s) => s.id));
  return [...bundled.map((s) => ({ ...s, bundled: true, edited: !!read(KEY + s.id) })), ...local.filter((s) => !ids.has(s.id)).map((s) => ({ ...s, bundled: false, edited: true }))];
}
export async function loadSong(entry, original = false) {
  if (!original) { const saved = read(KEY + entry.id); if (saved) return saved; }
  const r = await fetch("projects/" + entry.file, { cache: "no-cache" }); if (!r.ok) throw new Error("could not load " + entry.file);
  return r.json();
}
export function saveSong(project) {
  const ok = write(KEY + project.id, project);
  const index = (read(INDEX) || []).filter((s) => s.id !== project.id); index.push({ id: project.id, title: project.title }); write(INDEX, index);
  return ok;
}
export function forgetSong(id) { try { localStorage.removeItem(KEY + id); } catch (e) { /* nothing to forget */ } write(INDEX, (read(INDEX) || []).filter((s) => s.id !== id)); }
export function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type })), a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
