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
something to build on: it finds the beat, drops stray blips, pulls strums onto
the grid, and estimates the key and the pitch set over each stretch of beats.

```
uv run sketch build data/memos/idea.m4a       # -> out/idea.sketch.json, idea.tidy.mid, two previews
uv run sketch render out/idea.sketch.json     # after editing the sketch
```

| File | What it is |
| --- | --- |
| `idea.sketch.json` | The editable source of truth: tempo, beat grid, key, harmony, one note per line |
| `idea.tidy.mid` | Tidied notes at a steady tempo, with tempo and time signature set, for a DAW |
| `idea.tidy.steady.m4a` | The tidied notes alone at steady tempo |
| `idea.tidy.split.m4a` | Memo in the left ear, tidied notes in the right, following the memo's timing |

Options on `build`: `--strength 0.5` moves notes only halfway to the grid,
`--meter 3` for three beats per bar, `--downbeat-shift 1` moves the bar lines
one beat later. `CLAUDE.md` describes the sketch format for editing by hand or by an agent.

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
