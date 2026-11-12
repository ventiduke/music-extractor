# music-extractor

Turns solo guitar voice memos into notes, then into an editable song sketch.
Run everything through `uv run` (plain pip pulls in a TensorFlow that will not install).

## Layout

- `extract/` audio -> raw notes. `extract notes memo.m4a` writes `out/memo.mid` + `out/memo.json`.
- `sketch/` raw notes -> song sketch (beat grid, tidied notes, key, harmony), then -> song project for the editor.
- `web/editor/` Song Workbench, the song editor: a static web app (plain ES modules, no build step) served by GitHub Pages.
- `web/beat_tapper.html` the tapping page (still a private Claude artifact, because it saves taps to that artifact's database).
- `index.html`, `.nojekyll` the GitHub Pages landing page (Pages serves the repo root of `main`).
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

The user's process: record guitar or humming -> tap the beat -> the system
extracts notes, chords, harmony, tempo and signature -> they **construct** a
song from those pieces in an editor, no longer tied to the recording's timing.
Extraction only has to be a good head start; the editor is where the work is.
Later: per-track instruments and levels, then handing a song to an AI to
embellish from a prompt.

- `uv run sketch project out/NAME.sketch.json --title "..." --publish` writes `out/NAME.project.json` and, with `--publish`, bundles it with the editor (`web/editor/projects/` + `index.json`). It reaches the user once merged to `main`.
- Project format (v2; described at the top of `web/editor/model.js` and in `sketch/project.py`): `bars` (count); `tempo`, `signature`, `sections` as change lists (`{bar, ...}` applies from that 0-based bar until the next entry); `tracks` with notes as `[bar, position in beats, length in beats, pitch, velocity]`; `chords` (`name` is a best guess, `pitches` is what was played); `scales`. A signature is `beats` + `division` (2 or 3), so 2 beats dividing in 3 is 6/8. Positions are musical, so notes follow their bar.
- The editor is Song Workbench: https://ventiduke.github.io/music-extractor/web/editor/ . This container cannot reach github.io; check a deploy through the repo's Actions runs, and test locally with `python3 -m http.server` in `web/editor` plus Playwright.
- Storage: bundled songs are fetched from `projects/`; the user's edits are kept in their browser (`localStorage`), per song, and shadow the bundled copy until they press "Revert to original". Nothing is uploaded. To get an edited song back, ask the user to press "Export song" and attach the file.

### Editor code map (`web/editor/`)

| File | What it holds |
| --- | --- |
| `model.js` | The song model: pure functions (layout, blocks, bars, copy/paste, chord names). No DOM. Tested by `tests/model.test.mjs`. |
| `midi.js` | MIDI export with tempo and signature changes |
| `app.js` | Shared state, selection, undo/redo (`begin()` ... `commit()`, or `edit(fn)`), change events |
| `audio.js` | Built-in synth and the transport (play, loop, click, mute/solo at play time) |
| `arrange.js` | Arrangement canvas: section / tempo / signature block lanes, bar ruler, track lanes |
| `roll.js` | Piano roll canvas: draw, select, drag to move / re-pitch / resize, drum rows |
| `panels.js` | HTML parts: track headers, context bar, chords, scales, keys, copy/paste/duplicate |
| `main.js` | Toolbar, shortcuts, scroll and zoom, loading and saving |
| `store.js` | Bundled songs, browser storage, file export |

Every change to the song goes through `begin()`/`commit()` so it is undoable. Views redraw on `emit()`; `touch()` redraws during a drag without closing the undo step.
The user asked for the feel of a production music editor: direct manipulation (drag to move, resize, split), keyboard shortcuts, modular code. Keep to that.

- Not built yet: importing audio in the browser (extraction still runs in Python), reusable clips/patterns, drum pattern tools beyond the grid, audio export, the AI hand-off.
- The earlier one-file editor and its Claude artifact (`Rip1rNkeNyithTmCWRwxUo`) are retired.

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

`uv run pytest` before committing (Python; synthetic audio only), and `node --test web/editor/tests/model.test.mjs` after touching the editor's model or MIDI export.
