"""What the notes add up to: an estimated key, and the pitch set sounding over each stretch of beats.

No chord names and no chord dictionary: a span is just its bass note and the
pitches that sound, so unusual voicings come through as they are.
"""

from __future__ import annotations

import numpy as np

from extract.types import NOTE_NAMES, note_name

from .tidy import SketchNote

# Krumhansl-Kessler key profiles.
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def estimate_key(notes: list[SketchNote]) -> dict:
    hist = np.zeros(12)
    for n in notes:
        hist[n.pitch % 12] += n.length * n.velocity
    if hist.sum() == 0:
        return {"tonic": None, "mode": None, "confidence": 0.0}
    scores = []
    for tonic in range(12):
        for mode, profile in (("major", _MAJOR), ("minor", _MINOR)):
            scores.append((float(np.corrcoef(hist, np.roll(profile, tonic))[0, 1]), tonic, mode))
    scores.sort(reverse=True)
    best, runner_up = scores[0], scores[1]
    return {
        "tonic": NOTE_NAMES[best[1]],
        "mode": best[2],
        "confidence": round(max(0.0, best[0] - runner_up[0]) / max(best[0], 1e-9), 2),
        "runner_up": f"{NOTE_NAMES[runner_up[1]]} {runner_up[2]}",
    }


def _sounding(notes: list[SketchNote], start: float, end: float) -> dict[int, float]:
    weights: dict[int, float] = {}
    for n in notes:
        overlap = min(n.beat + n.length, end) - max(n.beat, start)
        if overlap > 0:
            weights[n.pitch] = weights.get(n.pitch, 0.0) + overlap * n.velocity
    if not weights:
        return {}
    top = max(weights.values())
    return {p: w for p, w in weights.items() if w >= 0.25 * top}


def harmony_spans(notes: list[SketchNote], n_beats: int, meter: int) -> list[dict]:
    """Merge consecutive beats with the same bass and mostly the same pitch classes into spans."""
    spans: list[dict] = []
    for beat in range(n_beats):
        pitches = _sounding(notes, beat, beat + 1)
        if not pitches:
            continue
        pcs = {p % 12 for p in pitches}
        bass = min(pitches)
        prev = spans[-1] if spans else None
        same_bar = prev is not None and prev["beat"] // meter == beat // meter
        if (
            prev is not None
            and prev["beat"] + prev["length"] == beat
            and prev["_bass"] % 12 == bass % 12
            and len(pcs & prev["_pcs"]) / len(pcs | prev["_pcs"]) >= 0.6
            and (same_bar or pcs == prev["_pcs"])
        ):
            prev["length"] += 1
            continue
        spans.append({"beat": beat, "length": 1, "_bass": bass, "_pcs": pcs})
    for s in spans:
        pitches = _sounding(notes, s["beat"], s["beat"] + s["length"])
        s.pop("_bass"), s.pop("_pcs")
        s["bar"] = s["beat"] // meter + 1
        s["beat_in_bar"] = s["beat"] % meter + 1
        s["bass"] = note_name(min(pitches))
        s["pitches"] = [note_name(p) for p in sorted(pitches)]
        s["pitch_classes"] = [NOTE_NAMES[pc] for pc in sorted({p % 12 for p in pitches})]
    return spans
