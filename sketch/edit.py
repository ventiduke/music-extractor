"""Edit operations on a sketch. Each one changes the sketch in place and logs itself in `history`.

Bars are 1-based and inclusive, as in the sketch file. `parts` names which
lines an operation touches: "guitar" (the sketch's `notes`), "bass", "pad",
"drums", or "all".
"""

from __future__ import annotations

import numpy as np

from .build import as_notes, as_rows, bpms_of, feels_of, grid_of
from .parts import PART_NAMES, make_parts
from .rhythm import runs
from .tempo import as_sections

ALL_PARTS = ("guitar", *PART_NAMES)
PITCHED = ("guitar", "bass", "pad")


def parse_bars(text: str | None, sketch: dict) -> tuple[int, int]:
    """'5-8' or '5' -> (5, 8); None -> the whole song."""
    if not text:
        return 1, sketch["bars"]
    first, _, last = text.partition("-")
    a, b = int(first), int(last or first)
    if not 1 <= a <= b <= sketch["bars"]:
        raise SystemExit(f"bars {text}: the song has bars 1-{sketch['bars']}")
    return a, b


def _lists(sketch: dict, parts: tuple[str, ...]) -> dict[str, list[dict]]:
    """The note lists named by `parts` (missing generated parts are skipped)."""
    names = ALL_PARTS if "all" in parts else parts
    found = {}
    for name in names:
        if name == "guitar":
            found[name] = sketch["notes"]
        elif name in sketch.get("parts", {}):
            found[name] = sketch["parts"][name]
    return found


def _set(sketch: dict, name: str, rows: list[dict]) -> None:
    if name == "guitar":
        sketch["notes"] = rows
    else:
        sketch["parts"][name] = rows


def _span(sketch: dict, bars: tuple[int, int]) -> tuple[float, float]:
    meter = sketch["meter"]
    return (bars[0] - 1) * meter, bars[1] * meter


def _log(sketch: dict, op: str, **args) -> None:
    sketch.setdefault("history", []).append({"op": op, **{k: v for k, v in args.items() if v is not None}})


def transpose(sketch: dict, semitones: int, bars=None, parts=("all",)) -> int:
    """Move pitches up or down. Drums are never transposed."""
    start, end = _span(sketch, parse_bars(bars, sketch))
    count = 0
    for name, rows in _lists(sketch, parts).items():
        if name not in PITCHED:
            continue
        for r in rows:
            if start <= r["beat"] < end:
                r["pitch"] = int(np.clip(r["pitch"] + semitones, 0, 127))
                count += 1
    _log(sketch, "transpose", semitones=semitones, bars=bars, parts=list(parts))
    return count


def velocity(sketch: dict, scale: float, bars=None, parts=("all",)) -> int:
    """Make notes louder (scale > 1) or softer (< 1)."""
    start, end = _span(sketch, parse_bars(bars, sketch))
    count = 0
    for rows in _lists(sketch, parts).values():
        for r in rows:
            if start <= r["beat"] < end:
                r["velocity"] = round(float(np.clip(r["velocity"] * scale, 0.05, 1.0)), 3)
                count += 1
    _log(sketch, "velocity", scale=scale, bars=bars, parts=list(parts))
    return count


def clear(sketch: dict, bars=None, parts=("all",)) -> int:
    """Remove the notes in these bars; the bars themselves stay (silence)."""
    start, end = _span(sketch, parse_bars(bars, sketch))
    count = 0
    for name, rows in _lists(sketch, parts).items():
        kept = [r for r in rows if not start <= r["beat"] < end]
        count += len(rows) - len(kept)
        _set(sketch, name, kept)
    _log(sketch, "clear", bars=bars, parts=list(parts))
    return count


def thin(sketch: dict, grid: float | None = None, min_velocity: float | None = None, bars=None, parts=("guitar",)) -> int:
    """Thin a part out: keep only notes that start on multiples of `grid` beats, and/or at least `min_velocity` loud."""
    start, end = _span(sketch, parse_bars(bars, sketch))
    count = 0
    for name, rows in _lists(sketch, parts).items():
        kept = []
        for r in rows:
            inside = start <= r["beat"] < end
            off_grid = grid is not None and abs(r["beat"] / grid - round(r["beat"] / grid)) > 1e-3
            quiet = min_velocity is not None and r["velocity"] < min_velocity
            if inside and (off_grid or quiet):
                count += 1
            else:
                kept.append(r)
        _set(sketch, name, kept)
    _log(sketch, "thin", grid=grid, min_velocity=min_velocity, bars=bars, parts=list(parts))
    return count


def tempo(sketch: dict, bpm: float, bars=None) -> None:
    """Set the steady tempo of these bars (default: the whole song, as one section).

    Affects the MIDI and the steady previews, not the play-along-with-memo ones.
    """
    start, end = _span(sketch, parse_bars(bars, sketch))
    bpms = bpms_of(sketch)
    for beat in range(int(start), min(int(end), len(bpms))):
        bpms[beat] = round(float(bpm), 1)
    sketch["tempo_map"] = as_sections(bpms, sketch.get("tempo_map"))
    sketch["tempo_bpm"] = round(float(np.median(bpms)), 1)
    _log(sketch, "tempo", bpm=bpm, bars=bars)


def _restructure(sketch: dict, start: float, end: float, copies: int) -> None:
    """Keep `copies` consecutive copies of beats [start, end): 0 deletes them, 2 plays them twice, ..."""
    length = end - start
    shift = (copies - 1) * length
    lists = {**_lists(sketch, ("all",)), "light_notes": sketch.get("light_notes", [])}
    for name, rows in lists.items():
        out = []
        for r in rows:
            if r["beat"] < start:
                if copies == 0 and r["beat"] + r["length"] > start:
                    r = {**r, "length": round(start - r["beat"], 4)}  # do not ring into the cut
                out.append(r)
            elif r["beat"] < end:
                out.extend({**r, "beat": round(r["beat"] + k * length, 4)} for k in range(copies))
            else:
                out.append({**r, "beat": round(r["beat"] + shift, 4)})
        if name == "light_notes":
            sketch["light_notes"] = out
        else:
            _set(sketch, name, out)
    s, e = int(start), int(end)
    feels, bpms = feels_of(sketch), bpms_of(sketch)
    sketch["feel"] = runs(feels[:s] + feels[s:e] * copies + feels[e:])
    sketch["tempo_map"] = as_sections(bpms[:s] + bpms[s:e] * copies + bpms[e:], None)
    gaps = list(np.diff(sketch["beat_times"]))
    gaps = gaps[:s] + gaps[s:e] * copies + gaps[e:]
    sketch["beat_times"] = [round(float(t), 4) for t in np.concatenate([[sketch["beat_times"][0]], sketch["beat_times"][0] + np.cumsum(gaps)])]
    sketch["bars"] = (len(sketch["beat_times"]) - 1) // sketch["meter"]
    sketch["structure_edited"] = True  # the sketch no longer lines up with the memo recording


def repeat(sketch: dict, bars: str, times: int = 1) -> None:
    """Play these bars `times` more times, right after themselves; everything later moves back."""
    start, end = _span(sketch, parse_bars(bars, sketch))
    _restructure(sketch, start, end, copies=1 + times)
    _log(sketch, "repeat", bars=bars, times=times)


def delete(sketch: dict, bars: str) -> None:
    """Cut these bars out; everything later moves forward."""
    start, end = _span(sketch, parse_bars(bars, sketch))
    _restructure(sketch, start, end, copies=0)
    _log(sketch, "delete", bars=bars)


def regenerate(sketch: dict, only: tuple[str, ...] = PART_NAMES) -> None:
    """Rebuild generated parts from the current guitar notes (overwrites edits to those parts)."""
    grid = grid_of(sketch)
    made = make_parts(as_notes(sketch["notes"]), len(grid.beat_times) - 1, grid.meter, feels_of(sketch), only=only)
    for name, part in made.items():
        sketch.setdefault("parts", {})[name] = as_rows(part, grid, drums=name == "drums")
    _log(sketch, "parts", only=list(only))


def overview(sketch: dict, bars=None) -> str:
    """A bar-by-bar text summary: harmony spans, feel, and how many notes each part has."""
    a, b = parse_bars(bars, sketch)
    meter = sketch["meter"]
    feels = feels_of(sketch)
    key = sketch["key"]
    tempos = sketch.get("tempo_map", [])
    tempo_text = (
        f"{tempos[0]['bpm']:g} bpm" if len(tempos) == 1
        else f"{min(t['bpm'] for t in tempos):g}-{max(t['bpm'] for t in tempos):g} bpm in {len(tempos)} tempo sections"
    )
    lines = [
        f"{sketch['source']}: {tempo_text}, {sketch['time_signature']}, {sketch['bars']} bars, "
        f"key {key['tonic']} {key['mode']}, beat from {sketch.get('beats_from', 'tracker')}"
        + ("" if sketch.get("beats_from") == "taps" else f" (bar lines {sketch['downbeat_confidence']:.0%} sure)")
    ]
    if len(tempos) > 1:
        for t in tempos:
            loose = f", timing loose by about {t['looseness_ms']} ms" if "looseness_ms" in t else ""
            lines.append(f"  tempo: bars {t['bar']}-{t['bar'] + t['bars'] - 1}: {t['bpm']:g} bpm{loose}")
    for bar in range(a, b + 1):
        first, last = (bar - 1) * meter, bar * meter
        spans = [h for h in sketch["harmony"] if h["beat"] < last and h["beat"] + h["length"] > first]
        harmony = "  ".join(
            # "~" marks a span carried over from an earlier bar
            f"{h['beat_in_bar'] if h['beat'] >= first else '~'}:{h['bass']}[{' '.join(h['pitch_classes'])}]"
            for h in spans
        ) or "-"
        bar_feels = sorted(set(feels[(bar - 1) * meter : bar * meter]))
        counts = {name: sum(r["bar"] == bar for r in rows) for name, rows in _lists(sketch, ("all",)).items()}
        notes = " ".join(f"{name} {n}" for name, n in counts.items())
        lines.append(f"bar {bar:>3} | {harmony} | {'/'.join(bar_feels)} | {notes}")
    return "\n".join(lines)
