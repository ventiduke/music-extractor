"""Audio loading, the constant-Q spectrum and onset detection."""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

from .types import Settings

SR = 22050
HOP = 256  # 11.6 ms per frame
BINS_PER_SEMITONE = 3
MIDI_MIN = 36  # C2, the lowest pitch the spectrum covers
N_OCTAVES = 7
N_BINS = N_OCTAVES * 12 * BINS_PER_SEMITONE
# Measured response of the spectrum to a pure tone, 0..4 bins off centre.
LEAK = (1.0, 0.85, 0.5, 0.19, 0.03)


def load(path: str | Path) -> np.ndarray:
    """Read any audio file as mono float32 at SR, peak-normalised.

    WAV/FLAC/OGG go through soundfile; anything else (phone .m4a memos) is
    decoded by ffmpeg.
    """
    path = Path(path)
    try:
        y, sr = sf.read(path, dtype="float32", always_2d=True)
        y = y.mean(axis=1)
        if sr != SR:
            y = librosa.resample(y, orig_sr=sr, target_sr=SR)
    except (sf.LibsndfileError, RuntimeError):
        if not shutil.which("ffmpeg"):
            raise RuntimeError(f"{path.name}: needs ffmpeg to decode this format") from None
        cmd = ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"]
        raw = subprocess.run(cmd, capture_output=True, check=True).stdout
        y = np.frombuffer(raw, dtype=np.float32).copy()
    peak = float(np.abs(y).max()) if y.size else 0.0
    return (y / peak * 0.9).astype(np.float32) if peak > 0 else y


def bin_of(midi: int | np.ndarray) -> int | np.ndarray:
    """Centre spectrum bin of a MIDI pitch."""
    return BINS_PER_SEMITONE * (midi - MIDI_MIN) + 1


def harmonic_offsets(n: int) -> np.ndarray:
    """Bin offsets of harmonics 1..n above a fundamental's bin."""
    return np.round(12 * BINS_PER_SEMITONE * np.log2(np.arange(1, n + 1))).astype(int)


def harmonic_semitones(n: int) -> np.ndarray:
    """Nearest semitone offset of harmonics 1..n (the 3rd is 19, a fifth up)."""
    return np.round(12 * np.log2(np.arange(1, n + 1))).astype(int)


@dataclass
class Spectrum:
    """Constant-Q magnitudes at 3 bins per semitone.

    The analysis filters are deliberately wide (see `of`), so a note a third of
    a semitone out of tune still shows at 85% on its centre bin, and a pure
    tone leaks into its neighbours by the amounts in `LEAK`.
    """

    mag: np.ndarray
    duration: float

    @classmethod
    def of(cls, y: np.ndarray) -> "Spectrum":
        fmin = librosa.midi_to_hz(MIDI_MIN - 1 / BINS_PER_SEMITONE)
        # filter_scale 0.5 halves the analysis window (about 0.35 s at E2
        # instead of 0.7 s): less time smear on low strings, still one
        # semitone of frequency resolution.
        c = np.abs(
            librosa.cqt(
                y, sr=SR, hop_length=HOP, fmin=fmin, n_bins=N_BINS,
                bins_per_octave=12 * BINS_PER_SEMITONE, filter_scale=0.5,
            )
        )
        return cls(mag=c, duration=len(y) / SR)

    def frame(self, t: float) -> int:
        return int(np.clip(round(t * SR / HOP), 0, self.mag.shape[1] - 1))

    def mean(self, start: float, end: float) -> np.ndarray:
        """Average spectrum between two times (at least one frame)."""
        a = self.frame(start)
        b = max(self.frame(end), a + 1)
        return self.mag[:, a:b].mean(axis=1)

    def segment_vector(self, start: float, end: float) -> np.ndarray:
        """The spectrum that represents a segment: its first 0.6 s, skipping the pick noise."""
        a = start + min(0.03, (end - start) / 4)
        return self.mean(a, min(end, start + 0.6))

    def pitch_energy(self, midi: int, start: float, end: float, harmonics: int = 4) -> float:
        """Energy of a pitch's first few harmonics, averaged between two times."""
        idx = bin_of(midi) + harmonic_offsets(harmonics)
        idx = idx[(idx >= 0) & (idx < self.mag.shape[0])]
        if idx.size == 0 or end <= start:
            return 0.0
        return float(self.mean(start, end)[idx].sum())


def detect_onsets(y: np.ndarray, cfg: Settings) -> list[float]:
    """Strum/pluck times in seconds. Onsets closer than `onset_min_gap` merge into one."""
    times = librosa.onset.onset_detect(
        y=y, sr=SR, hop_length=HOP, units="time", backtrack=True, delta=cfg.onset_delta
    )
    merged: list[float] = []
    for t in times:
        if not merged or t - merged[-1] >= cfg.onset_min_gap:
            merged.append(float(t))
    return merged


def segment_bounds(y: np.ndarray, onsets: list[float], silence: float = 0.06) -> list[tuple[float, float]]:
    """Turn onset times into (start, end) spans; each runs to the next onset.

    Spans quieter than `silence` times the loudest one are dropped (room noise
    before the first strum, the tail after the last).
    """
    edges = [*onsets, len(y) / SR]
    spans = [(a, b) for a, b in zip(edges, edges[1:]) if b - a > 0.02]
    # Loudness of each span's opening, where a strum would be (stopping short
    # of the next onset, whose attack may start a few ms early).
    rms = [float(np.sqrt(np.mean(y[int(a * SR) : int(min(b - 0.02, a + 0.3) * SR) + 1] ** 2))) for a, b in spans]
    loudest = max(rms, default=0.0)
    return [span for span, r in zip(spans, rms) if r >= silence * loudest and r > 0]
