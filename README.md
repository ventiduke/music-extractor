# music-extractor

Turns a solo guitar voice memo into the notes played and when: a MIDI file of
the played notes, plus a JSON sidecar that keeps overtones as their own labeled
layer. That output is the input for later arrangement tools.

## Setup

Needs [uv](https://docs.astral.sh/uv/) and ffmpeg (for phone `.m4a` memos).

```
uv sync
```

Use uv rather than plain pip: Basic Pitch pins an old TensorFlow, and
`pyproject.toml` tells uv to skip it and run the bundled ONNX model instead.

## Use

```
uv run extract notes data/memos/idea.m4a            # -> out/idea.mid, out/idea.json
uv run extract notes memo.m4a --preview             # also out/memo.preview.m4a: memo left ear, notes right ear
uv run extract notes memo.wav --engine dsp          # signal-processing engine instead of the model
uv run extract notes memo.wav --tuning "D2 A2 D3 G3 B3 E4"
uv run extract templates                            # build overtone templates from data/templates/
uv run score                                        # score both engines on data/clips/labels.csv
uv run pytest
```

Two engines produce note events; everything after that is shared.

| Engine | What it is |
| --- | --- |
| `model` (default) | Basic Pitch note model |
| `dsp` | Constant-Q spectrum at 3 bins per semitone, harmonic summation, hold-until-it-changes stitching. No model, so every decision can be inspected. |

## Song sketch

`extract` gives the notes as played, flaws included. `sketch` turns them into
something to build on:

- finds the beat (following the memo's tempo drift) and guesses the bar length
- cleans the rhythm: each beat is read as eighths, sixteenths or triplets, and every strum lands on that division
- estimates the key and the pitch set over each stretch of beats
- generates a plain bass line, pad and drum part that follow the guitar
- keeps it all in one editable file, with commands to change it

```
uv run sketch build data/memos/idea.m4a          # -> out/idea.sketch.json, MIDI, previews
uv run sketch show out/idea.sketch.json --bars 1-8
uv run sketch edit out/idea.sketch.json transpose 2 --bars 5-8
uv run sketch edit out/idea.sketch.json repeat 9-12
uv run sketch edit out/idea.sketch.json thin --grid 1 --part guitar
uv run sketch parts out/idea.sketch.json         # regenerate bass / pad / drums
uv run sketch render out/idea.sketch.json        # after any edit
```

| File | What it is |
| --- | --- |
| `idea.sketch.json` | The editable source of truth: tempo, beat grid, key, harmony, every part one note per line |
| `idea.clean.mid` | Rhythm-cleaned guitar at a steady tempo, for a DAW |
| `idea.arr.mid` | Guitar, bass, pad and drums as four tracks |
| `idea.clean.steady.m4a`, `idea.clean.split.m4a` | The cleaned notes alone; and beside the memo (memo left ear, notes right) |
| `idea.arr.steady.m4a` | All four parts at steady tempo |
| `idea.arr.memo.m4a` | Your original recording with bass, pad and drums following it |
| `idea.tidy.*` | The earlier light-touch tidy, for comparison |

Options on `build`: `--meter 3` for three beats per bar, `--downbeat-shift 1`
to move the bar lines one beat later, `--no-parts`. `CLAUDE.md` has the full
edit list and the sketch format, for editing by hand or by an agent.

### Laying down the beat yourself

The automatic beat is a guess, and it guesses badly when the tempo moves, the
playing is syncopated, or your foot taps in 2 while the strumming is in 3.
The Beat Tapper page (`web/beat_tapper.html`, published as a private Claude
artifact) plays a memo and records your taps, how many taps make a bar, and
whether each tap divides in two or three. Saved as
`data/beats/NAME.beats.json`, the taps replace the automatic grid the next
time `sketch build` runs on that memo.

Taps are good to about 50 ms, so each beat is then sharpened by the strums
around it. From that grid the sketch works out a tempo map: stretches of
steady tempo, where a change has to last two bars and be about 5% to count.
The MIDI and the "steady" previews keep each section's tempo and iron out the
wobble inside it. `sketch edit FILE tempo 120 --bars 1-15` overrides a section.

## Song Workbench: the editor

`web/editor/`, live at <https://ventiduke.github.io/music-extractor/web/editor/>. Record an idea,
tap the beat, and build a song from it, all in the browser. Nothing is uploaded.

- **From a recording to a song.** Song menu -> *New song from a recording*: record or choose audio, the notes are found on your device, you tap the beat, and the editor builds bars, tempo and signature blocks, a chord lane, the chords and scales you used, and starter bass, pad and drum parts.
- **Arrange.** Section, chord, tempo and signature lanes made of blocks: drag an edge to move a boundary, double-click to split, select to edit. Drag across a track to select bars, then copy, paste, repeat, clear or delete.
- **Notes.** A piano roll: draw, drag to move or re-pitch, drag an edge to resize, snap to 1, 1/2, 1/3, 1/4, 1/6 or 1/8 of a beat, and a loudness lane underneath.
- **Sound.** 23 sampled instruments and 5 drum kits, with volume, pan, reverb, mute and solo per track. Export audio (WAV) or MIDI.
- **Tools.** Write a bass line, pad, arpeggio, strummed part or drum part that follows the chord lane; snap, loosen, join, transpose or harmonize what is selected.
- **Chords, scales, patterns, keys.** Draw with chords from your recording or from the scale; save riffs as patterns to stamp elsewhere; play notes from the computer keyboard (press Q).
- **Assistant.** Describe a change in words. With your own Claude API key it is applied for you; without one, copy the request into any Claude chat and paste the reply back.

It is a static site with no build step. Songs and edits are kept in your browser; use *Save a song file* to keep or share one.

```
cd web/editor && python3 -m http.server      # run it locally
for t in model tools ops analysis; do node --test web/editor/tests/$t.test.mjs; done
uv run python tools/render_sounds.py          # re-render the instrument samples (needs fluidsynth + FluidR3_GM)
tools/build_vendor.sh                         # rebuild the bundled Claude SDK and Basic Pitch
```

### Working on a song with Claude outside the editor

`.claude/skills/song-workbench/` is a Claude skill: give Claude a saved song file and it can read it,
write edit operations, and hand back an edited file to open in the editor. It runs the editor's own
code (`node .claude/skills/song-workbench/scripts/song.mjs describe SONG.json`). Claude Code picks
the skill up automatically in this repo; elsewhere, upload the folder as a skill.

The Python pipeline can still bundle a song with the editor:
`uv run sketch project out/idea.sketch.json --title "Idea" --publish`.

## Recording the data (Phase 0)

| Folder | What goes in it |
| --- | --- |
| `data/templates/` | One file per note, ringing about 2 s, named by the pitch that **sounds**: `E2.wav`, `C3.wav`. Anything after an underscore is ignored, so `C3_A-string.wav` and `C3_E-string.wav` are two takes of C3 and get averaged. |
| `data/clips/` | Short labeled clips plus `labels.csv` |
| `data/memos/` | Real ideas for the listening test |

`labels.csv` has one row per labeled span. Blank `start`/`end` mean the whole clip.

```
clip,start,end,notes
weird_chord.m4a,,,E2 B2 F#3 G3 B3 E4
two_chords.m4a,0.4,2.1,A2 E3 A3 C#4 E4
two_chords.m4a,2.1,4.0,D3 A3 D4 F#4
```

Once `data/templates/templates.json` exists (`extract templates` writes it),
`extract notes` uses it automatically. Without it every pitch is labeled `played`.

## Output

`out/<memo>.mid` holds played notes only. `out/<memo>.json` holds one entry per
segment (onset to next onset) with `start`, `end`, `lowest_note` and `pitches`:

| Field | Meaning |
| --- | --- |
| `pitch`, `name` | MIDI number and name, e.g. 64 / E4 |
| `layer` | `played`, `overtone`, `ambiguous` or `sympathetic` |
| `source` | For overtones, e.g. `"3rd of A2"`; also as `source_pitch` and `source_harmonic` |
| `energy` | Loudness relative to the loudest pitch in the segment, 0-1 |
| `confidence` | Engine confidence, 0-1 |

The JSON also carries the note list that went into the MIDI and the settings used.
`ambiguous` pitches (partly explained by another note's overtone) stay in the MIDI;
`overtone` and `sympathetic` ones do not.

## Evaluation

`score` compares each labeled span with the played pitches found there and
prints precision, recall, pitch-class precision/recall, lowest-note accuracy
and onset timing against the plan's starting targets. Every run appends to
`eval/results.csv` (clip, approach, settings, scores, missed and extra notes).

All thresholds live in `Settings` in `extract/types.py`.

### Synthetic sanity set

There are no real recordings in the repo yet. To check the code end to end,
`eval/synth.py` generates plucked-string clips with known notes:

```
uv run python -m eval.synth data/synth
uv run extract templates data/synth/templates
uv run score --clips data/synth/clips --templates data/synth/templates/templates.json --results data/synth/results.csv
```

Synthetic strings are far cleaner than a phone memo. Scores on this set show
the pipeline works; they say nothing about accuracy on real audio.
