"""Phase 2 engine: constant-Q spectrum + harmonic summation. No model, fully explainable.

Per segment (the span between two strum onsets):

1. Score every candidate pitch by summing the spectrum at its harmonics.
2. Take the best one, subtract its harmonics from the spectrum, repeat. This
   stops a note's overtones from being picked as notes of their own.
3. Stop when the best remaining score is small, or after six notes.

Then notes are stitched across segments: a pitch found in two consecutive
segments is one held note unless its energy jumps at the boundary (a re-strike).
"""

from __future__ import annotations

import numpy as np

from .audio import HOP, LEAK, SR, Spectrum, bin_of, harmonic_offsets
from .types import NoteEvent, Settings

_SKIRT = np.array([*LEAK[:0:-1], *LEAK])  # a peak's shape, 4 bins either side


def _harmonic_index(cfg: Settings, n_bins: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    pitches = np.arange(cfg.midi_lo, cfg.midi_hi + 1)
    idx = bin_of(pitches)[:, None] + harmonic_offsets(cfg.dsp_harmonics)[None, :]
    valid = idx < n_bins
    return pitches, np.where(valid, idx, 0), valid


def pick_notes(v: np.ndarray, cfg: Settings, floor: float = 0.0) -> list[tuple[int, float, float]]:
    """Find the pitches in one spectrum. Returns (pitch, energy, confidence) per note."""
    pitches, idx, valid = _harmonic_index(cfg, len(v))
    weights = 0.84 ** np.arange(cfg.dsp_harmonics)
    original = np.where(valid, v[idx], 0.0)
    residual = v.copy()
    picks: list[tuple[int, float, float]] = []
    first = None
    # A real note has most of its first four harmonics. A phantom an octave or
    # a twelfth below a real note has only every 2nd or 3rd one. Judged on the
    # untouched spectrum: harmonics shared with an earlier pick still count.
    present = original[:, :4] > 0.1 * original[:, :6].max(axis=1, keepdims=True)
    completeness = (present.sum(axis=1) / 4) ** 2
    for _ in range(cfg.dsp_max_notes):
        amps = np.where(valid, residual[idx], 0.0)
        salience = (amps * weights).sum(axis=1) * completeness
        i = int(salience.argmax())
        if first is None:
            first = salience[i]
        if salience[i] <= 0 or salience[i] < cfg.dsp_rel_threshold * first or salience[i] < floor:
            break
        a = amps[i]
        # Subtract only up to the typical level of the neighbouring harmonics,
        # so a harmonic that sticks out (another note sounding there) survives.
        window = np.lib.stride_tricks.sliding_window_view(np.pad(a, 2, mode="edge"), 5)
        local = np.median(window, axis=1)
        take = np.minimum(a, cfg.dsp_cancel * local)
        for b, amount in zip(idx[i][valid[i]], take[valid[i]]):
            lo, hi = max(b - 4, 0), min(b + 5, len(residual))
            residual[lo:hi] = np.maximum(residual[lo:hi] - amount * _SKIRT[lo - b + 4 : hi - b + 4], 0.0)
        unexplained = a.sum() / max(original[i].sum(), 1e-12)
        confidence = float(np.clip(unexplained * np.sqrt(completeness[i]), 0.0, 1.0))
        picks.append((int(pitches[i]), float(take.sum()), confidence))
    return picks


def _release_time(spec: Spectrum, pitch: int, start: float, end: float, cfg: Settings) -> float:
    """When a note has decayed below `dsp_release` of its peak (held 60 ms), capped at `end`."""
    idx = bin_of(pitch) + harmonic_offsets(4)
    idx = idx[idx < spec.mag.shape[0]]
    a, b = spec.frame(start), max(spec.frame(end), spec.frame(start) + 1)
    env = spec.mag[idx, a:b].sum(axis=0)
    quiet = env < cfg.dsp_release * env.max()
    hold = 5
    run = 0
    for t, q in enumerate(quiet):
        run = run + 1 if q else 0
        if run >= hold and t > int(env.argmax()):
            return start + (t - hold + 1) * HOP / SR
    return end


def detect(spec: Spectrum, bounds: list[tuple[float, float]], cfg: Settings) -> list[NoteEvent]:
    vectors = [spec.segment_vector(a, b) for a, b in bounds]
    if not vectors:
        return []
    all_picks = [pick_notes(v, cfg) for v in vectors]
    # Silence floor: the strongest note in the clip sets the scale.
    loudest = max((e for picks in all_picks for _, e, _ in picks), default=0.0) or 1e-12

    open_notes: dict[int, NoteEvent] = {}
    done: list[NoteEvent] = []
    for (start, end), picks in zip(bounds, all_picks):
        if max((e for _, e, _ in picks), default=0.0) < cfg.dsp_silence_floor * loudest:
            picks = []
        found = {p: (e, c) for p, e, c in picks}
        for pitch in list(open_notes):
            note = open_notes[pitch]
            if pitch in found:
                before = spec.pitch_energy(pitch, start - 0.15, start - 0.03)
                after = spec.pitch_energy(pitch, start + 0.02, start + 0.14)
                if after <= cfg.dsp_restrike_ratio * before:
                    note.end = end  # still ringing: the same note carries on
                    del found[pitch]
                    continue
            done.append(open_notes.pop(pitch))  # gone, or struck again
        for pitch, (energy, conf) in found.items():
            velocity = float(np.clip(np.sqrt(energy / loudest), 0.0, 1.0))
            open_notes[pitch] = NoteEvent(pitch, start, end, velocity, conf)
    done.extend(open_notes.values())
    for note in done:
        note.end = _release_time(spec, note.pitch, note.start, note.end, cfg)
    return sorted(done, key=lambda n: (n.start, n.pitch))
