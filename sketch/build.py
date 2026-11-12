"""The song sketch: one JSON file that holds everything an editor (human or agent) needs.

`build` makes it from a memo. `render` turns it (edited or not) back into
MIDI and audio previews. The sketch is the source of truth in between.
"""

from __future__ import annotations

import json
import warnings
from pathlib import Path

import numpy as np

from extract.audio import load
from extract.pipeline import analyse
from extract.preview import synthesize, write_preview
from extract.types import NoteEvent, note_name

from .grid import Grid, find_grid
from .harmony import estimate_key, harmony_spans
from .tidy import SketchNote, clean_overlaps, tidy

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    import pretty_midi

VERSION = 1


def build(
    audio: str | Path, meter: int = 4, downbeat_shift: int | None = None, strength: float = 1.0,
    templates=None, tuning: str | None = None,
) -> dict:
    audio = Path(audio)
    kwargs = {"tuning": tuning} if tuning else {}
    result = analyse(audio, engine="model", templates=templates, **kwargs)
    if not result.notes:
        raise SystemExit(f"{audio.name}: no notes found")
    grid = find_grid(load(audio), result.notes, meter=meter, downbeat_shift=downbeat_shift)
    notes, dropped = tidy(result.notes, grid, strength=strength)
    return assemble(str(audio), grid, notes, dropped)


def assemble(source: str, grid: Grid, notes: list[SketchNote], dropped: list[dict]) -> dict:
    n_beats = len(grid.beat_times) - 1
    return {
        "version": VERSION,
        "source": source,
        "tempo_bpm": grid.tempo_bpm,
        "meter": grid.meter,
        "bars": grid.n_bars,
        "downbeat_confidence": grid.downbeat_confidence,
        "key": estimate_key(notes),
        "harmony": harmony_spans(notes, n_beats, grid.meter),
        "notes": [_note_out(i, n, grid) for i, n in enumerate(notes)],
        "dropped": dropped,
        "beat_times": grid.beat_times,
    }


def _note_out(i: int, n: SketchNote, grid: Grid) -> dict:
    bar, beat_in_bar = grid.bar_and_beat(n.beat)
    return {
        "id": i, "pitch": n.pitch, "name": note_name(n.pitch), "bar": bar, "beat_in_bar": beat_in_bar,
        "beat": n.beat, "length": n.length, "velocity": n.velocity,
    }


def read(path: str | Path) -> tuple[dict, Grid, list[SketchNote]]:
    sketch = json.loads(Path(path).read_text())
    grid = Grid(sketch["beat_times"], sketch["meter"], sketch["tempo_bpm"], sketch.get("downbeat_confidence", 0.0))
    notes = [SketchNote(n["pitch"], n["beat"], n["length"], n["velocity"]) for n in sketch["notes"]]
    return sketch, grid, clean_overlaps(notes)


def refresh(sketch: dict) -> dict:
    """Recompute everything derived from the notes after an edit (ids, bar numbers, key, harmony)."""
    grid = Grid(sketch["beat_times"], sketch["meter"], sketch["tempo_bpm"], sketch.get("downbeat_confidence", 0.0))
    notes = clean_overlaps([SketchNote(n["pitch"], n["beat"], n["length"], n["velocity"]) for n in sketch["notes"]])
    fresh = assemble(sketch["source"], grid, notes, sketch.get("dropped", []))
    return {**sketch, **fresh}


def write(sketch: dict, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # One note, span or dropped note per line: easy to read, diff and edit.
    lines = []
    for key, value in sketch.items():
        if key in ("notes", "harmony", "dropped") and value:
            rows = ",\n  ".join(json.dumps(item) for item in value)
            lines.append(f' {json.dumps(key)}: [\n  {rows}\n ]')
        else:
            lines.append(f" {json.dumps(key)}: {json.dumps(value)}")
    text = "{\n" + ",\n".join(lines) + "\n}\n"
    path.write_text(text)
    return path


def write_midi(sketch: dict, notes: list[SketchNote], path: Path) -> Path:
    """Steady-tempo MIDI with the tempo and time signature set, so it drops onto a DAW grid."""
    bpm = sketch["tempo_bpm"]
    midi = pretty_midi.PrettyMIDI(initial_tempo=bpm)
    midi.time_signature_changes.append(pretty_midi.TimeSignature(sketch["meter"], 4, 0))
    guitar = pretty_midi.Instrument(program=25, name="Guitar")
    per_beat = 60.0 / bpm
    for n in notes:
        velocity = int(min(127, max(1, round(30 + 97 * n.velocity))))
        guitar.notes.append(
            pretty_midi.Note(velocity=velocity, pitch=n.pitch, start=n.beat * per_beat, end=(n.beat + n.length) * per_beat)
        )
    midi.instruments.append(guitar)
    midi.write(str(path))
    return path


def in_memo_time(notes: list[SketchNote], grid: Grid) -> list[NoteEvent]:
    """Sketch notes at the times they fall in the original recording (following its tempo drift)."""
    return [
        NoteEvent(n.pitch, float(grid.to_time(n.beat)), float(grid.to_time(n.beat + n.length)), n.velocity, 1.0)
        for n in notes
    ]


def in_steady_time(notes: list[SketchNote], bpm: float) -> list[NoteEvent]:
    per_beat = 60.0 / bpm
    return [NoteEvent(n.pitch, n.beat * per_beat, (n.beat + n.length) * per_beat, n.velocity, 1.0) for n in notes]


def render(sketch_path: str | Path, previews: bool = True) -> list[Path]:
    """Write <name>.tidy.mid and, with `previews`, two audio files next to the sketch."""
    sketch_path = Path(sketch_path)
    sketch, grid, notes = read(sketch_path)
    stem = sketch_path.name.removesuffix(".sketch.json")
    out = [write_midi(sketch, notes, sketch_path.with_name(f"{stem}.tidy.mid"))]
    if not previews:
        return out
    # Steady tempo, notes alone: what the tidied version sounds like.
    steady = in_steady_time(notes, sketch["tempo_bpm"])
    length = max(n.end for n in steady) + 0.5
    silent = np.zeros(int(length * 22050), dtype=np.float32)
    out.append(write_preview(silent, steady, sketch_path.with_name(f"{stem}.tidy.steady.m4a"), mode="notes"))
    # Memo left, tidied notes right, following the memo's own timing.
    source = Path(sketch["source"])
    if source.exists():
        out.append(write_preview(load(source), in_memo_time(notes, grid), sketch_path.with_name(f"{stem}.tidy.split.m4a")))
    return out


__all__ = ["build", "read", "refresh", "render", "write", "synthesize"]
