# music-extractor

Turns solo guitar voice memos into notes, then into an editable song sketch.
Run everything through `uv run` (plain pip pulls in a TensorFlow that will not install).

## Layout

- `extract/` audio -> raw notes. `extract notes memo.m4a` writes `out/memo.mid` + `out/memo.json`.
- `sketch/` raw notes -> song sketch (beat grid, tidied notes, key, harmony), then -> song project for the editor.
- `web/editor/` Song Workbench, the song editor: a static web app (plain ES modules, no build step) served by GitHub Pages.
- `web/beat_tapper.html` the tapping page (still a private Claude artifact, because it saves taps to that artifact's database).
- `index.html`, `.nojekyll` the GitHub Pages landing page (Pages serves the repo root of `main`).
- `tools/` build scripts: `render_sounds.py` (instrument samples), `build_vendor.sh` (bundled libraries), `sync_skill.mjs` (copy song code into the skill).
- `.claude/skills/song-workbench/` a Claude skill for working on exported song files (see below).
- `eval/` scoring against `data/clips/labels.csv`; `eval/synth.py` makes synthetic test audio.
- `data/memos/` the user's recordings. `out/` is generated and git-ignored.

## Working on a song

```
uv run sketch build data/memos/NAME.m4a            # -> out/NAME.sketch.json, MIDI, previews
uv run sketch show out/NAME.sketch.json --bars 1-8 # bar-by-bar text summary: read this first
uv run sketch edit out/NAME.sketch.json OP ...     # see the table below
uv run sketch parts out/NAME.sketch.json           # regenerate bass / pad / drums from the guitar
uv run sketch render out/NAME.sketch.json          # rewrite MIDI + previews (add --no-previews to skip audio; it is slow)
```

`out/NAME.sketch.json` is the source of truth. Change it with `sketch edit`, or
by editing the file directly, then run `sketch render`.

| Edit | What it does |
| --- | --- |
| `transpose N [--bars 5-8] [--part ...]` | Move pitches N semitones (drums never move) |
| `velocity SCALE [--bars] [--part]` | Louder (>1) or softer (<1) |
| `clear [--bars] [--part]` | Remove notes; the bars stay as silence |
| `thin [--grid 1] [--min-velocity 0.5] [--bars] [--part]` | Keep only notes on multiples of `grid` beats and/or loud enough (default part: guitar) |
| `repeat 5-8 [--times 2]` | Play those bars again right after themselves |
| `delete 5-8` | Cut those bars out |
| `tempo 120 [--bars 5-8]` | Set the steady tempo of those bars (default: the whole song, as one section) |

Bars are 1-based and inclusive. `--part` takes any of `guitar bass pad drums all` (default `all`).
Every edit is appended to `history` in the sketch.

### The sketch file

Note lists: `notes` (the guitar, rhythm-cleaned: the main line), `parts.bass`,
`parts.pad`, `parts.drums` (generated), and `light_notes` (the guitar with only
a light tidy, kept for comparison; do not edit). Each note is one line:

```
{"id": 12, "pitch": 52, "name": "E3", "bar": 3, "beat_in_bar": 1.5, "beat": 8.5, "length": 0.5, "velocity": 0.7}
```

- **When editing by hand, change only `pitch`, `beat`, `length`, `velocity`** (or add/remove whole notes; a new note needs just those four).
  `id`, `name`, `bar`, `beat_in_bar`, `key`, `harmony`, `bars` and `time_signature` are recomputed by `render`; edits to them are overwritten.
- `beat` counts quarter-note beats from the start of bar 1 (0-based); `bar` and `beat_in_bar` are the same position counted the way a musician would (1-based). Triplet positions are stored as `.3333` and `.6667`.
- Drum pitches are General MIDI: 36 kick, 38 snare, 42 closed hi-hat.
- `feel` says how each run of beats is divided: `eighths`, `sixteenths` or `triplets`. The hi-hat follows it.
- `harmony` lists stretches of beats with the same bass note and pitch classes. There are deliberately no chord names.
- `tempo_map` splits the song into steady-tempo sections (`bar`, `bars`, `bpm`, and `looseness_ms`: how far single beats strayed inside that section). The MIDI and the "steady" previews follow it: each section keeps its tempo, wobble inside a section is removed. A change must last two bars and be about 5% to make a section. Whether a section's tempo was *meant* is the user's call: ask, then use `edit tempo` to keep, change or flatten it.
- `beat_times[i]` is when beat `i` happens in the original memo. The memo was played without a click, so beats are not evenly spaced. Do not edit it by hand.
- `dropped` holds notes removed as blips, in memo seconds, with reasons.
- `structure_edited` turns true after `repeat` or `delete`. From then on the sketch no longer lines up with the recording, so the play-along previews are skipped.
- Generated parts do not follow later guitar edits by themselves; run `sketch parts` (it overwrites hand edits to those parts; `--only bass` limits it).

### Outputs

| File | What it is |
| --- | --- |
| `NAME.clean.mid` | Guitar only, rhythm-cleaned, steady tempo, tempo and time signature set |
| `NAME.arr.mid` | Guitar, bass, pad and drums as four tracks |
| `NAME.clean.steady.m4a` | The cleaned guitar notes alone at steady tempo |
| `NAME.clean.split.m4a` | Memo in the left ear, cleaned notes in the right, following the memo's timing |
| `NAME.arr.steady.m4a` | All four parts, synthesised, at steady tempo |
| `NAME.arr.memo.m4a` | The original recording with bass, pad and drums following it |
| `NAME.tidy.*` | Written by `build` only: the light-touch version, for comparison |

Claude cannot hear audio. After a change that affects how something sounds, send the user the preview and ask.

## The goal, and the song editor

The user's phrase for it is **Seamless Untethered Creation**: record guitar or
humming, tap the beat, and build a finished-sounding song in one place, without
depending on a chat session, Python, or any outside service. Extraction only has
to be a good head start; the editor is where the work is. They asked for the feel
of a production music editor: direct manipulation (drag to move, resize, split),
keyboard shortcuts, real instrument sounds, modular code. Hold new work to that.

Song Workbench lives in `web/editor/` and is served at
https://ventiduke.github.io/music-extractor/web/editor/ . It is a static site: plain ES
modules, no build step, everything it needs is in the repo. This container cannot reach
github.io; check a deploy through the repo's Actions runs, and test locally with
`python3 -m http.server` in `web/editor` plus Playwright (headless Chromium decodes WAV and MP3, not M4A).

What it does:
- **Capture** (`capture.js`, `analysis/`): record or choose audio, find the notes in the browser (Basic Pitch on TensorFlow.js, same thresholds as Python and the same notes on a test clip), tap the beat, and build a song. `analysis/pipeline.js` is a line-for-line port of the Python `sketch/` pipeline, checked against Python output in `tests/analysis.test.mjs`. Without taps it estimates the beat from the notes, which is only a rough guess.
- **Arrange** (`arrange.js`): block lanes for sections, chords, tempo and signature; bar ruler; one lane per track. Blocks drag by their edges and split on double-click. A picked-up chord is laid along the Chords lane by dragging.
- **Notes** (`roll.js`): piano roll with draw and select tools, drag to move / re-pitch / resize, snapping, drum rows, and a loudness lane.
- **Sound** (`audio.js`, `sounds/`): 23 sampled instruments and 5 drum kits rendered from FluidR3_GM, a mixer (volume, pan, reverb send, meters), and offline export to WAV. Samples load on demand; a plain synth stands in until they arrive.
- **Tools** (`tools.js`, `toolbox.js`): generators that follow the chord lane (bass styles, pad, arpeggio, strum, drum styles with fills) and transforms (snap, loosen, join, transpose, harmonize in the scale, double, louder/softer, swell/fade).
- **Library** (`library.js`, `keys.js`): chords found in the recording, chords that belong to the chosen scale, any scale by tonic and type, reusable patterns, on-screen keys and note entry from the computer keyboard.
- **Assistant** (`assistant.js`, `ops.js`): the user describes a change; a model replies with edit operations; they are applied as one undo step. Works with the user's own Claude API key (official SDK, bundled) or by copying the request into any Claude chat and pasting the reply.

### Song file (project format v2)

Described at the top of `web/editor/model.js`: `bars` (count); `tempo`, `signature`, `sections` as change lists (`{bar, ...}` applies from that 0-based bar until the next entry); `tracks` with `instrument`, `volume`, `pan`, `reverb` and notes as `[bar, position in beats, length in beats, pitch, velocity]`; `chords` (the palette; `name` is a best guess, `pitches` is what was played); `progression` (the chord lane: `{bar, pos, len, name, pitches}`); `patterns`; `scales`. A signature is `beats` + `division` (2 or 3), so 2 beats dividing in 3 is 6/8. Positions are musical, so notes follow their bar.

- `uv run sketch project out/NAME.sketch.json --title "..." --publish` still builds a song from the Python pipeline and bundles it with the editor (`web/editor/projects/` + `index.json`).
- Storage: bundled songs are fetched from `projects/`; the user's songs and edits are kept in their browser (`localStorage`). Nothing is uploaded. To get a song back, ask the user for **song menu -> Save a song file**.

### Edit operations and the skill

`web/editor/ops.js` defines a small JSON edit language (bars and beats 1-based): `set_tempo`, `set_signature`, `set_section`, bar inserts/deletes/repeats, track ops, `add_notes`, `clear`, `set_chords`, `detect_chords`, `add_chord`, `generate`, `transform`. `GUIDE` in that file is the reference text given to models; `describe()` turns a song into compact text; `applyOps()` validates and applies. The same code backs three routes: the in-app assistant, a pasted chat reply, and the skill.

**When the user gives you a song file to change, use the skill**: `.claude/skills/song-workbench/SKILL.md`. Its script (`scripts/song.mjs describe | guide | apply | check | midi`) runs the editor's own code, copied into `lib/` by `node tools/sync_skill.mjs` (a test fails if the copy is stale). Do not hand-edit song JSON.

### Editor code map (`web/editor/`)

| File | What it holds |
| --- | --- |
| `model.js` | The song model: pure functions (layout, blocks, bars, copy/paste, chord names, scales). No DOM. |
| `tools.js` | Pure creation tools: chord-lane detection and editing, generators, transforms, chords of a scale |
| `ops.js` | The edit-operation language, song description for models, reply parsing |
| `midi.js` | MIDI export with tempo and signature changes |
| `analysis/` | Recording -> song: grid from taps, rhythm clean-up, tempo sections, chords, scales, starter parts (port of `sketch/`) |
| `app.js` | Shared state, selection, undo/redo (`begin()` ... `commit()`, or `edit(fn)`), change events |
| `audio.js` | Sample library loading, the mixer graph, transport, auditioning, WAV rendering |
| `arrange.js`, `roll.js` | The two canvases |
| `tracks.js`, `context.js`, `library.js`, `keys.js`, `toolbox.js`, `assistant.js`, `capture.js` | HTML panels and dialogs |
| `actions.js` | Copy, paste, duplicate, delete, save chord/pattern, track add/remove (shared by menus and shortcuts) |
| `ui.js` | Elements, icons, menus, dialogs, toasts |
| `main.js`, `store.js` | Wiring, shortcuts, song menu; bundled songs and browser storage |
| `vendor/` | Bundled Claude SDK and Basic Pitch (rebuild with `tools/build_vendor.sh`) |

Every change to the song goes through `begin()`/`commit()` so it is undoable. Views redraw on `emit()`; `touch()` redraws during a drag without closing the undo step. Keep `model.js`, `tools.js`, `ops.js` and `analysis/` free of DOM and audio so they stay testable in node and usable by the skill.

Claude API notes for `assistant.js`: default model `claude-opus-5-5`, called through the bundled official SDK with `dangerouslyAllowBrowser` (the key is the user's own and stays in their browser); streaming with `finalMessage()`; `output_config.effort` set explicitly; server-side `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) on Opus and Sonnet so a declined request is retried on a fallback model; the system prompt is cached. Re-read the `claude-api` skill before changing any of that.

- **Finishing a song** (`handoff.js`, `brief.js`): the user tested audio "cover" tools on their own material. Suno's Cover kept the song and sounded finished; Lyria 3.5 (text brief only) produced a different song in a different key; Stable Audio was poor. So the production step is: export audio from the editor (or use the original recording) and upload it to Suno's Cover with a style prompt. Song menu -> *Finish it in Suno…* writes that prompt from the song (vibe in the user's words, instruments, key, signature, tempo) and exports the WAV. The vibe is kept on the song as `vibe`. Suno has no official API, so the upload stays manual. The user works on instrumentals, not vocals.
- Not built yet: keeping the original recording as a reference track, audio tracks, automation, per-track effects beyond reverb, mobile layout.
- The earlier one-file editor and its Claude artifact (`Rip1rNkeNyithTmCWRwxUo`) are retired. The Beat Tapper artifact still works but tapping is now built into the editor's capture flow.

## Tapped beats

The automatic beat tracker is only a first guess: it cannot tell where the user
feels the beat (their foot may tap in 2 while the strumming divides in 3), and
it struggles with tempo changes, breaks and syncopation. The user's taps are
the authority.

- The user taps along in the Beat Tapper page: https://claude.ai/artifact/AjbYrxZpnaakiAdREKdsWK
  (source in `web/beat_tapper.html`; the page also needs each memo as `NAME.mp3` and `NAME.notes.json` published beside it).
- Saved taps land in that artifact's database, collection `beats`, one document per memo (id = the memo's file stem).
  Read them with the `ArtifactData` tool and write the document's fields to `data/beats/NAME.beats.json`:
  `{"taps": [seconds...], "beats_per_bar": 2, "division": 3, "downbeat_shift": 0}`.
- `sketch build` uses `data/beats/NAME.beats.json` automatically when it exists (`--no-beats` ignores it, `--beats FILE` names another).
  The sketch records which was used in `beats_from` (`taps` or `tracker`).
- `division` 3 means each tapped beat divides in three: triplets become the plain feel and the time signature is written as 6/8, 9/8 or 12/8.
- Taps say which beat; the strums say exactly when. Taps are tidied (double taps dropped, missed beats and breaks filled at the local spacing, jitter smoothed), slid so note starts sit on the subdivisions, then each beat is sharpened by the strums around it (`sketch/tempo.py`). The user's taps land within about 50 ms of the strums.
- If the notes clearly sit on thirds of the tapped beat when the file says two (or the reverse), the notes win; the sketch says so in `division_from`.
- Bar lines come from the taps (`beats_per_bar`, `downbeat_shift`). The user says their "1" sometimes slips; there is no reliable detector for that yet.

## Known limits

- Without tapped beats, bar lines and bar length are a guess (`downbeat_confidence` is low on the current memos, and no meter stood out, so both default to 4/4). `--meter` and `--downbeat-shift` on `sketch build` override them. Drums suffer most when they are wrong.
- The beat tracker can sit half a beat out for a stretch, which puts strums on the "and" and the kick in the wrong place there.
- Generated parts are plain on purpose: bass plays the lowest pitch class every two beats, pad holds the main pitch classes, drums are kick/snare/hat.
- The signal-processing engine (`--engine dsp`) gives nonsense on the real memos; the sketch always uses the model engine.
- No overtone templates have been recorded yet, so octave ghosts from the model are still in the notes.

## Checks

`uv run pytest` before committing (Python; synthetic audio only). After touching the editor: `for t in model tools ops analysis; do node --test web/editor/tests/$t.test.mjs; done`, and drive the page in headless Chromium for anything visual or interactive (no errors in the console is the minimum).
