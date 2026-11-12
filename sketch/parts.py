"""Generated parts that follow the guitar: bass, pad and drums.

Deliberately plain. Each is a starting point to edit, not a finished part:

- bass: the lowest pitch class the guitar plays in each two-beat window, down an octave or two
- pad: the main pitch classes of each window, held, in the middle register
- drums: kick and snare by the bar, hi-hat on the beat's division (eighths or triplets)
"""

from __future__ import annotations

from .harmony import _sounding
from .tidy import SketchNote

KICK, SNARE, HAT = 36, 38, 42
# Beat numbers (0-based) within a bar.
DRUM_PATTERNS = {
    2: {"kick": [0], "snare": [1]},
    3: {"kick": [0], "snare": [2]},
    4: {"kick": [0, 2], "snare": [1, 3]},
    5: {"kick": [0, 3], "snare": [2, 4]},
    6: {"kick": [0], "snare": [3]},
}
PART_NAMES = ("bass", "pad", "drums")


def _windows(notes: list[SketchNote], n_beats: int, meter: int) -> list[tuple[int, int, dict[int, float]]]:
    """(start beat, length, sounding pitches) for each half bar (whole bar in 3)."""
    size = meter if meter % 2 else 2
    out = []
    for bar_start in range(0, n_beats, meter):
        for start in range(bar_start, min(bar_start + meter, n_beats), size):
            length = min(size, bar_start + meter - start, n_beats - start)
            pitches = _sounding(notes, start, start + length)
            if pitches:
                out.append((start, length, pitches))
    return out


def make_bass(notes: list[SketchNote], n_beats: int, meter: int) -> list[SketchNote]:
    out = []
    for start, length, pitches in _windows(notes, n_beats, meter):
        pitch = 28 + (min(pitches) - 28) % 12  # E1 .. D#2
        out.append(SketchNote(pitch, float(start), float(length), 0.8))
    return out


def make_pad(notes: list[SketchNote], n_beats: int, meter: int) -> list[SketchNote]:
    chords: list[tuple[int, int, tuple[int, ...]]] = []
    for start, length, pitches in _windows(notes, n_beats, meter):
        by_class: dict[int, float] = {}
        for p, w in pitches.items():
            by_class[p % 12] = by_class.get(p % 12, 0.0) + w
        top = max(by_class.values())
        classes = sorted(by_class, key=by_class.get, reverse=True)[:4]
        voiced = tuple(sorted(60 + pc for pc in classes if by_class[pc] >= 0.3 * top))  # C4 .. B4
        if chords and chords[-1][2] == voiced and chords[-1][0] + chords[-1][1] == start:
            chords[-1] = (chords[-1][0], chords[-1][1] + length, voiced)
        else:
            chords.append((start, length, voiced))
    return [SketchNote(p, float(start), float(length), 0.45) for start, length, voiced in chords for p in voiced]


def make_drums(notes: list[SketchNote], n_beats: int, meter: int, feels: list[str]) -> list[SketchNote]:
    if not notes:
        return []
    first = int(min(n.beat for n in notes)) // meter * meter
    last = int(max(n.beat + n.length for n in notes))
    pattern = DRUM_PATTERNS.get(meter, {"kick": [0], "snare": []})
    out = []
    for beat in range(first, min(last + 1, n_beats)):
        in_bar = beat % meter
        if in_bar in pattern["kick"]:
            out.append(SketchNote(KICK, float(beat), 0.25, 0.9))
        if in_bar in pattern["snare"]:
            out.append(SketchNote(SNARE, float(beat), 0.25, 0.8))
        steps = (0.0, 1 / 3, 2 / 3) if feels[beat] == "triplets" else (0.0, 0.5)
        for i, step in enumerate(steps):
            out.append(SketchNote(HAT, round(beat + step, 4), 0.25, 0.55 if i == 0 else 0.35))
    return out


def make_parts(
    notes: list[SketchNote], n_beats: int, meter: int, feels: list[str], only: tuple[str, ...] = PART_NAMES
) -> dict[str, list[SketchNote]]:
    makers = {
        "bass": lambda: make_bass(notes, n_beats, meter),
        "pad": lambda: make_pad(notes, n_beats, meter),
        "drums": lambda: make_drums(notes, n_beats, meter, feels),
    }
    return {name: makers[name]() for name in PART_NAMES if name in only}
