"""Helpers for composing: the chords a song uses and the scales its notes fit.

Both are read off the notes, as suggestions. A chord's `pitches` (the voicing
actually played) are the truth; its `name` is a best guess and is just the
note names when no common chord fits.
"""

from __future__ import annotations

import numpy as np

from extract.types import NOTE_NAMES

from .harmony import harmony_spans
from .tidy import SketchNote

# Intervals above the root -> suffix. Checked in this order, so plainer names win.
CHORD_SHAPES: list[tuple[frozenset[int], str]] = [
    (frozenset({0, 4, 7}), ""),
    (frozenset({0, 3, 7}), "m"),
    (frozenset({0, 7}), "5"),
    (frozenset({0, 4, 7, 10}), "7"),
    (frozenset({0, 4, 7, 11}), "maj7"),
    (frozenset({0, 3, 7, 10}), "m7"),
    (frozenset({0, 2, 7}), "sus2"),
    (frozenset({0, 5, 7}), "sus4"),
    (frozenset({0, 2, 4, 7}), "add9"),
    (frozenset({0, 2, 3, 7}), "m(add9)"),
    (frozenset({0, 4, 7, 9}), "6"),
    (frozenset({0, 3, 7, 9}), "m6"),
    (frozenset({0, 4, 5, 7}), "add11"),
    (frozenset({0, 5, 7, 10}), "7sus4"),
    (frozenset({0, 2, 4, 7, 11}), "maj9"),
    (frozenset({0, 2, 3, 7, 10}), "m9"),
    (frozenset({0, 2, 4, 7, 10}), "9"),
    (frozenset({0, 3, 6}), "dim"),
    (frozenset({0, 4, 8}), "aug"),
    (frozenset({0, 4, 10}), "7(no5)"),
    (frozenset({0, 3, 10}), "m7(no5)"),
    (frozenset({0, 4, 11}), "maj7(no5)"),
]

SCALES: dict[str, tuple[int, ...]] = {
    "major": (0, 2, 4, 5, 7, 9, 11),
    "minor": (0, 2, 3, 5, 7, 8, 10),
    "dorian": (0, 2, 3, 5, 7, 9, 10),
    "mixolydian": (0, 2, 4, 5, 7, 9, 10),
    "lydian": (0, 2, 4, 6, 7, 9, 11),
    "phrygian": (0, 1, 3, 5, 7, 8, 10),
    "harmonic minor": (0, 2, 3, 5, 7, 8, 11),
    "major pentatonic": (0, 2, 4, 7, 9),
    "minor pentatonic": (0, 3, 5, 7, 10),
}


def chord_name(pitches: list[int]) -> str:
    """Best-guess name for a set of pitches; the lowest note is tried as the root first."""
    classes = {p % 12 for p in pitches}
    bass = min(pitches) % 12
    for root in [bass, *sorted(classes - {bass})]:
        shape = frozenset((pc - root) % 12 for pc in classes)
        for intervals, suffix in CHORD_SHAPES:
            if shape == intervals:
                name = NOTE_NAMES[root] + suffix
                return name if root == bass else f"{name}/{NOTE_NAMES[bass]}"
    ordered = sorted(classes, key=lambda pc: (pc - bass) % 12)
    return " ".join(NOTE_NAMES[pc] for pc in ordered)


def chords_used(notes: list[SketchNote], n_beats: int, meter: int, limit: int = 16) -> list[dict]:
    """Distinct chords in the song, most used first: name, the voicing played, and how many beats it sounds."""
    found: dict[tuple[int, frozenset[int]], dict] = {}
    for span in harmony_spans(notes, n_beats, meter):
        pitches = sorted({n.pitch for n in notes if n.beat < span["beat"] + span["length"] and n.beat + n.length > span["beat"]})
        sounding = [p for p in pitches if any(_name(p) == name for name in span["pitches"])]
        classes = frozenset(p % 12 for p in sounding)
        if len(classes) < 2:
            continue
        key = (min(sounding) % 12, classes)
        entry = found.setdefault(key, {"beats": 0, "longest": 0, "pitches": sounding})
        entry["beats"] += span["length"]
        if span["length"] > entry["longest"]:
            entry["longest"], entry["pitches"] = span["length"], sounding
    ranked = sorted(found.values(), key=lambda e: e["beats"], reverse=True)
    return [
        {"name": chord_name(e["pitches"]), "pitches": e["pitches"], "beats": e["beats"]}
        for e in ranked[:limit] if e["beats"] >= 2
    ]


def _name(pitch: int) -> str:
    return f"{NOTE_NAMES[pitch % 12]}{pitch // 12 - 1}"


def _histogram(notes: list[SketchNote], start: float, end: float) -> np.ndarray:
    hist = np.zeros(12)
    for n in notes:
        overlap = min(n.beat + n.length, end) - max(n.beat, start)
        if overlap > 0:
            hist[n.pitch % 12] += overlap * n.velocity
    return hist


def _rank_scales(hist: np.ndarray, bass_hist: np.ndarray) -> list[dict]:
    total = hist.sum()
    if total <= 0:
        return []
    out = []
    for tonic in range(12):
        for name, steps in SCALES.items():
            classes = [(tonic + s) % 12 for s in steps]
            inside = hist[classes].sum() / total  # share of what is played that the scale covers
            used = float(np.mean(hist[classes] > 0.02 * total))  # share of the scale that is actually played
            home = (hist[tonic] + bass_hist[tonic]) / (total + bass_hist.sum())  # how much the tonic is leaned on
            out.append({
                "name": f"{NOTE_NAMES[tonic]} {name}", "tonic": tonic, "pitch_classes": sorted(classes),
                "fit": round(float(inside), 3), "_score": inside + 0.25 * used + 0.6 * home,
            })
    return sorted(out, key=lambda s: s["_score"], reverse=True)


def likely_scales(notes: list[SketchNote], n_beats: int, meter: int, window_bars: int = 8, top: int = 4) -> list[dict]:
    """Scales the notes fit: the best few for the whole song, plus any stretch where a different one fits better.

    Each has `fit` (share of the playing inside the scale) and the bars it
    covers (1-based, inclusive). A stretch with its own scale suggests a key change.
    """
    bass = [n for n in notes if n.pitch < 52]
    whole = _rank_scales(_histogram(notes, 0, n_beats), _histogram(bass, 0, n_beats))
    n_bars = max(1, n_beats // meter)
    out = [{**s, "bars": [1, n_bars]} for s in whole[:top]]
    main = out[0] if out else None
    span = window_bars * meter
    regional: list[dict] = []
    for start in range(0, n_beats - span + 1, span):
        ranked = _rank_scales(_histogram(notes, start, start + span), _histogram(bass, start, start + span))
        if not ranked or main is None:
            continue
        best = ranked[0]
        main_here = next(s for s in ranked if s["name"] == main["name"])
        # Only call it a change when the song's main scale clearly fits worse here.
        if best["name"] != main["name"] and best["fit"] >= main_here["fit"] + 0.08:
            bars = [start // meter + 1, (start + span) // meter]
            if regional and regional[-1]["name"] == best["name"] and regional[-1]["bars"][1] == bars[0] - 1:
                regional[-1]["bars"][1] = bars[1]
            else:
                regional.append({**best, "bars": bars})
    for s in out + regional:
        s.pop("_score", None)
    return out + regional
