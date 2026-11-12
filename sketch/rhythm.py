"""Rhythm cleanup: decide how each beat is divided, then land every strum on that division.

The light tidy in tidy.py only knows eighths and sixteenths. This pass picks a
*feel* for every beat — straight eighths, sixteenths or triplets — by how well
the strums in that beat fit each one, preferring the simpler feel when the fit
is close and preferring not to flip feel from one beat to the next. Notes then
snap to their beat's division, ends snap too, and small gaps before the next
strum are closed.
"""

from __future__ import annotations

import numpy as np

from extract.types import NoteEvent

from .grid import Grid
from .tidy import BLIP_SECONDS, BLIP_VELOCITY, STRUM_WINDOW, SketchNote, clean_overlaps

FEELS: dict[str, tuple[float, ...]] = {
    "eighths": (0.0, 0.5),
    "sixteenths": (0.0, 0.25, 0.5, 0.75),
    "triplets": (0.0, 1 / 3, 2 / 3),
}
# A finer feel must fit this much better (squared beats per beat) to be chosen.
# Set so that one strum played a little late stays an eighth, while two strums
# a sixteenth apart, or a pair on the triplet points, do change the feel.
FEEL_COST = {"eighths": 0.0, "sixteenths": 0.030, "triplets": 0.035}
MERGE_COST = 0.05  # two separate strums landing on the same slot
SWITCH_COST = 0.010  # changing feel between neighbouring beats
MIN_LENGTH = {"eighths": 0.25, "sixteenths": 0.25, "triplets": 1 / 3}


def _snap(position: float, feel: str) -> float:
    """Nearest point of this beat's division (the next beat's start counts too)."""
    beat = np.floor(position)
    points = [beat + x for x in FEELS[feel]] + [beat + 1.0]
    return float(min(points, key=lambda p: abs(p - position)))


def choose_feels(positions: list[float], n_beats: int) -> list[str]:
    """One feel per beat, by dynamic programming over fit + simplicity + continuity."""
    names = list(FEELS)
    in_beat: dict[int, list[float]] = {}
    for position in positions:
        if 0 <= int(position) < n_beats:
            in_beat.setdefault(int(position), []).append(position)
    cost = np.zeros((n_beats, len(names)))
    for beat, here in in_beat.items():
        for j, name in enumerate(names):
            slots = [_snap(p, name) for p in here]
            fit = sum((p - s) ** 2 for p, s in zip(here, slots))
            merged = len(slots) - len(set(slots))  # separate strums forced onto one slot
            cost[beat, j] = fit + MERGE_COST * merged + FEEL_COST[name]
    best = cost[0].copy()
    back = np.zeros((n_beats, len(names)), dtype=int)
    for b in range(1, n_beats):
        step = best[:, None] + SWITCH_COST * (1 - np.eye(len(names)))
        back[b] = step.argmin(axis=0)
        best = step.min(axis=0) + cost[b]
    path = [int(best.argmin())]
    for b in range(n_beats - 1, 0, -1):
        path.append(int(back[b, path[-1]]))
    # Beats nobody plays in have no feel of their own: call them eighths.
    return [names[j] if beat in in_beat else "eighths" for beat, j in enumerate(reversed(path))]


def clean(notes: list[NoteEvent], grid: Grid) -> tuple[list[SketchNote], list[str]]:
    """Returns (cleaned notes, feel per beat). Short quiet blips are left out, as in the light tidy."""
    kept = sorted(
        (n for n in notes if not (n.end - n.start < BLIP_SECONDS and n.velocity < BLIP_VELOCITY)),
        key=lambda n: (n.start, n.pitch),
    )
    strums: list[list[NoteEvent]] = []
    for n in kept:
        if strums and n.start - strums[-1][-1].start <= STRUM_WINDOW:
            strums[-1].append(n)
        else:
            strums.append([n])
    n_beats = len(grid.beat_times) - 1
    played = [float(grid.to_beats(s[0].start)) for s in strums]
    feels = choose_feels(played, n_beats)

    def feel_at(position: float) -> str:
        return feels[int(np.clip(position, 0, n_beats - 1))]

    slots = [_snap(p, feel_at(p)) for p in played]
    out: list[SketchNote] = []
    for i, (strum, slot) in enumerate(zip(strums, slots)):
        later = [s for s in slots[i + 1 :] if s > slot]
        next_slot = later[0] if later else None
        for n in strum:
            end = float(grid.to_beats(n.end))
            end = _snap(end, feel_at(end))
            # Close a small gap before the next strum so the line does not stutter.
            if next_slot is not None and 0 < next_slot - end <= 0.26:
                end = next_slot
            length = max(end - slot, MIN_LENGTH[feel_at(slot)])
            out.append(SketchNote(n.pitch, round(slot, 4), round(length, 4), round(n.velocity, 3)))
    return clean_overlaps(out), feels


def time_signature(meter: int, feels: list[str]) -> str:
    """Four beats that are mostly triplets is 12/8, not 4/4."""
    triplet_share = sum(f == "triplets" for f in feels) / max(len(feels), 1)
    return f"{meter * 3}/8" if triplet_share > 0.5 else f"{meter}/4"


def runs(feels: list[str]) -> list[dict]:
    """Per-beat feels as runs, for the sketch file."""
    out: list[dict] = []
    for beat, feel in enumerate(feels):
        if out and out[-1]["feel"] == feel:
            out[-1]["length"] += 1
        else:
            out.append({"beat": beat, "length": 1, "feel": feel})
    return out


def expand(feel_runs: list[dict], n_beats: int) -> list[str]:
    feels = ["eighths"] * n_beats
    for run in feel_runs:
        for b in range(run["beat"], min(run["beat"] + run["length"], n_beats)):
            feels[b] = run["feel"]
    return feels
