# music-extractor

Turns solo guitar voice memos into notes, then into an editable song sketch.
Run everything through `uv run` (plain pip pulls in a TensorFlow that will not install).

## Layout

- `extract/` audio -> raw notes. `extract notes memo.m4a` writes `out/memo.mid` + `out/memo.json`.
- `sketch/` raw notes -> song sketch (beat grid, tidied notes, key, harmony). This is where editing happens.
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
| `tempo 120` | Set the steady tempo |

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

## Known limits

- Bar lines and bar length are a guess (`downbeat_confidence` is low on the current memos, and no meter stood out, so both default to 4/4). `--meter` and `--downbeat-shift` on `sketch build` override them. Drums suffer most when they are wrong.
- The beat tracker can sit half a beat out for a stretch, which puts strums on the "and" and the kick in the wrong place there.
- Generated parts are plain on purpose: bass plays the lowest pitch class every two beats, pad holds the main pitch classes, drums are kick/snare/hat.
- The signal-processing engine (`--engine dsp`) gives nonsense on the real memos; the sketch always uses the model engine.
- No overtone templates have been recorded yet, so octave ghosts from the model are still in the notes.

## Checks

`uv run pytest` before committing. Tests use synthetic audio only.
