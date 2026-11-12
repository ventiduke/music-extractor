"""Tempo: sharpen a beat grid with the notes, and tell sustained tempo changes from wobble.

Taps say *which* beat; they are only good to about 50 ms. Strums say *when*,
to about 10 ms, but not which beat they belong to. `refine` combines them.

`tempo_sections` then splits the piece into stretches of steady tempo. A
change has to last at least two bars and be at least about 5% to make a new
section; anything shorter or smaller is treated as loose timing and ironed out
in the steady renders. Each section reports how loose the playing was inside it.
"""

from __future__ import annotations

import numpy as np

MIN_BARS = 2
CHANGE_PENALTY = 0.012  # squared log-tempo error a new section must save
MERGE_BELOW = 0.04  # neighbouring sections closer than 4% in tempo are one section


def refine(times: np.ndarray, strums: np.ndarray, division: int, reach: float = 0.2, passes: int = 2) -> np.ndarray:
    """Move each beat to where the strums around it say it is.

    Runs `passes` times: the second pass measures from an already better grid.
    """
    for _ in range(passes):
        times = _refine_once(np.asarray(times, dtype=float), strums, division, reach)
    return times


def _refine_once(times: np.ndarray, strums: np.ndarray, division: int, reach: float) -> np.ndarray:
    """One pass of `refine`.

    Every strum within `reach` beats of a subdivision point votes for where its
    beat should be. Beats with votes take their median; beats without are
    carried along by their neighbours. A light smoothing keeps one odd strum
    from bending the grid.
    """
    index = np.arange(len(times))
    position = np.interp(strums, times, index)
    slot = np.round(position * division) / division
    near = np.abs(position - slot) <= reach / division * 2
    gaps = np.gradient(times)
    votes: dict[int, list[float]] = {}
    for t, s, ok in zip(strums, slot, near):
        beat = int(np.round(s))
        if ok and 0 <= beat < len(times) and abs(s - beat) < 0.5:
            votes.setdefault(beat, []).append(t - (s - beat) * gaps[beat])
    shift = np.zeros(len(times))
    known = sorted(votes)
    if not known:
        return times
    estimates = np.array([np.median(votes[b]) - times[b] for b in known])
    shift = np.interp(index, known, estimates)
    padded = np.pad(shift, 1, mode="edge")
    shift = 0.25 * padded[:-2] + 0.5 * padded[1:-1] + 0.25 * padded[2:]
    refined = times + shift
    # Never let beats cross or bunch up.
    floor = 0.5 * float(np.median(np.diff(times)))
    for i in range(1, len(refined)):
        if refined[i] - refined[i - 1] < floor:
            refined[i] = refined[i - 1] + floor
    return refined


def tempo_sections(beat_times: list[float], meter: int) -> list[dict]:
    """Split the grid into steady-tempo sections: [{"beat", "length", "bpm", "looseness_ms"}, ...]."""
    times = np.asarray(beat_times, dtype=float)
    n_bars = (len(times) - 1) // meter
    if n_bars < 1:
        return [{"beat": 0, "length": len(times) - 1, "bpm": round(60.0 / float(np.median(np.diff(times))), 1)}]
    bar_seconds = np.array([times[(b + 1) * meter] - times[b * meter] for b in range(n_bars)])
    log_tempo = np.log(60.0 * meter / bar_seconds)

    # Fewest sections that explain the bar tempos: dynamic programming with a cost per section.
    def cost(a: int, b: int) -> float:
        seg = log_tempo[a:b]
        return float(((seg - np.median(seg)) ** 2).sum())

    best = [0.0] + [np.inf] * n_bars
    cut = [0] * (n_bars + 1)
    for end in range(1, n_bars + 1):
        for start in range(0, end - MIN_BARS + 1 if end >= MIN_BARS else 1):
            if start and start < MIN_BARS:
                continue
            total = best[start] + cost(start, end) + CHANGE_PENALTY
            if total < best[end]:
                best[end], cut[end] = total, start
    bounds = [n_bars]
    while bounds[-1] > 0:
        bounds.append(cut[bounds[-1]])
    bounds = bounds[::-1]

    spans = [[a, b] for a, b in zip(bounds, bounds[1:])]
    merged = [spans[0]]
    for a, b in spans[1:]:
        last = merged[-1]
        if abs(np.median(log_tempo[a:b]) - np.median(log_tempo[last[0] : last[1]])) < MERGE_BELOW:
            last[1] = b
        else:
            merged.append([a, b])

    sections = []
    for a, b in merged:
        first, last = a * meter, b * meter
        gaps = np.diff(times[first : last + 1])
        typical = float(np.median(gaps))
        sections.append({
            "beat": first,
            "length": last - first,
            "bpm": round(60.0 / typical, 1),
            # How far single beats strayed from this section's steady pulse.
            "looseness_ms": int(round(1000 * float(np.median(np.abs(gaps - typical))) * 1.4826)),
        })
    sections[-1]["length"] = len(times) - 1 - sections[-1]["beat"]  # beats past the last full bar
    return sections


def per_beat(sections: list[dict], n_beats: int, default: float) -> list[float]:
    bpms = [default] * n_beats
    for s in sections:
        for b in range(s["beat"], min(s["beat"] + s["length"], n_beats)):
            bpms[b] = float(s["bpm"])
    return bpms


def as_sections(bpms: list[float], old: list[dict] | None = None) -> list[dict]:
    """Per-beat tempos back to runs (keeping `looseness_ms` where a run still starts where it did)."""
    keep = {(s["beat"], s["bpm"]): s.get("looseness_ms") for s in old or []}
    out: list[dict] = []
    for beat, bpm in enumerate(bpms):
        if out and out[-1]["bpm"] == bpm:
            out[-1]["length"] += 1
        else:
            out.append({"beat": beat, "length": 1, "bpm": bpm})
    for s in out:
        if keep.get((s["beat"], s["bpm"])) is not None:
            s["looseness_ms"] = keep[(s["beat"], s["bpm"])]
    return out


def steady_times(bpms: list[float]) -> np.ndarray:
    """When each beat starts in the constructed (recording-free) version: section tempos kept, wobble gone."""
    return np.concatenate([[0.0], np.cumsum([60.0 / b for b in bpms])])


def best_division(times: np.ndarray, strums: np.ndarray) -> tuple[int, dict[int, float]]:
    """Does the beat divide in two or three? Compares how well strums sit on halves vs thirds.

    Returns the clearly better division (0 if too close to call) and each one's
    fit as a share of what random timing would score (lower is better; about
    1.0 means no fit at all).
    """
    position = np.interp(strums, times, np.arange(len(times)))
    fit = {}
    for division in (2, 3):
        scaled = position * division
        scaled = scaled - np.median(scaled - np.round(scaled))  # taps run a little early or late as a whole
        error = np.abs(scaled - np.round(scaled)) / division
        fit[division] = round(float(error.mean() / (1 / (4 * division))), 2)
    if fit[3] < fit[2] - 0.1:
        return 3, fit
    if fit[2] < fit[3] - 0.1:
        return 2, fit
    return 0, fit  # too close to call
