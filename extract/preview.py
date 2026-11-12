"""Make the extracted notes audible: a plain plucked-string render to compare with the memo.

A .mid file holds notes, not sound, and many phones cannot play one. The
preview is an ordinary audio file: the original memo in the left ear, the
extracted notes in the right (or `mode="notes"` for the notes alone).
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

from .audio import SR
from .types import NoteEvent


def synthesize(notes: list[NoteEvent], duration: float) -> np.ndarray:
    """Render notes as simple decaying plucks."""
    out = np.zeros(int((duration + 1.0) * SR), dtype=np.float32)
    release = int(0.05 * SR)
    for n in notes:
        f0 = 440.0 * 2 ** ((n.pitch - 69) / 12)
        length = int((n.end - n.start) * SR) + release
        t = np.arange(length) / SR
        tone = np.zeros(length)
        for k in range(1, 9):
            if k * f0 < SR / 2:
                tone += np.exp(-t * (1.5 + 0.5 * k)) * np.sin(2 * np.pi * k * f0 * t) / k
        tone[:64] *= np.linspace(0, 1, 64)
        tone[-release:] *= np.linspace(1, 0, release)
        a = int(n.start * SR)
        tone = tone[: len(out) - a]
        out[a : a + len(tone)] += (0.3 + 0.7 * n.velocity) * tone
    peak = float(np.abs(out).max())
    return out / peak * 0.9 if peak > 0 else out


def write_preview(original: np.ndarray, notes: list[NoteEvent], path: Path, mode: str = "split") -> Path:
    """Write the preview. `split`: memo left / notes right. `notes`: notes only. `mix`: both, centred."""
    rendered = synthesize(notes, len(original) / SR)[: len(original)]
    rendered = np.pad(rendered, (0, len(original) - len(rendered)))
    if mode == "notes":
        audio = rendered
    elif mode == "mix":
        audio = 0.5 * (original + rendered)
    else:
        audio = np.stack([original, rendered], axis=1)
    path = Path(path)
    if path.suffix.lower() in (".wav", ".flac"):
        sf.write(path, audio, SR)
    else:  # compressed, so it plays anywhere and stays small
        channels = 1 if audio.ndim == 1 else 2
        cmd = [
            "ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", str(channels),
            "-i", "-", "-b:a", "128k", str(path),
        ]
        subprocess.run(cmd, input=audio.astype(np.float32).tobytes(), check=True)
    return path
