// Copy the editor's pure song code into the Claude skill, so the skill works on its own.
// Run after changing web/editor/{model,tools,ops,midi}.js:  node tools/sync_skill.mjs
import { copyFileSync } from "node:fs";
for (const f of ["model.js", "tools.js", "ops.js", "midi.js"]) copyFileSync(new URL(`../web/editor/${f}`, import.meta.url), new URL(`../.claude/skills/song-workbench/lib/${f}`, import.meta.url));
console.log("skill library synced");
