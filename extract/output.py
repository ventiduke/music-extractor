"""Write the two files each memo produces: MIDI and the JSON sidecar."""

from __future__ import annotations

import json
import warnings
from pathlib import Path

from .pipeline import Result

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    import pretty_midi


def write_midi(result: Result, path: Path) -> None:
    midi = pretty_midi.PrettyMIDI()
    guitar = pretty_midi.Instrument(program=25, name="Guitar")  # steel-string acoustic
    for n in result.notes:
        velocity = int(min(127, max(1, round(30 + 97 * n.velocity))))
        guitar.notes.append(pretty_midi.Note(velocity=velocity, pitch=n.pitch, start=n.start, end=n.end))
    midi.instruments.append(guitar)
    midi.write(str(path))


def write_json(result: Result, path: Path) -> None:
    path.write_text(json.dumps(result.to_json(), indent=1))


def write(result: Result, out_dir: str | Path, stem: str) -> tuple[Path, Path]:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    mid, sidecar = out / f"{stem}.mid", out / f"{stem}.json"
    write_midi(result, mid)
    write_json(result, sidecar)
    return mid, sidecar
