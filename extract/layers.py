"""Phase 3: overtone templates and the played / overtone / ambiguous / sympathetic layers.

A template is the relative strength of one note's harmonics on *your* guitar
through *your* phone, measured from the note-by-note recordings in
data/templates/. Per segment we fit the spectrum as a non-negative mix of the
candidate notes' templates. Each pitch's energy then splits into the part its
own note explains and the part other notes' overtones explain, and that share
decides the layer.

(The plan describes this as strongest-first subtraction. The joint fit is the
same idea but does not depend on the order notes are taken in.)
"""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.optimize import nnls

from .audio import Spectrum, bin_of, detect_onsets, harmonic_offsets, harmonic_semitones, load
from .types import NoteEvent, PitchEntry, Segment, Settings, note_name, ordinal, parse_note

N_HARMONICS = 12
AUDIO_EXTS = {".wav", ".flac", ".m4a", ".mp3", ".aiff", ".aif", ".ogg", ".caf"}


@dataclass
class Templates:
    """Harmonic strengths per MIDI pitch; each row sums to 1."""

    harmonics: dict[int, np.ndarray]

    def get(self, midi: int) -> np.ndarray:
        """Template for a pitch, borrowing the nearest recorded one if needed."""
        if midi in self.harmonics:
            return self.harmonics[midi]
        return self.harmonics[min(self.harmonics, key=lambda m: abs(m - midi))]

    def vector(self, midi: int, n_bins: int) -> np.ndarray:
        out = np.zeros(n_bins)
        idx = bin_of(midi) + harmonic_offsets(N_HARMONICS)
        ok = idx < n_bins
        out[idx[ok]] = self.get(midi)[ok]
        return out

    def save(self, path: Path) -> None:
        data = {note_name(m): [round(float(x), 5) for x in h] for m, h in sorted(self.harmonics.items())}
        path.write_text(json.dumps({"harmonics": data}, indent=1))

    @classmethod
    def read(cls, path: Path) -> "Templates":
        data = json.loads(Path(path).read_text())["harmonics"]
        return cls({parse_note(k): np.array(v) for k, v in data.items()})


def measure_note(y: np.ndarray, midi: int, cfg: Settings) -> np.ndarray:
    """Harmonic strengths of one recorded note."""
    spec = Spectrum.of(y)
    onsets = detect_onsets(y, cfg)
    start = onsets[0] if onsets else 0.0
    v = spec.mean(start + 0.05, min(spec.duration, start + 1.5))
    idx = bin_of(midi) + harmonic_offsets(N_HARMONICS)
    ok = idx < len(v)
    h = np.zeros(N_HARMONICS)
    h[ok] = v[idx[ok]]
    # Bins with nothing but noise in them are not harmonics.
    h[h < 0.02 * h.max()] = 0.0
    return h / max(h.sum(), 1e-12)


def build_templates(folder: str | Path, cfg: Settings | None = None) -> Templates:
    """Build templates from files named by sounding pitch: E2.wav, C3_A-string.wav, ...

    Everything after the first underscore is ignored, so the same pitch played
    on different strings can be recorded more than once; takes are averaged.
    """
    cfg = cfg or Settings()
    takes: dict[int, list[np.ndarray]] = defaultdict(list)
    for f in sorted(Path(folder).iterdir()):
        if f.suffix.lower() not in AUDIO_EXTS:
            continue
        try:
            midi = parse_note(f.stem.split("_")[0])
        except ValueError:
            print(f"skipped {f.name}: file name does not start with a note like E2 or C#3")
            continue
        takes[midi].append(measure_note(load(f), midi, cfg))
    if not takes:
        raise SystemExit(f"no note recordings found in {folder}")
    return Templates({m: np.mean(hs, axis=0) for m, hs in takes.items()})


def label_layers(
    segments: list[Segment],
    notes: list[NoteEvent],
    spec: Spectrum,
    templates: Templates,
    tuning: list[int],
    cfg: Settings,
) -> None:
    """Relabel each segment's pitches in place and add overtone-only pitches."""
    # (pitch, segment start) pairs where a note begins at that segment's strum.
    attacks = {
        (n.pitch, round(seg.start, 3))
        for seg in segments
        for n in notes
        if seg.start - 0.1 <= n.start < min(seg.end, seg.start + 0.15)
    }
    semis = harmonic_semitones(N_HARMONICS)
    previous: set[int] = set()
    for seg in segments:
        cands = [p.pitch for p in seg.pitches]
        if not cands:
            previous = set()
            continue
        v = spec.segment_vector(seg.start, seg.end)
        basis = np.stack([templates.vector(m, len(v)) for m in cands], axis=1)
        gains, _ = nnls(basis, v)

        own: dict[int, float] = defaultdict(float)
        # other[q] -> list of (energy, source pitch, harmonic number)
        other: dict[int, list[tuple[float, int, int]]] = defaultdict(list)
        for m, g in zip(cands, gains):
            h = templates.get(m)
            own[m] += g * h[0]
            for k in range(2, N_HARMONICS + 1):
                if g * h[k - 1] > 0:
                    other[m + int(semis[k - 1])].append((g * h[k - 1], m, k))

        energy = {q: own.get(q, 0.0) + sum(e for e, _, _ in other.get(q, [])) for q in {*own, *other}}
        loudest = max(energy.values(), default=0.0) or 1e-12
        by_pitch = {p.pitch: p for p in seg.pitches}

        for q, total in energy.items():
            from_others = sorted(other.get(q, []), reverse=True)
            entry = by_pitch.get(q)
            if entry is None:
                # Not a candidate note: pure overtone, reported if loud enough.
                if total / loudest < cfg.overtone_floor:
                    continue
                entry = PitchEntry(q, note_name(q), confidence=1.0)
                seg.pitches.append(entry)
                share = 0.0
            elif total <= 0:
                continue  # the templates explain nothing here; keep the engine's label
            else:
                share = own[q] / total
            entry.energy = round(total / loudest, 3)
            if share >= cfg.played_share:
                entry.layer = "played"
            else:
                entry.layer = "overtone" if share <= cfg.overtone_share else "ambiguous"
                _, src, k = from_others[0]
                entry.source = f"{ordinal(k)} of {note_name(src)}"
                entry.source_pitch, entry.source_harmonic = src, k

        # Sympathetic: an open string that hums along. It is quiet, was not
        # sounding before, and the engine heard no attack for it at this strum.
        gain = dict(zip(cands, gains))
        strongest = max(gain.values(), default=0.0) or 1e-12
        for entry in seg.pitches:
            if entry.layer != "played" or entry.pitch not in tuning or entry.pitch in previous:
                continue
            if (entry.pitch, round(seg.start, 3)) in attacks:
                continue
            if gain.get(entry.pitch, strongest) / strongest < cfg.sympathetic_max_energy:
                entry.layer = "sympathetic"
        seg.pitches.sort(key=lambda p: p.pitch)
        previous = seg.played()
