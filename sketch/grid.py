"""Find the beat in a memo and place notes on it.

A memo is played without a click, so the tempo drifts. The grid is therefore a
list of beat *times* in the recording, not one fixed tempo: beat 0 is the start
of bar 1, and `beat_times[i]` is when beat i happens in the memo. Positions in
beats convert to memo time and back through that list, which is what lets
generated parts follow the original guitar.
"""

from __future__ import annotations

from dataclasses import dataclass

import librosa
import numpy as np

from extract.audio import HOP, SR
from extract.types import NoteEvent

from .tempo import refine


@dataclass
class Grid:
    beat_times: list[float]  # time of beat 0, 1, 2, ... in the memo (s)
    meter: int  # beats per bar
    tempo_bpm: float  # typical tempo
    downbeat_confidence: float  # 0-1: how clearly beat 1 of the bar stood out
    meter_confidence: float = 0.0  # 0-1: how clearly this bar length stood out (0 when it was given)

    def to_beats(self, t: float | np.ndarray) -> float | np.ndarray:
        bt = np.asarray(self.beat_times)
        return np.interp(t, bt, np.arange(len(bt)))

    def to_time(self, beat: float | np.ndarray) -> float | np.ndarray:
        bt = np.asarray(self.beat_times)
        return np.interp(beat, np.arange(len(bt)), bt)

    def bar_and_beat(self, beat: float) -> tuple[int, float]:
        """1-based bar number and beat within the bar, the way a musician counts."""
        return int(beat // self.meter) + 1, round(beat % self.meter + 1, 3)

    @property
    def n_bars(self) -> int:
        return int(np.ceil((len(self.beat_times) - 1) / self.meter))


def _accents(times: np.ndarray, notes: list[NoteEvent]) -> np.ndarray:
    """How much each beat feels like beat 1: a new bass note arrives there, and it is played hard.

    Chords mostly change on the bar line, so a change of the lowest note is the
    main clue; loudness (low notes counted double) breaks ties.
    """
    gap = float(np.median(np.diff(times)))
    loud = np.zeros(len(times))
    lowest: dict[int, int] = {}
    for n in notes:
        i = int(np.argmin(np.abs(times - n.start)))
        if abs(times[i] - n.start) <= 0.25 * gap:
            loud[i] += n.velocity * (2.0 if n.pitch < 52 else 1.0)
            lowest[i] = min(lowest.get(i, 128), n.pitch)
    change = np.zeros(len(times))
    previous = None
    for i in sorted(lowest):
        if previous is not None and lowest[i] % 12 != previous % 12:
            change[i] = 1.0
        previous = lowest[i]
    return change + 0.5 * loud / max(loud.max(), 1e-9)


def _bar_evidence(accents: np.ndarray, meter: int) -> tuple[int, float, float]:
    """Best bar phase for a meter, how many standard errors it stands out by, and its lead over the runner-up."""
    z = (accents - accents.mean()) / (accents.std() + 1e-9)
    scores = np.array([z[k::meter].mean() * np.sqrt(len(z[k::meter])) for k in range(meter)])
    ranked = np.sort(scores)[::-1]
    return int(scores.argmax()), float(ranked[0]), float(ranked[0] - ranked[1])


def find_grid(
    y: np.ndarray, notes: list[NoteEvent], meter: int | None = None, downbeat_shift: int | None = None
) -> Grid:
    """Track beats in the audio, guess the bar length and which beat is beat 1, and start bar 1 at the first note.

    `meter` fixes the beats per bar. Left as None, 3 or 6 is chosen only when
    the evidence for it is strong (3 standard errors and clearly ahead of 4);
    otherwise 4. `downbeat_shift` moves the bar lines later by that many beats.
    """
    envelope = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP)
    _, beats = librosa.beat.beat_track(onset_envelope=envelope, sr=SR, hop_length=HOP, units="time")
    beats = np.asarray(beats, dtype=float)
    if len(beats) < 4:
        raise ValueError("could not find a steady beat in this recording")
    gap = float(np.median(np.diff(beats)))
    # Extend the tracked beats at the typical spacing to cover the whole memo.
    before = beats[0] - gap * np.arange(int(beats[0] // gap) + 8, 0, -1)
    after = beats[-1] + gap * np.arange(1, int((len(y) / SR - beats[-1]) // gap) + 8 + 1)
    times = np.concatenate([before, beats, after])
    times = _align(times, notes, 2, gap)

    accents = _accents(times, notes)
    meter_confidence = 0.0
    if meter is None:
        evidence = {m: _bar_evidence(accents, m) for m in (4, 3, 6)}
        meter = 4
        for m in (3, 6):
            if evidence[m][1] >= 3.0 and evidence[m][1] >= evidence[meter][1] + 1.0:
                meter = m
        meter_confidence = round(float(np.clip(evidence[meter][1] / 4.0, 0.0, 1.0)), 2)
    phase, _, lead = _bar_evidence(accents, meter)
    confidence = float(np.clip(lead / 3.0, 0.0, 1.0))
    if downbeat_shift is not None:
        phase = (phase + downbeat_shift) % meter

    return _bars(times, phase, meter, notes, len(y) / SR, gap, confidence, meter_confidence)


def _align(times: np.ndarray, notes: list[NoteEvent], division: int, gap: float) -> np.ndarray:
    """Slide the whole grid so the typical note start lands exactly on a subdivision."""
    played = np.interp([n.start for n in notes], times, np.arange(len(times)))
    offset = float(np.median(played - np.round(played * division) / division)) if len(played) else 0.0
    return times + offset * gap


def _bars(
    times: np.ndarray, phase: int, meter: int, notes: list[NoteEvent], duration: float, gap: float,
    downbeat_confidence: float, meter_confidence: float,
) -> Grid:
    """Start bar 1 on the last bar line at or before the first note, and end on a bar line after the last."""
    first_note = min((n.start for n in notes), default=0.0)
    downbeats = [i for i in range(phase % meter, len(times), meter) if times[i] <= first_note + 0.25 * gap]
    origin = downbeats[-1] if downbeats else phase % meter
    last_note = max((n.end for n in notes), default=duration)
    end = int(np.searchsorted(times, last_note)) + 1
    end = origin + int(np.ceil((end - origin) / meter)) * meter
    while end >= len(times):
        times = np.append(times, times[-1] + gap)
    return Grid(
        beat_times=[round(float(t), 4) for t in times[origin : end + 1]],
        meter=meter,
        tempo_bpm=round(60.0 / gap, 1),
        downbeat_confidence=round(downbeat_confidence, 2),
        meter_confidence=meter_confidence,
    )


def grid_from_taps(
    taps: list[float], notes: list[NoteEvent], duration: float, meter: int = 4, division: int = 2,
    downbeat_shift: int = 0,
) -> Grid:
    """Build the grid from beats a person tapped while listening.

    The taps are the authority on where the beat is and how fast it moves.
    They are only tidied: double-taps removed, missed beats and breaks filled
    in at the local spacing, hand jitter smoothed a little, and the whole grid
    slid so note starts sit on its subdivisions, then each beat is
    sharpened by the strums around it (see tempo.refine). `downbeat_shift` says which
    tap is beat 1 (0 = the first tap). `division` is how the tapped beat
    divides: 2 for straight, 3 for a triplet / compound feel.
    """
    if len(taps) < 4:
        raise ValueError("need at least 4 taps to make a beat grid")
    times = tapped_times(taps)
    smooth = times.copy()
    smooth[1:-1] = 0.25 * times[:-2] + 0.5 * times[1:-1] + 0.25 * times[2:]
    head, tail_gap = float(np.median(np.diff(smooth[:5]))), float(np.median(np.diff(smooth[-5:])))
    n_before = int(smooth[0] // head) + 8
    before = smooth[0] - head * np.arange(n_before, 0, -1)
    after = smooth[-1] + tail_gap * np.arange(1, int(max(duration - smooth[-1], 0) // tail_gap) + 9)
    gap = float(np.median(np.diff(smooth)))
    times = _align(np.concatenate([before, smooth, after]), notes, division, gap)
    times = refine(times, strum_onsets(notes), division)
    phase = n_before + downbeat_shift
    return _bars(times, phase, meter, notes, duration, gap, 1.0, 1.0)


def strum_onsets(notes: list[NoteEvent], window: float = 0.06) -> np.ndarray:
    """Start time of each strum (notes beginning within `window` of each other are one strum)."""
    onsets: list[float] = []
    last = None
    for t in sorted(n.start for n in notes):
        if last is None or t - last > window:
            onsets.append(t)
        last = t
    return np.asarray(onsets)


def tapped_times(taps: list[float]) -> np.ndarray:
    """Taps with double taps dropped and missed beats filled in, before any alignment to the notes."""
    taps = sorted(float(t) for t in taps)
    kept = [taps[0]]
    for t in taps[1:]:
        if t - kept[-1] >= 0.12:
            kept.append(t)
    filled = kept[:2]
    for t in kept[2:]:
        local = float(np.median(np.diff(filled[-5:])))
        missing = int(round((t - filled[-1]) / local)) - 1
        for k in range(1, missing + 1):
            filled.append(filled[-1] + (t - filled[-1]) / (missing - k + 2))
        filled.append(t)
    return np.asarray(filled)
