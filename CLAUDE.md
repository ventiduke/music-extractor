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
uv run sketch build data/memos/NAME.m4a      # -> out/NAME.sketch.json, .tidy.mid, two previews
# edit out/NAME.sketch.json
uv run sketch render out/NAME.sketch.json    # recompute derived fields, rewrite MIDI + previews
```

`out/NAME.sketch.json` is the source of truth. To change the music, edit its
`notes` list and run `sketch render`. Each note is one line:

```
{"id": 12, "pitch": 52, "name": "E3", "bar": 3, "beat_in_bar": 1.5, "beat": 8.5, "length": 0.5, "velocity": 0.7}
```

- **Edit only `pitch`, `beat`, `length`, `velocity`** (or add/remove whole notes; a new note needs just those four).
  `id`, `name`, `bar`, `beat_in_bar`, `key` and `harmony` are recomputed by `render`; edits to them are overwritten.
- `beat` counts quarter-note beats from the start of bar 1 (0-based); `bar` and `beat_in_bar` are the same position counted the way a musician would (1-based).
- `harmony` lists stretches of beats with the same bass note and pitch classes. There are deliberately no chord names.
- `beat_times[i]` is when beat `i` happens in the original memo. The memo was played without a click, so beats are not evenly spaced. Leave this list alone unless re-gridding.
- `dropped` holds notes the tidy step removed, with reasons. Move one back into `notes` (converting its time with `beat_times`) to restore it.

Outputs of `render`:

- `NAME.tidy.mid`: steady tempo, tempo and time signature set, for a DAW.
- `NAME.tidy.steady.m4a`: the tidied notes alone at steady tempo.
- `NAME.tidy.split.m4a`: the memo in the left ear, tidied notes in the right, following the memo's timing.

Claude cannot hear audio. After a change that affects how something sounds, send the user the preview and ask.

## Known limits

- Bar lines are a guess (`downbeat_confidence` is low on the current memos). `--meter` and `--downbeat-shift` on `sketch build` override it.
- The signal-processing engine (`--engine dsp`) gives nonsense on the real memos; the sketch always uses the model engine.
- No overtone templates have been recorded yet, so octave ghosts from the model are still in the notes.

## Checks

`uv run pytest` before committing. Tests use synthetic audio only.
