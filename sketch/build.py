"""The song sketch: one JSON file that holds everything an editor (human or agent) needs.

`build` makes it from a memo. `render` turns it (edited or not) back into
MIDI and audio previews. The sketch is the source of truth in between.
"""

from __future__ import annotations

import json
import warnings
from pathlib import Path

import numpy as np

from extract.audio import SR, load
from extract.pipeline import analyse
from extract.preview import write_audio
from extract.types import NoteEvent, note_name

from . import synth
from .grid import Grid, find_grid, grid_from_taps
from .harmony import estimate_key, harmony_spans
from .parts import HAT, KICK, PART_NAMES, SNARE, make_parts
from .rhythm import clean, expand, runs, time_signature
from .tidy import SketchNote, clean_overlaps, tidy

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    import pretty_midi

VERSION = 2
DRUM_NAMES = {KICK: "kick", SNARE: "snare", HAT: "hat"}
MIDI_PROGRAMS = {"guitar": 25, "bass": 33, "pad": 89}  # steel guitar, fingered bass, warm pad


def grid_of(sketch: dict) -> Grid:
    return Grid(
        sketch["beat_times"], sketch["meter"], sketch["tempo_bpm"],
        sketch.get("downbeat_confidence", 0.0), sketch.get("meter_confidence", 0.0),
    )


def as_notes(rows: list[dict]) -> list[SketchNote]:
    return [SketchNote(r["pitch"], r["beat"], r["length"], r["velocity"]) for r in rows]


def as_rows(notes: list[SketchNote], grid: Grid, drums: bool = False) -> list[dict]:
    rows = []
    for i, n in enumerate(notes):
        bar, beat_in_bar = grid.bar_and_beat(n.beat)
        name = DRUM_NAMES.get(n.pitch, f"drum {n.pitch}") if drums else note_name(n.pitch)
        rows.append({
            "id": i, "pitch": n.pitch, "name": name, "bar": bar, "beat_in_bar": beat_in_bar,
            "beat": n.beat, "length": n.length, "velocity": n.velocity,
        })
    return rows


def feels_of(sketch: dict) -> list[str]:
    return expand(sketch.get("feel", []), len(sketch["beat_times"]) - 1)


def build(
    audio: str | Path, meter: int | None = None, downbeat_shift: int | None = None,
    templates=None, tuning: str | None = None, parts: bool = True, beats: str | Path | None = None,
) -> dict:
    """Memo -> sketch. With `beats` (a tapped-beat file), the taps set the grid instead of the beat tracker."""
    audio = Path(audio)
    kwargs = {"tuning": tuning} if tuning else {}
    result = analyse(audio, engine="model", templates=templates, **kwargs)
    if not result.notes:
        raise SystemExit(f"{audio.name}: no notes found")
    division = 2
    if beats is not None:
        tapped = json.loads(Path(beats).read_text())
        division = int(tapped.get("division", 2))
        grid = grid_from_taps(
            tapped["taps"], result.notes, result.duration,
            meter=meter or int(tapped.get("beats_per_bar", 4)), division=division,
            downbeat_shift=int(tapped.get("downbeat_shift", 0)) if downbeat_shift is None else downbeat_shift,
        )
    else:
        grid = find_grid(load(audio), result.notes, meter=meter, downbeat_shift=downbeat_shift)
    light, dropped = tidy(result.notes, grid)
    notes, feels = clean(result.notes, grid, division)
    n_beats = len(grid.beat_times) - 1
    generated = make_parts(notes, n_beats, grid.meter, feels) if parts else {}
    sketch = {
        "version": VERSION,
        "source": str(audio),
        "beats_from": "taps" if beats is not None else "tracker",
        "tempo_bpm": grid.tempo_bpm,
        "meter": grid.meter,
        "meter_confidence": grid.meter_confidence,
        "downbeat_confidence": grid.downbeat_confidence,
        "feel": runs(feels),
        "notes": as_rows(notes, grid),
        "parts": {name: as_rows(part, grid, drums=name == "drums") for name, part in generated.items()},
        "light_notes": as_rows(light, grid),
        "dropped": dropped,
        "history": [],
        "structure_edited": False,
        "beat_times": grid.beat_times,
    }
    return refresh(sketch)


def refresh(sketch: dict) -> dict:
    """Recompute everything derived from the notes after an edit: ids, names, bar numbers, key, harmony."""
    grid = grid_of(sketch)
    n_beats = len(grid.beat_times) - 1
    notes = clean_overlaps(as_notes(sketch["notes"]))
    parts = sketch.get("parts", {})
    ordered = {
        "version": VERSION,
        "source": sketch["source"],
        "beats_from": sketch.get("beats_from", "tracker"),
        "tempo_bpm": sketch["tempo_bpm"],
        "meter": grid.meter,
        "time_signature": time_signature(grid.meter, feels_of(sketch)),
        "bars": grid.n_bars,
        "meter_confidence": grid.meter_confidence,
        "downbeat_confidence": grid.downbeat_confidence,
        "key": estimate_key(notes),
        "feel": runs(feels_of(sketch)),
        "harmony": harmony_spans(notes, n_beats, grid.meter),
        "notes": as_rows(notes, grid),
        "parts": {
            name: as_rows(clean_overlaps(as_notes(parts[name])), grid, drums=name == "drums")
            for name in PART_NAMES if name in parts
        },
        "light_notes": as_rows(clean_overlaps(as_notes(sketch.get("light_notes", []))), grid),
        "dropped": sketch.get("dropped", []),
        "history": sketch.get("history", []),
        "structure_edited": sketch.get("structure_edited", False),
        "beat_times": [round(float(t), 4) for t in sketch["beat_times"]],
    }
    return ordered


def read(path: str | Path) -> dict:
    return json.loads(Path(path).read_text())


def write(sketch: dict, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    def rows(items: list, indent: str) -> str:
        if not items:
            return "[]"
        body = f",\n{indent} ".join(json.dumps(item) for item in items)
        return f"[\n{indent} {body}\n{indent}]"

    # One note, span or history entry per line: easy to read, diff and edit.
    lines = []
    for key, value in sketch.items():
        if key == "parts":
            inner = ",\n".join(f"  {json.dumps(name)}: {rows(part, '  ')}" for name, part in value.items())
            lines.append(f' "parts": {{\n{inner}\n }}' if value else ' "parts": {}')
        elif key in ("notes", "light_notes", "harmony", "dropped", "feel", "history"):
            lines.append(f" {json.dumps(key)}: {rows(value, ' ')}")
        else:
            lines.append(f" {json.dumps(key)}: {json.dumps(value)}")
    path.write_text("{\n" + ",\n".join(lines) + "\n}\n")
    return path


def _timed(notes: list[SketchNote], sketch: dict, memo_time: bool) -> list[NoteEvent]:
    """Sketch notes as timed events: following the memo's own beats, or at the steady tempo."""
    if memo_time:
        grid = grid_of(sketch)
        return [
            NoteEvent(n.pitch, float(grid.to_time(n.beat)), float(grid.to_time(n.beat + n.length)), n.velocity, 1.0)
            for n in notes
        ]
    per_beat = 60.0 / sketch["tempo_bpm"]
    return [NoteEvent(n.pitch, n.beat * per_beat, (n.beat + n.length) * per_beat, n.velocity, 1.0) for n in notes]


def write_midi(sketch: dict, tracks: dict[str, list[SketchNote]], path: Path) -> Path:
    """Steady-tempo MIDI with tempo and time signature set, one track per part, so it drops onto a DAW grid."""
    midi = pretty_midi.PrettyMIDI(initial_tempo=sketch["tempo_bpm"])
    top, bottom = (int(x) for x in sketch.get("time_signature", f"{sketch['meter']}/4").split("/"))
    midi.time_signature_changes.append(pretty_midi.TimeSignature(top, bottom, 0))
    for name, notes in tracks.items():
        drums = name == "drums"
        track = pretty_midi.Instrument(program=MIDI_PROGRAMS.get(name, 0), is_drum=drums, name=name.capitalize())
        for n in _timed(notes, sketch, memo_time=False):
            velocity = int(min(127, max(1, round(30 + 97 * n.velocity))))
            track.notes.append(pretty_midi.Note(velocity=velocity, pitch=n.pitch, start=n.start, end=n.end))
        midi.instruments.append(track)
    midi.write(str(path))
    return path


def render(sketch_path: str | Path, previews: bool = True, light: bool = False) -> list[Path]:
    """Write MIDI and (with `previews`) audio next to the sketch.

    - NAME.clean.mid / .clean.steady.m4a / .clean.split.m4a: the cleaned guitar line
    - NAME.arr.mid / .arr.steady.m4a / .arr.memo.m4a: guitar plus generated parts
    - with `light`: NAME.tidy.* from the light-touch version, for comparison
    Previews that play along with the memo are skipped once bars have been added or removed.
    """
    sketch_path = Path(sketch_path)
    sketch = read(sketch_path)
    stem = sketch_path.name.removesuffix(".sketch.json")
    guitar = as_notes(sketch["notes"])
    parts = {name: as_notes(rows) for name, rows in sketch.get("parts", {}).items() if rows}
    source = Path(sketch["source"])
    memo = load(source) if previews and source.exists() and not sketch.get("structure_edited") else None

    def out(suffix: str) -> Path:
        return sketch_path.with_name(f"{stem}.{suffix}")

    rendered: dict[tuple, np.ndarray] = {}  # each part is synthesised once per timing and reused across mixes

    def audio(tracks: dict[str, list[SketchNote]], memo_time: bool, seconds: float, under=None) -> np.ndarray:
        raw = {}
        for name, notes in tracks.items():
            key = (name, id(notes), memo_time)
            if key not in rendered:
                rendered[key] = synth.render_part(name, _timed(notes, sketch, memo_time), seconds)
            raw[name] = rendered[key]
        return synth.mix(raw, under=under)

    steady_seconds = max(
        ((n.beat + n.length) * 60.0 / sketch["tempo_bpm"] for notes in [guitar, *parts.values()] for n in notes),
        default=1.0,
    ) + 0.5

    def steady(tracks: dict[str, list[SketchNote]], suffix: str) -> Path:
        return write_audio(audio(tracks, False, steady_seconds), out(suffix))

    def split(notes: list[SketchNote], suffix: str) -> Path:
        right = audio({"guitar": notes}, True, len(memo) / SR)[: len(memo)]
        return write_audio(np.stack([memo, right], axis=1), out(suffix))

    made = [write_midi(sketch, {"guitar": guitar}, out("clean.mid"))]
    if parts:
        made.append(write_midi(sketch, {"guitar": guitar, **parts}, out("arr.mid")))
    if light and sketch.get("light_notes"):
        made.append(write_midi(sketch, {"guitar": as_notes(sketch["light_notes"])}, out("tidy.mid")))
    if not previews:
        return made
    made.append(steady({"guitar": guitar}, "clean.steady.m4a"))
    if memo is not None:
        made.append(split(guitar, "clean.split.m4a"))
    if parts:
        made.append(steady({"guitar": guitar, **parts}, "arr.steady.m4a"))
        if memo is not None:
            made.append(write_audio(audio(parts, True, len(memo) / SR, under=memo)[: len(memo)], out("arr.memo.m4a")))
    if light and sketch.get("light_notes"):
        light_notes = as_notes(sketch["light_notes"])
        made.append(steady({"guitar": light_notes}, "tidy.steady.m4a"))
        if memo is not None:
            made.append(split(light_notes, "tidy.split.m4a"))
    return made
