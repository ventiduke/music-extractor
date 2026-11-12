"""The song sketch: beat grid, tidying, harmony, and the edit -> render round trip."""

import json
import warnings

import numpy as np
import pytest
import soundfile as sf

warnings.simplefilter("ignore")

from eval.synth import SR, render  # noqa: E402
from extract.types import NoteEvent, parse_notes  # noqa: E402
from sketch import cli  # noqa: E402
from sketch.grid import Grid  # noqa: E402
from sketch.harmony import estimate_key, harmony_spans  # noqa: E402
from sketch.parts import make_parts  # noqa: E402
from sketch.rhythm import clean, expand, runs, time_signature  # noqa: E402
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


def _strums(times, pitch=45, length=0.2):
    return [NoteEvent(pitch, t, t + length, 0.8, 0.9) for t in times]


def test_rhythm_keeps_a_late_strum_on_the_eighth():
    # Beats are 0.5 s apart. Strums a little late or early are still eighths.
    notes, feels = clean(_strums([0.02, 0.27, 0.56, 0.71, 1.0]), STEADY)
    assert [n.beat for n in notes] == [0.0, 0.5, 1.0, 1.5, 2.0]
    assert set(feels) == {"eighths"}


def test_rhythm_finds_sixteenths_and_triplets():
    sixteenths = [0.0, 0.125, 0.25, 0.375]  # beat 0: four strums a sixteenth apart
    triplets = [1.0, 1.0 + 0.5 / 3, 1.0 + 1.0 / 3]  # beat 2: three even strums
    notes, feels = clean(_strums(sixteenths + [0.5, 0.75] + triplets, length=0.08), STEADY)
    assert feels[0] == "sixteenths" and feels[1] == "eighths" and feels[2] == "triplets"
    assert [n.beat for n in notes] == [0.0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 0.3333 + 2, 0.6667 + 2]
    assert time_signature(4, feels) == "4/4" and time_signature(4, ["triplets"] * 8) == "12/8"
    assert expand(runs(feels), len(feels)) == feels


def test_rhythm_closes_small_gaps_and_cleans_lengths():
    raw = [NoteEvent(45, 0.0, 0.42, 0.8, 0.9), NoteEvent(47, 0.5, 1.3, 0.8, 0.9)]
    notes, _ = clean(raw, STEADY)
    assert (notes[0].beat, notes[0].length) == (0.0, 1.0)  # ended just short of the next strum: now joined
    assert (notes[1].beat, notes[1].length) == (1.0, 1.5)


def test_generated_parts_follow_the_guitar():
    guitar = [SketchNote(p, 0.0, 4.0, 0.8) for p in parse_notes("A2 E3 A3 C#4")]
    guitar += [SketchNote(p, 4.0, 4.0, 0.8) for p in parse_notes("D3 A3 D4 F#4")]
    parts = make_parts(guitar, 8, 4, ["eighths"] * 4 + ["triplets"] * 4)
    assert [(n.pitch % 12, n.beat, n.length) for n in parts["bass"]] == [(9, 0, 2), (9, 2, 2), (2, 4, 2), (2, 6, 2)]
    assert all(28 <= n.pitch < 40 for n in parts["bass"])
    assert sorted({(n.pitch % 12, n.beat, n.length) for n in parts["pad"]}) == [
        (1, 0, 4), (2, 4, 4), (4, 0, 4), (6, 4, 4), (9, 0, 4), (9, 4, 4),
    ]
    kicks = [n.beat for n in parts["drums"] if n.pitch == 36]
    snares = [n.beat for n in parts["drums"] if n.pitch == 38]
    assert kicks == [0, 2, 4, 6] and snares == [1, 3, 5, 7]
    hats = [n.beat for n in parts["drums"] if n.pitch == 42]
    assert hats[:4] == [0, 0.5, 1, 1.5] and hats[8:11] == [4, 4.3333, 4.6667]  # hats follow the feel


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    """A sketch built from four bars at 120 bpm: a chord on every beat, changing each bar."""
    tmp = tmp_path_factory.mktemp("song")
    chords = ["E2 B2 E3 G#3", "A2 E3 A3 C#4", "D3 A3 D4 F#4", "E2 B2 E3 G#3"]
    events = [(0.5 + 0.5 * (4 * bar + beat), parse_notes(chord)) for bar, chord in enumerate(chords) for beat in range(4)]
    memo = tmp / "memo.wav"
    sf.write(memo, render(events, 9.5, seed=3), SR)
    cli.main(["build", str(memo), "--out", str(tmp)])
    return tmp / "memo.sketch.json"


def test_build_writes_sketch_midi_and_previews(built):
    sketch = json.loads(built.read_text())
    assert sketch["tempo_bpm"] == pytest.approx(120, rel=0.06)
    assert sketch["meter"] == 4 and sketch["time_signature"] == "4/4"
    on_eighths = [n["beat"] % 0.5 == 0 for n in sketch["notes"]]
    assert sum(on_eighths) >= 0.95 * len(on_eighths)
    first = min(n["beat"] for n in sketch["notes"])
    assert abs(sketch["beat_times"][int(first)] - 0.5) < 0.03  # the grid sits on the strums
    gaps = np.diff(sketch["beat_times"])
    assert gaps.min() > 0.4 and gaps.max() < 0.6
    assert {s["bass"] for s in sketch["harmony"]} >= {"E2", "A2", "D3"}
    assert set(sketch["parts"]) == {"bass", "pad", "drums"} and all(sketch["parts"].values())
    assert {r["name"] for r in sketch["parts"]["drums"]} == {"kick", "snare", "hat"}
    names = ["clean.mid", "clean.steady.m4a", "clean.split.m4a", "arr.mid", "arr.steady.m4a", "arr.memo.m4a",
             "tidy.mid", "tidy.steady.m4a", "tidy.split.m4a"]
    for name in names:
        assert (built.with_name(f"memo.{name}")).stat().st_size > 0
    import pretty_midi
    arr = pretty_midi.PrettyMIDI(str(built.with_name("memo.arr.mid")))
    assert [i.name for i in arr.instruments] == ["Guitar", "Bass", "Pad", "Drums"] and arr.instruments[3].is_drum


def _edit(path, tmp_path, *args):
    """Run an edit on a private copy of the sketch and return the result."""
    copy = tmp_path / "memo.sketch.json"
    if not copy.exists():
        copy.write_text(path.read_text())
    cli.main(["edit", str(copy), *args])
    return json.loads(copy.read_text())


def test_hand_edit_then_render(built, tmp_path):
    copy = tmp_path / "memo.sketch.json"
    sketch = json.loads(built.read_text())
    for n in sketch["notes"]:
        n["pitch"] += 2
    copy.write_text(json.dumps(sketch))
    cli.main(["render", str(copy), "--no-previews"])
    again = json.loads(copy.read_text())
    assert {s["bass"] for s in again["harmony"]} >= {"F#2", "B2", "E3"}  # names, key, harmony recomputed
    assert [n["id"] for n in again["notes"]] == list(range(len(again["notes"])))
    assert (tmp_path / "memo.clean.mid").exists()


def test_edit_transpose_velocity_clear_thin(built, tmp_path, capsys):
    before = json.loads(built.read_text())
    after = _edit(built, tmp_path, "transpose", "2", "--bars", "2", "--part", "guitar", "bass")
    moved = {n["name"] for n in after["notes"] if n["bar"] == 2}
    assert "B2" in moved and "A2" not in moved
    assert [n["pitch"] for n in after["notes"] if n["bar"] == 1] == [n["pitch"] for n in before["notes"] if n["bar"] == 1]
    assert [n["pitch"] for n in after["parts"]["pad"]] == [n["pitch"] for n in before["parts"]["pad"]]
    assert [n["pitch"] for n in after["parts"]["drums"]] == [n["pitch"] for n in before["parts"]["drums"]]
    assert after["history"][-1] == {"op": "transpose", "semitones": 2, "bars": "2", "parts": ["guitar", "bass"]}

    after = _edit(built, tmp_path, "velocity", "0.5", "--part", "drums")
    assert max(n["velocity"] for n in after["parts"]["drums"]) <= 0.45
    after = _edit(built, tmp_path, "thin", "--grid", "2")
    assert all(n["beat"] % 2 == 0 for n in after["notes"]) and after["notes"]
    after = _edit(built, tmp_path, "clear", "--bars", "3-4", "--part", "pad")
    assert not [n for n in after["parts"]["pad"] if n["bar"] >= 3] and [n for n in after["notes"] if n["bar"] >= 3]
    assert [h["op"] for h in after["history"]] == ["transpose", "velocity", "thin", "clear"]


def test_edit_repeat_and_delete_change_the_length(built, tmp_path, capsys):
    before = json.loads(built.read_text())
    bars = before["bars"]
    in_bar2 = [(n["pitch"], n["beat_in_bar"]) for n in before["notes"] if n["bar"] == 2]
    after = _edit(built, tmp_path, "repeat", "2", "--times", "2")
    assert after["bars"] == bars + 2 and after["structure_edited"]
    assert len(after["beat_times"]) == len(before["beat_times"]) + 8
    for bar in (2, 3, 4):
        assert [(n["pitch"], n["beat_in_bar"]) for n in after["notes"] if n["bar"] == bar] == in_bar2
    kicks = lambda s, bar: [n["beat_in_bar"] for n in s["parts"]["drums"] if n["bar"] == bar and n["name"] == "kick"]
    assert kicks(after, 3) == kicks(before, 2)
    after = _edit(built, tmp_path, "delete", "2-4")
    assert after["bars"] == bars - 1
    assert [(n["pitch"], n["beat_in_bar"]) for n in after["notes"] if n["bar"] == 2] == [
        (n["pitch"], n["beat_in_bar"]) for n in before["notes"] if n["bar"] == 3
    ]
    # The memo no longer lines up, so play-along previews are skipped; steady ones are still made.
    cli.main(["render", str(tmp_path / "memo.sketch.json")])
    assert (tmp_path / "memo.arr.steady.m4a").exists() and not (tmp_path / "memo.arr.memo.m4a").exists()


def test_parts_regenerate_and_tempo_and_show(built, tmp_path, capsys):
    after = _edit(built, tmp_path, "clear", "--part", "bass", "drums")
    assert not after["parts"]["bass"] and not after["parts"]["drums"]
    cli.main(["parts", str(tmp_path / "memo.sketch.json"), "--only", "bass"])
    after = _edit(built, tmp_path, "tempo", "90")
    assert after["parts"]["bass"] and not after["parts"]["drums"] and after["tempo_bpm"] == 90
    capsys.readouterr()
    cli.main(["show", str(tmp_path / "memo.sketch.json"), "--bars", "1-2"])
    shown = capsys.readouterr().out.splitlines()
    assert "90.0 bpm, 4/4" in shown[0] and shown[1].startswith("bar   1 |") and len(shown) == 3
    with pytest.raises(SystemExit):
        cli.main(["edit", str(tmp_path / "memo.sketch.json"), "transpose", "1", "--bars", "99"])
