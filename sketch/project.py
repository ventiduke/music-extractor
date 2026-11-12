"""Song project: the file the editor works on.

A sketch describes one recording. A project is what gets *constructed* from
it: tempo, time signature and sections as blocks over the bars; tracks of
notes placed in those bars; and a palette (chords used, likely scales) to
compose with. It no longer refers to the recording's timing.

`tempo`, `signature` and `sections` are change lists: each entry applies from
its `bar` (0-based) until the next entry. Positions are musical, so content
follows the bars: a note is [bar, position in beats within the bar, length in
beats, pitch, velocity]. A signature is `beats` (how many you would tap) and
`division` (2 or 3: how each tap divides), so 2 beats dividing in 3 is 6/8.
The editor's own description of the format is in web/editor/model.js.
"""

from __future__ import annotations

import json
from pathlib import Path

from .build import as_notes, bpms_of, feels_of
from .theory import chords_used, likely_scales

VERSION = 2
INSTRUMENTS = {"guitar": "pluck", "bass": "bass", "pad": "pad", "drums": "kit"}
VOLUMES = {"guitar": 0.9, "bass": 0.8, "pad": 0.5, "drums": 0.7}


def from_sketch(sketch: dict) -> dict:
    meter = sketch["meter"]
    n_beats = len(sketch["beat_times"]) - 1
    n_bars = n_beats // meter
    bpms, feels = bpms_of(sketch), feels_of(sketch)
    division = int(sketch.get("division", 2))
    if division != 3 and sum(f == "triplets" for f in feels) > len(feels) / 2:
        division = 3
    tempo: list[dict] = []
    for bar in range(n_bars):
        if not tempo or tempo[-1]["bpm"] != bpms[bar * meter]:
            tempo.append({"bar": bar, "bpm": bpms[bar * meter]})
    sections = [
        {"bar": row["bar"] - 1, "name": f"Part {i + 1}"}
        for i, row in enumerate(sketch.get("tempo_map") or [{"bar": 1}])
        if row["bar"] - 1 < n_bars
    ]

    def rows(notes: list[dict]) -> list[list]:
        out = []
        for n in notes:
            bar = int(n["beat"] // meter)
            if bar < n_bars:
                out.append([bar, round(n["beat"] - bar * meter, 4), n["length"], n["pitch"], n["velocity"]])
        return out

    tracks = [{
        "id": "guitar", "name": "Guitar", "kind": "pitched", "instrument": INSTRUMENTS["guitar"],
        "volume": VOLUMES["guitar"], "mute": False, "notes": rows(sketch["notes"]),
    }]
    for name, part in sketch.get("parts", {}).items():
        tracks.append({
            "id": name, "name": name.capitalize(), "kind": "drums" if name == "drums" else "pitched",
            "instrument": INSTRUMENTS.get(name, "pluck"), "volume": VOLUMES.get(name, 0.7), "mute": False,
            "notes": rows(part),
        })
    guitar = as_notes(sketch["notes"])
    stem = Path(sketch["source"]).stem
    return {
        "version": VERSION,
        "id": stem,
        "title": stem,
        "source": sketch["source"],
        "bars": n_bars,
        "tempo": tempo,
        "signature": [{"bar": 0, "beats": meter, "division": division}],
        "sections": sections,
        "tracks": tracks,
        "chords": chords_used(guitar, n_beats, meter),
        "scales": likely_scales(guitar, n_beats, meter),
    }


def write(project: dict, path: str | Path) -> Path:
    path = Path(path)
    path.write_text(json.dumps(project, separators=(",", ":")))
    return path


def publish(project: dict, folder: str | Path) -> Path:
    """Put a project where the web editor looks for bundled songs, and list it in index.json."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    name = f"{project['id']}.project.json"
    write(project, folder / name)
    index_path = folder / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else []
    index = [e for e in index if e["id"] != project["id"]] + [{"id": project["id"], "title": project["title"], "file": name}]
    index_path.write_text(json.dumps(sorted(index, key=lambda e: e["title"]), indent=1) + "\n")
    return folder / name
