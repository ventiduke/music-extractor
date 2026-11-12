"""The song sketch: beat grid, tidying, harmony, and the edit -> render round trip."""

import json
import warnings

import numpy as np
import pytest
import soundfile as sf

warnings.simplefilter("ignore")

from eval.synth import SR, render  # noqa: E402
from extract.types import NoteEvent, parse_notes  # noqa: E402
from sketch import build as sk  # noqa: E402
from sketch import cli  # noqa: E402
from sketch.grid import Grid  # noqa: E402
from sketch.harmony import estimate_key, harmony_spans  # noqa: E402
from sketch.tidy import SketchNote, clean_overlaps, tidy  # noqa: E402

STEADY = Grid(beat_times=[0.5 * i for i in range(17)], meter=4, tempo_bpm=120.0, downbeat_confidence=1.0)


def test_grid_converts_both_ways():
    assert STEADY.to_time(3.5) == pytest.approx(1.75)
    assert STEADY.to_beats(1.75) == pytest.approx(3.5)
    assert STEADY.bar_and_beat(5.5) == (2, 2.5)
    assert STEADY.n_bars == 4


def test_tidy_snaps_strums_and_drops_blips():
    raw = [
        NoteEvent(45, 0.03, 0.9, 0.8, 0.9),  # a strum just after beat 0 ...
        NoteEvent(52, 0.05, 0.9, 0.7, 0.9),  # ... second string of the same strum
        NoteEvent(57, 0.52, 0.98, 0.6, 0.9),  # a touch late for beat 1
        NoteEvent(70, 0.70, 0.75, 0.2, 0.3),  # short and quiet: a blip
        NoteEvent(57, 0.61, 0.9, 0.6, 0.9),  # too soon for another eighth: lands on the sixteenth
    ]
    notes, dropped = tidy(raw, STEADY)
    assert [(n.pitch, n.beat) for n in notes] == [(45, 0.0), (52, 0.0), (57, 1.0), (57, 1.25)]
    assert notes[2].length == 0.25  # cut where the same pitch is struck again
    assert [d["pitch"] for d in dropped] == [70] and dropped[0]["reason"] == "short and quiet"
    loose, _ = tidy(raw, STEADY, strength=0.0)
    assert loose[0].beat == pytest.approx(0.06)  # played timing kept


def test_key_and_harmony():
    e_major = [SketchNote(p, 0.0, 4.0, 0.8) for p in parse_notes("E2 B2 E3 G#3 B3 E4")]
    a_major = [SketchNote(p, 4.0, 4.0, 0.8) for p in parse_notes("A2 E3 A3 C#4 E4")]
    b_major = [SketchNote(p, 8.0, 4.0, 0.8) for p in parse_notes("B2 F#3 B3 D#4")]
    notes = e_major + a_major + b_major + [SketchNote(p, 12.0, 4.0, 0.8) for p in parse_notes("E2 B2 E3 G#3")]
    key = estimate_key(notes)
    assert (key["tonic"], key["mode"]) == ("E", "major")
    spans = harmony_spans(notes, 16, 4)
    assert [(s["bar"], s["length"], s["bass"]) for s in spans] == [(1, 4, "E2"), (2, 4, "A2"), (3, 4, "B2"), (4, 4, "E2")]
    assert spans[1]["pitch_classes"] == ["C#", "E", "A"]


def test_overlaps_are_cleaned():
    notes = clean_overlaps([SketchNote(45, 0.0, 4.0, 0.5), SketchNote(45, 0.0, 1.0, 0.9), SketchNote(45, 2.0, 1.0, 0.7)])
    assert [(n.beat, n.length, n.velocity) for n in notes] == [(0.0, 2.0, 0.9), (2.0, 1.0, 0.7)]


def test_build_edit_render_round_trip(tmp_path, capsys):
    # Four bars at 120 bpm: a chord on every beat, changing each bar.
    chords = ["E2 B2 E3 G#3", "A2 E3 A3 C#4", "D3 A3 D4 F#4", "E2 B2 E3 G#3"]
    events = [(0.5 + 0.5 * (4 * bar + beat), parse_notes(chord)) for bar, chord in enumerate(chords) for beat in range(4)]
    memo = tmp_path / "memo.wav"
    sf.write(memo, render(events, 9.5, seed=3), SR)

    cli.main(["build", str(memo), "--out", str(tmp_path)])
    path = tmp_path / "memo.sketch.json"
    sketch = json.loads(path.read_text())
    assert sketch["tempo_bpm"] == pytest.approx(120, rel=0.06)
    on_eighths = [n["beat"] % 0.5 == 0 for n in sketch["notes"]]
    assert sum(on_eighths) >= 0.95 * len(on_eighths)
    first = min(n["beat"] for n in sketch["notes"])
    assert abs(sketch["beat_times"][int(first)] - 0.5) < 0.03  # the grid sits on the strums
    gaps = np.diff(sketch["beat_times"])
    assert gaps.min() > 0.4 and gaps.max() < 0.6
    assert {s["bass"] for s in sketch["harmony"]} >= {"E2", "A2", "D3"}
    for name in ("memo.tidy.mid", "memo.tidy.steady.m4a", "memo.tidy.split.m4a"):
        assert (tmp_path / name).stat().st_size > 0

    # An edit: transpose everything up a tone, then re-render.
    for n in sketch["notes"]:
        n["pitch"] += 2
    path.write_text(json.dumps(sketch))
    cli.main(["render", str(path), "--no-previews"])
    again = json.loads(path.read_text())
    assert again["notes"][0]["name"] == "F#2"  # names, key and harmony are recomputed from the pitches
    assert {s["bass"] for s in again["harmony"]} >= {"F#2", "B2", "E3"}
    assert [n["id"] for n in again["notes"]] == list(range(len(again["notes"])))
