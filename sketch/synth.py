"""Plain synthesised sounds for previews: guitar pluck, bass, pad and a drum kit.

These exist so a preview can be heard anywhere without a sound library. They
are for judging notes and timing, not tone.
"""

from __future__ import annotations

import numpy as np

from extract.audio import SR
from extract.types import NoteEvent

from .parts import HAT, KICK, SNARE


def _tone(f0: float, seconds: float, harmonics: list[float], decay: float, attack: float, release: float) -> np.ndarray:
    t = np.arange(max(int(seconds * SR), 1) + int(release * SR), dtype=np.float32) / SR
    k = np.arange(1, len(harmonics) + 1, dtype=np.float32)[:, None]
    amps = np.where(k[:, 0] * f0 < SR / 2, np.asarray(harmonics, dtype=np.float32), 0.0)[:, None]
    y = (amps * np.exp(-t * decay * (1 + 0.3 * (k - 1))) * np.sin(2 * np.pi * k * f0 * t)).sum(axis=0)
    a, r = max(int(attack * SR), 1), max(int(release * SR), 1)
    y[:a] *= np.linspace(0, 1, a)
    y[-r:] *= np.linspace(1, 0, r)
    return y


def _drum(pitch: int, rng: np.random.Generator) -> np.ndarray:
    if pitch == KICK:
        t = np.arange(int(0.3 * SR)) / SR
        freq = 45 + 90 * np.exp(-t * 30)
        return np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-t * 14)
    if pitch == SNARE:
        t = np.arange(int(0.2 * SR)) / SR
        return 0.7 * rng.normal(0, 0.5, len(t)) * np.exp(-t * 28) + 0.5 * np.sin(2 * np.pi * 185 * t) * np.exp(-t * 35)
    t = np.arange(int(0.06 * SR)) / SR  # anything else: a closed hi-hat
    return 0.5 * np.diff(rng.normal(0, 0.5, len(t) + 1)) * np.exp(-t * 90)


VOICES = {
    # harmonics, decay per second, attack, release
    "guitar": ([1, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 7, 1 / 8], 1.5, 0.003, 0.05),
    "bass": ([1, 0.5, 0.25, 0.1], 0.8, 0.008, 0.06),
    "pad": ([1, 0.4, 0.2, 0.1], 0.05, 0.12, 0.25),
}
GAINS = {"guitar": 1.0, "bass": 0.9, "pad": 0.35, "drums": 0.8}


def render_part(kind: str, notes: list[NoteEvent], seconds: float) -> np.ndarray:
    """One part as audio, not normalised (so parts keep their balance when mixed)."""
    out = np.zeros(int((seconds + 1.0) * SR), dtype=np.float32)
    rng = np.random.default_rng(0)
    for n in notes:
        if kind == "drums":
            sound = _drum(n.pitch, rng)
        else:
            harmonics, decay, attack, release = VOICES[kind]
            sound = _tone(440.0 * 2 ** ((n.pitch - 69) / 12), n.end - n.start, harmonics, decay, attack, release)
        a = int(n.start * SR)
        if a >= len(out):
            continue
        sound = sound[: len(out) - a]
        out[a : a + len(sound)] += (0.3 + 0.7 * n.velocity) * sound
    return out


def mix(parts: dict[str, np.ndarray], under: np.ndarray | None = None) -> np.ndarray:
    """Mix rendered parts (and optionally a recording underneath) to one mono track."""
    total = np.zeros(max(len(p) for p in parts.values()), dtype=np.float32)
    for kind, part in parts.items():
        peak = float(np.abs(part).max())
        if peak > 0:
            total += GAINS[kind] * part / peak
    if under is not None:
        n = min(len(under), len(total))
        total[:n] += 1.2 * under[:n] / max(float(np.abs(under).max()), 1e-9)
    peak = float(np.abs(total).max())
    return (0.9 * total / peak).astype(np.float32) if peak > 0 else total
