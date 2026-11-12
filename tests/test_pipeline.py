"""End-to-end checks on synthetic plucked strings (see eval/synth.py)."""

import json
import warnings

import numpy as np
import pytest
import soundfile as sf

warnings.simplefilter("ignore")

from eval.score import score_span  # noqa: E402
from eval.synth import SR, render  # noqa: E402
from extract import cli  # noqa: E402
from extract.layers import Templates, build_templates  # noqa: E402
from extract.pipeline import analyse  # noqa: E402
from extract.types import note_name, parse_note, parse_notes  # noqa: E402

CHORD = parse_notes("A2 E3 A3 C#4 E4")


def clip(tmp_path, name, events, dur):
    path = tmp_path / name
    sf.write(path, render(events, dur, seed=7), SR)
    return path


@pytest.fixture(scope="module")
def templates(tmp_path_factory):
    folder = tmp_path_factory.mktemp("templates")
    for midi in (40, 45, 50, 52, 57, 61, 64):
        sf.write(folder / f"{note_name(midi)}_take1.wav", render([(0.2, [midi])], 2.0, seed=midi), SR)
    return build_templates(folder)


def test_note_names():
    assert parse_note("E2") == 40 and parse_note("bb3") == 58 and parse_note("G#3") == 56
    assert note_name(64) == "E4"
    assert parse_notes("E4, A2 e4") == [45, 64]
    with pytest.raises(ValueError):
        parse_note("H2")


@pytest.mark.parametrize("engine", ["model", "dsp"])
def test_single_note(tmp_path, engine):
    result = analyse(clip(tmp_path, "a2.wav", [(0.3, [45])], 2.0), engine=engine)
    assert result.segments and result.segments[0].lowest_note.pitch == 45
    assert abs(result.segments[0].start - 0.3) < 0.05
    assert 45 in {n.pitch for n in result.notes}


@pytest.mark.parametrize("engine", ["model", "dsp"])
def test_chord_then_chord(tmp_path, engine):
    second = parse_notes("D3 A3 D4 F#4")
    path = clip(tmp_path, "two.wav", [(0.3, CHORD), (2.0, second)], 3.7)
    result = analyse(path, engine=engine)
    first = score_span(result, 0.3, 2.0, set(CHORD))
    assert first.lowest_ok and first.recall >= 0.6 and first.pc_precision == 1.0
    later = score_span(result, 2.0, 3.7, set(second))
    assert later.pc_precision == 1.0 and later.pc_recall >= 0.6
    assert first.onset_err_ms < 50


def test_templates_roundtrip(tmp_path, templates):
    templates.save(tmp_path / "t.json")
    again = Templates.read(tmp_path / "t.json")
    assert set(again.harmonics) == set(templates.harmonics)
    assert np.isclose(again.get(45).sum(), 1.0, atol=1e-3)
    assert np.allclose(again.get(46), again.get(45))  # nearest recorded note stands in


def test_overtones_are_labeled_not_played(tmp_path, templates):
    result = analyse(clip(tmp_path, "a2.wav", [(0.3, [45])], 2.0), engine="dsp", templates=templates)
    seg = result.segments[0]
    layers = {p.name: p for p in seg.pitches}
    assert layers["A2"].layer == "played"
    assert layers["E4"].layer == "overtone" and layers["E4"].source == "3rd of A2"
    assert layers["E4"].source_pitch == 45 and layers["E4"].source_harmonic == 3
    assert seg.played() == {45}
    assert {n.pitch for n in result.notes} == {45}  # MIDI holds played notes only


def test_cli_writes_midi_and_json(tmp_path, capsys):
    path = clip(tmp_path, "memo.wav", [(0.3, CHORD)], 2.0)
    cli.main(["notes", str(path), "--engine", "dsp", "--out", str(tmp_path / "out"), "--no-templates"])
    assert (tmp_path / "out" / "memo.mid").stat().st_size > 0
    data = json.loads((tmp_path / "out" / "memo.json").read_text())
    seg = data["segments"][0]
    assert seg["lowest_note"] == {"pitch": 45, "name": "A2"}
    assert set(seg["pitches"][0]) == {
        "pitch", "name", "layer", "source", "source_pitch", "source_harmonic", "energy", "confidence",
    }
    assert all(0 <= p["energy"] <= 1 and 0 <= p["confidence"] <= 1 for p in seg["pitches"])
    assert data["notes"]


def test_compressed_audio_loads_through_ffmpeg(tmp_path):
    import shutil
    import subprocess

    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not installed")
    wav = clip(tmp_path, "memo.wav", [(0.3, [45])], 2.0)
    m4a = tmp_path / "memo.m4a"
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(wav), str(m4a)], check=True)
    result = analyse(m4a, engine="dsp")
    assert result.segments[0].lowest_note.pitch == 45
