"""Tidy the raw notes: drop stray blips and pull strums onto the beat grid.

Rules, in order:

1. Drop notes that are both very short and very quiet. They are listed in the
   sketch under `dropped` with the reason, so nothing disappears silently.
2. Group notes that start within 60 ms of each other into one strum.
3. Snap each strum to the nearest eighth note. If the previous strum already
   took that slot, the playing is faster than eighths there, so use the
   nearest sixteenth instead (unless it follows almost at once: then it is
   the tail of the same strum).
4. Snap note ends to sixteenths, and cut a note short when the same pitch is
   struck again.
"""

from __future__ import annotations

from dataclasses import dataclass

from extract.types import NoteEvent

from .grid import Grid

STRUM_WINDOW = 0.06  # s
SAME_STRUM_BEATS = 0.17  # strums closer than this share a slot
BLIP_SECONDS = 0.12
BLIP_VELOCITY = 0.4


@dataclass
class SketchNote:
    pitch: int
    beat: float  # start, in beats from the start of bar 1
    length: float  # in beats
    velocity: float  # 0-1


def tidy(notes: list[NoteEvent], grid: Grid, strength: float = 1.0) -> tuple[list[SketchNote], list[dict]]:
    """Returns (tidied notes, dropped notes with reasons).

    `strength` 1.0 snaps fully onto the grid; 0.5 moves each strum halfway there; 0 keeps the played timing.
    """
    kept: list[NoteEvent] = []
    dropped: list[dict] = []
    for n in sorted(notes, key=lambda n: (n.start, n.pitch)):
        if n.end - n.start < BLIP_SECONDS and n.velocity < BLIP_VELOCITY:
            dropped.append({
                "pitch": n.pitch, "start": round(n.start, 3), "end": round(n.end, 3),
                "velocity": round(n.velocity, 3), "reason": "short and quiet",
            })
        else:
            kept.append(n)

    strums: list[list[NoteEvent]] = []
    for n in kept:
        if strums and n.start - strums[-1][-1].start <= STRUM_WINDOW:
            strums[-1].append(n)
        else:
            strums.append([n])

    out: list[SketchNote] = []
    last_slot = last_played = None
    for strum in strums:
        played = float(grid.to_beats(strum[0].start))
        slot = round(played * 2) / 2
        if last_slot is not None and slot <= last_slot:
            # The eighth is taken. A clearly later strum goes on the sixteenth;
            # one that follows almost at once is the tail of the same strum.
            slot = round(played * 4) / 4 if played - last_played >= SAME_STRUM_BEATS else last_slot
            slot = max(slot, last_slot)
        last_slot, last_played = slot, played
        start = played + strength * (slot - played)
        for n in strum:
            end = float(grid.to_beats(n.end))
            length = max(0.25, round((end - played) * 4) / 4) if strength > 0 else max(0.1, end - played)
            out.append(SketchNote(n.pitch, round(start, 3), round(length, 3), round(n.velocity, 3)))
    return clean_overlaps(out), dropped


def clean_overlaps(notes: list[SketchNote]) -> list[SketchNote]:
    """Merge duplicates at the same spot and stop a note when its pitch is struck again."""
    notes = sorted(notes, key=lambda n: (n.pitch, n.beat))
    out: list[SketchNote] = []
    for n in notes:
        prev = out[-1] if out and out[-1].pitch == n.pitch else None
        if prev is not None and n.beat <= prev.beat + 1e-6:
            prev.length = max(prev.length, n.length)
            prev.velocity = max(prev.velocity, n.velocity)
            continue
        if prev is not None and prev.beat + prev.length > n.beat:
            prev.length = round(n.beat - prev.beat, 3)
        out.append(n)
    return sorted(out, key=lambda n: (n.beat, n.pitch))
