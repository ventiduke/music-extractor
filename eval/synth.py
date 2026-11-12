"""Synthetic guitar clips for checking the pipeline end to end.

This is NOT a substitute for real recordings: a synthetic string is far
cleaner than a phone memo, so scores on this set only prove the code works.
Usage: `python -m eval.synth data/synth` writes templates/, clips/ and labels.csv.
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

from extract.types import note_name, parse_notes

SR = 22050


def pluck(midi: int, dur: float, rng: np.random.Generator, level: float = 1.0) -> np.ndarray:
    """One plucked string: decaying, slightly inharmonic partials with a thin low end."""
    f0 = 440.0 * 2 ** ((midi - 69) / 12)
    t = np.arange(int(SR * dur)) / SR
    y = np.zeros_like(t)
    position = rng.uniform(0.13, 0.22)  # where along the string it is plucked
    for k in range(1, 25):
        f = k * f0 * np.sqrt(1 + 1e-4 * k * k)
        if f > SR / 2 - 500:
            break
        amp = abs(np.sin(np.pi * k * position)) / k
        amp *= 1 / np.sqrt(1 + (150 / f) ** 4)  # phone mics lose bass
        y += amp * np.exp(-t * (1.0 + 0.3 * k)) * np.sin(2 * np.pi * f * t + rng.uniform(0, 6.28))
    y[: int(0.004 * SR)] *= np.linspace(0, 1, int(0.004 * SR))
    return level * y


def render(
    events: list[tuple[float, list[int]]], dur: float, seed: int = 0, let_ring: bool = False
) -> np.ndarray:
    """Mix strums: each event is (time, pitches); strings are struck 12 ms apart."""
    rng = np.random.default_rng(seed)
    y = np.zeros(int(SR * dur))
    stops = [t for t, _ in events[1:]] + [dur]
    fade = int(0.04 * SR)
    for (time, pitches), stop in zip(events, stops):
        for i, midi in enumerate(sorted(pitches)):
            a = int((time + 0.012 * i) * SR)
            ring = dur - time if let_ring else stop - time  # the hand damps the old chord
            note = pluck(midi, ring, rng, level=rng.uniform(0.7, 1.0))[: len(y) - a]
            note[-fade:] *= np.linspace(1, 0, fade)
            y[a : a + len(note)] += note
    y += rng.normal(0, 0.002 * np.abs(y).max(), len(y))
    return (0.8 * y / np.abs(y).max()).astype(np.float32)


CLIPS = {
    # name: list of (start time, notes) — includes voicings no chord chart has
    "open_e_a_d": [(0.3, "E2 B2 E3 G#3 B3 E4"), (2.0, "A2 E3 A3 C#4 E4"), (3.7, "D3 A3 D4 F#4")],
    "g_c_em": [(0.3, "G2 B2 D3 G3 B3 G4"), (2.0, "C3 E3 G3 C4 E4"), (3.7, "E2 B2 E3 G3 B3 E4")],
    "clusters": [(0.3, "E2 B2 F#3 G3 B3 E4"), (2.0, "A2 E3 B3 C4 E4"), (3.7, "D3 A3 C#4 E4")],
    "wide_fourths": [(0.3, "E2 A2 D3 G3 C4 F4"), (2.0, "G2 D3 A3 E4"), (3.7, "F2 C3 G3 A#3 D4")],
    "dyads": [(0.3, "A2 E3"), (1.5, "C3 G3"), (2.7, "D3 F#4"), (3.9, "E2 E3")],
    "high_voicings": [(0.3, "A3 C#4 E4 A4"), (2.0, "D4 F#4 A4 D5"), (3.7, "E4 G#4 B4 E5")],
    "single_notes": [(0.3, "A2"), (1.3, "E2"), (2.3, "D4"), (3.3, "G3"), (4.3, "E4")],
}
# Fingerpicked: one new note per pluck while the earlier ones keep ringing.
ARPEGGIO = [(0.3, "A2"), (0.8, "E3"), (1.3, "A3"), (1.8, "C#4")]


def write_set(root: str | Path) -> Path:
    root = Path(root)
    (root / "templates").mkdir(parents=True, exist_ok=True)
    (root / "clips").mkdir(parents=True, exist_ok=True)
    for midi in range(40, 77):  # E2..E5: open strings through fret 12
        sf.write(root / "templates" / f"{note_name(midi)}.wav", render([(0.2, [midi])], 2.2, seed=midi), SR)
    with open(root / "clips" / "labels.csv", "w", newline="") as fh:
        rows = csv.writer(fh)
        rows.writerow(["clip", "start", "end", "notes"])
        for seed, (name, strums) in enumerate(CLIPS.items()):
            total = strums[-1][0] + 1.7
            events = [(t, parse_notes(notes)) for t, notes in strums]
            sf.write(root / "clips" / f"{name}.wav", render(events, total, seed=100 + seed), SR)
            ends = [t for t, _ in strums[1:]] + [total]
            for (t, notes), end in zip(strums, ends):
                rows.writerow([f"{name}.wav", t, round(end, 3), notes])
        events = [(t, parse_notes(n)) for t, n in ARPEGGIO]
        sf.write(root / "clips" / "arpeggio.wav", render(events, 3.5, seed=99, let_ring=True), SR)
        ringing: list[str] = []
        for (t, n), end in zip(ARPEGGIO, [t for t, _ in ARPEGGIO[1:]] + [3.5]):
            ringing.append(n)
            rows.writerow(["arpeggio.wav", t, end, " ".join(ringing)])
    return root


if __name__ == "__main__":
    print(f"wrote {write_set(sys.argv[1] if len(sys.argv) > 1 else 'data/synth')}")
