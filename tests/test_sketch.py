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
    assert "90 bpm, 4/4" in shown[0] and shown[1].startswith("bar   1 |") and len(shown) == 3
    with pytest.raises(SystemExit):
        cli.main(["edit", str(tmp_path / "memo.sketch.json"), "transpose", "1", "--bars", "99"])


def test_tapped_beats_set_the_grid(tmp_path):
    from sketch.grid import grid_from_taps

    rng = np.random.default_rng(0)
    beats = 2.0 + 0.75 * np.arange(24)  # the true beat: every 0.75 s from 2.0 s, each dividing in three
    # Notes on every third of a beat; the first of each beat is the low one.
    notes = [NoteEvent(45 if k == 0 else 57, b + k * 0.25, b + k * 0.25 + 0.2, 0.8, 0.9) for b in beats for k in range(3)]
    taps = list(beats + 0.04 + rng.normal(0, 0.012, len(beats)))  # tapped a little late, with hand jitter
    del taps[7]  # one missed beat
    taps.insert(3, taps[3] + 0.05)  # one double tap
    grid = grid_from_taps(taps, notes, duration=21.0, meter=2, division=3)
    gaps = np.diff(grid.beat_times)
    assert grid.meter == 2 and grid.tempo_bpm == pytest.approx(80, abs=2)
    assert abs(gaps - 0.75).max() < 0.04  # the missed tap was filled in, the double tap dropped
    assert abs(grid.beat_times[0] - 2.0) < 0.03  # bar 1 starts on the first tap, slid onto the note starts
    cleaned, feels = clean(notes, grid, division=3)
    assert set(feels[:24]) == {"triplets"} and time_signature(2, feels) == "6/8"
    assert [n.beat for n in cleaned[:4]] == [0.0, 0.3333, 0.6667, 1.0]
    shifted = grid_from_taps(taps, notes, duration=21.0, meter=2, division=3, downbeat_shift=1)
    assert abs(shifted.beat_times[0] - 1.25) < 0.03  # beat 1 is the second tap, so bar 1 starts a beat earlier
    with pytest.raises(ValueError):
        grid_from_taps([1.0, 2.0], notes, duration=21.0)


def test_build_uses_a_beats_file(built, tmp_path, capsys):
    memo = built.with_name("memo.wav")
    beats_file = tmp_path / "memo.beats.json"
    # Tap every other eighth-note chord: half the tracker's tempo, three taps per bar.
    beats_file.write_text(json.dumps({"taps": [0.5 + i for i in range(8)], "beats_per_bar": 3, "division": 2}))
    cli.main(["build", str(memo), "--out", str(tmp_path), "--beats", str(beats_file), "--no-previews"])
    sketch = json.loads((tmp_path / "memo.sketch.json").read_text())
    assert sketch["beats_from"] == "taps" and sketch["meter"] == 3 and sketch["time_signature"] == "3/4"
    assert sketch["tempo_bpm"] == pytest.approx(60, abs=1)
    assert "your taps" in capsys.readouterr().out


def test_tempo_sections_keep_real_changes_and_ignore_wobble():
    from sketch.tempo import as_sections, best_division, per_beat, refine, steady_times, tempo_sections

    rng = np.random.default_rng(2)
    # 8 bars at 100, then 8 bars at 120, with 15 ms of human wobble on every beat.
    gaps = np.concatenate([np.full(32, 0.6), np.full(32, 0.5)])
    truth = np.concatenate([[1.0], 1.0 + np.cumsum(gaps)])
    played = truth + rng.normal(0, 0.015, len(truth))
    sections = tempo_sections(list(played), meter=4)
    assert [(s["beat"], s["length"]) for s in sections] == [(0, 32), (32, 32)]
    assert sections[0]["bpm"] == pytest.approx(100, abs=3) and sections[1]["bpm"] == pytest.approx(120, abs=3)
    assert 5 <= sections[0]["looseness_ms"] <= 45
    # One slow bar in the middle of a steady piece is wobble, not a section.
    one_slow_bar = np.concatenate([[0.0], np.cumsum(np.concatenate([np.full(16, 0.5), np.full(4, 0.56), np.full(16, 0.5)]))])
    assert len(tempo_sections(list(one_slow_bar), meter=4)) == 1

    bpms = per_beat(sections, 64, 110.0)
    assert as_sections(bpms, sections)[1]["looseness_ms"] == sections[1]["looseness_ms"]
    steady = steady_times(bpms)
    assert np.allclose(np.diff(steady)[:32], 60 / sections[0]["bpm"]) and np.allclose(np.diff(steady)[32:], 60 / sections[1]["bpm"])

    # Taps 40 ms off with jitter are pulled onto the strums; thirds are recognised.
    strums = np.concatenate([truth[:-1] + k * np.diff(truth) / 3 for k in range(3)])
    taps = truth + 0.04 + rng.normal(0, 0.03, len(truth))
    assert best_division(taps, np.sort(strums))[0] == 3
    assert best_division(taps, truth)[0] == 0 or best_division(taps, np.sort(np.concatenate([truth, truth[:-1] + np.diff(truth) / 2])))[0] == 2
    refined = refine(taps - 0.04, np.sort(strums), division=3)
    assert np.abs(refined - truth)[2:-2].mean() < 0.6 * np.abs(taps - 0.04 - truth).mean()


def test_midi_carries_tempo_changes_and_compound_time(built, tmp_path, capsys):
    import mido

    after = _edit(built, tmp_path, "tempo", "90", "--bars", "3-4")
    assert (3, 2, 90.0) in [(t["bar"], t["bars"], t["bpm"]) for t in after["tempo_map"]]
    cli.main(["render", str(tmp_path / "memo.sketch.json"), "--no-previews"])
    midi = mido.MidiFile(str(tmp_path / "memo.arr.mid"))
    tempos = [(m.time, round(mido.tempo2bpm(m.tempo))) for m in midi.tracks[0] if m.type == "set_tempo"]
    ticks = np.cumsum([t for t, _ in tempos])
    assert (8 * 480, 90) in [(int(tick), bpm) for tick, (_, bpm) in zip(ticks, tempos)]  # on the bar line of bar 3
    first_note = next(m for m in midi.tracks[1] if m.type == "note_on")
    assert first_note.time % 240 == 0  # notes sit exactly on the eighth-note grid

    sketch = json.loads((tmp_path / "memo.sketch.json").read_text())
    sketch["feel"] = [{"beat": 0, "length": len(sketch["beat_times"]) - 1, "feel": "triplets"}]
    (tmp_path / "memo.sketch.json").write_text(json.dumps(sketch))
    cli.main(["render", str(tmp_path / "memo.sketch.json"), "--no-previews"])
    midi = mido.MidiFile(str(tmp_path / "memo.clean.mid"))
    signature = next(m for m in midi.tracks[0] if m.type == "time_signature")
    assert (signature.numerator, signature.denominator) == (12, 8)
    tempo = next(m for m in midi.tracks[0] if m.type == "set_tempo")
    assert round(mido.tempo2bpm(tempo.tempo)) == round(sketch["tempo_map"][0]["bpm"] * 1.5)  # dotted-quarter beat


def test_chords_and_scales_are_read_off_the_notes():
    from sketch.theory import chord_name, chords_used, likely_scales

    assert chord_name(parse_notes("E2 B2 E3 G#3 B3 E4")) == "E"
    assert chord_name(parse_notes("C#3 E3 G#3 B3")) == "C#m7"
    assert chord_name(parse_notes("B2 E3 G#3")) == "E/B"
    assert chord_name(parse_notes("A2 E3")) == "A5"
    assert chord_name(parse_notes("E2 F3 A#3")) == "E F A#"  # no common chord: just the notes, bass first

    def chord(text, bar):
        return [SketchNote(p, bar * 4.0, 4.0, 0.8) for p in parse_notes(text)]

    # E, A, B, E in E major, then four bars that sit in G major.
    song = chord("E2 B2 E3 G#3", 0) + chord("A2 E3 A3 C#4", 1) + chord("B2 F#3 B3 D#4", 2) + chord("E2 B2 E3 G#3", 3)
    song = song + [SketchNote(n.pitch, n.beat + 16, n.length, n.velocity) for n in song]  # 8 bars in E
    for bar, text in enumerate(["G2 D3 G3 B3", "C3 G3 C4 E4", "D3 A3 D4 F#4", "G2 D3 G3 B3"] * 2, start=8):
        song += chord(text, bar)
    used = chords_used(song, 64, 4)
    assert [c["name"] for c in used[:2]] == ["E", "G"] and used[0]["beats"] == 16
    assert used[0]["pitches"] == parse_notes("E2 B2 E3 G#3")
    scales = likely_scales(song[: 4 * 8], 32, 4)
    assert scales[0]["name"] == "E major" and scales[0]["fit"] == 1.0 and scales[0]["bars"] == [1, 8]
    # Half the song in each key: one is the main scale, the other is reported for its own bars.
    found = likely_scales(song, 64, 4)
    changed = [s for s in found if s["bars"] != [1, 16]]
    e_major, g_major = {4, 6, 8, 9, 11, 1, 3}, {7, 9, 11, 0, 2, 4, 6}
    assert len(changed) == 1 and changed[0]["bars"] in ([1, 8], [9, 16])
    here = e_major if changed[0]["bars"] == [1, 8] else g_major
    assert set(changed[0]["pitch_classes"]) == here and set(found[0]["pitch_classes"]) == (g_major if here == e_major else e_major)


def test_project_export_places_notes_in_bars(built, tmp_path, capsys):
    copy = tmp_path / "memo.sketch.json"
    copy.write_text(built.read_text())
    cli.main(["edit", str(copy), "tempo", "90", "--bars", "3-4"])
    cli.main(["project", str(copy)])
    project = json.loads((tmp_path / "memo.project.json").read_text())
    sketch = json.loads(copy.read_text())
    assert len(project["bars"]) == sketch["bars"] and project["bars"][0]["beats"] == 4 and project["bars"][0]["division"] == 2
    assert project["bars"][2]["bpm"] == 90 and project["bars"][0]["bpm"] != 90
    assert [t["id"] for t in project["tracks"]] == ["guitar", "bass", "pad", "drums"] and project["tracks"][3]["kind"] == "drums"
    first = sketch["notes"][0]
    assert project["tracks"][0]["notes"][0] == [first["bar"] - 1, first["beat_in_bar"] - 1, first["length"], first["pitch"], first["velocity"]]
    assert all(0 <= n[1] < 4 for t in project["tracks"] for n in t["notes"])
    assert project["sections"][0] == {"name": "Part 1", "bar": 0} and len(project["sections"]) >= 2
    assert project["chords"] and project["scales"] and "chords:" in capsys.readouterr().out
