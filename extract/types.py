"""Shared data types, settings and pitch-name helpers."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_FLATS = {"DB": 1, "EB": 3, "GB": 6, "AB": 8, "BB": 10}
STANDARD_TUNING = "E2 A2 D3 G3 B3 E4"

LAYERS = ("played", "overtone", "ambiguous", "sympathetic")


def note_name(midi: int) -> str:
    return f"{NOTE_NAMES[midi % 12]}{midi // 12 - 1}"


def parse_note(name: str) -> int:
    """'E2', 'g#3', 'Bb4' -> MIDI number."""
    s = name.strip().upper()
    for i in (2, 1):
        head, octave = s[:i], s[i:]
        if head in _FLATS:
            pc = _FLATS[head]
        elif head in NOTE_NAMES:
            pc = NOTE_NAMES.index(head)
        else:
            continue
        try:
            return pc + 12 * (int(octave) + 1)
        except ValueError:
            continue
    raise ValueError(f"not a note name: {name!r}")


def parse_notes(text: str) -> list[int]:
    return sorted({parse_note(tok) for tok in text.replace(",", " ").split()})


def ordinal(k: int) -> str:
    if 10 <= k % 100 <= 20:
        return f"{k}th"
    return f"{k}{ {1: 'st', 2: 'nd', 3: 'rd'}.get(k % 10, 'th') }"


@dataclass
class NoteEvent:
    """One sounding note, as an engine reports it."""

    pitch: int
    start: float
    end: float
    velocity: float  # 0-1 loudness
    confidence: float  # 0-1


@dataclass
class PitchEntry:
    """One detected pitch inside a segment of the JSON sidecar."""

    pitch: int
    name: str
    layer: str = "played"
    source: str | None = None  # for overtones, e.g. "3rd of A2"
    source_pitch: int | None = None
    source_harmonic: int | None = None
    energy: float = 0.0  # loudness relative to the loudest pitch in the segment
    confidence: float = 0.0


@dataclass
class Segment:
    start: float
    end: float
    pitches: list[PitchEntry] = field(default_factory=list)

    @property
    def lowest_note(self) -> PitchEntry | None:
        sounding = [p for p in self.pitches if p.layer in ("played", "ambiguous")]
        pool = sounding or self.pitches
        return min(pool, key=lambda p: p.pitch) if pool else None

    def played(self) -> set[int]:
        return {p.pitch for p in self.pitches if p.layer in ("played", "ambiguous")}


@dataclass
class Settings:
    """Every tunable threshold, in one place so eval runs can record them."""

    # pitch range considered (D2 .. E6 covers drop-D up to the 24th fret)
    midi_lo: int = 38
    midi_hi: int = 88
    # onset segmentation
    onset_delta: float = 0.07  # librosa peak-pick sensitivity; lower = more onsets
    onset_min_gap: float = 0.10  # onsets closer than this are one strum (s)
    # note cleanup shared by both engines
    min_note_dur: float = 0.08  # drop notes shorter than this (s)
    min_rel_energy: float = 0.10  # drop pitches quieter than this share of the segment's loudest
    # model engine (Basic Pitch)
    bp_onset_threshold: float = 0.5
    bp_frame_threshold: float = 0.3
    # signal-processing engine
    dsp_harmonics: int = 10
    dsp_rel_threshold: float = 0.10  # keep picks above this share of the segment's strongest
    dsp_silence_floor: float = 0.05  # ... and above this share of the clip's strongest
    dsp_max_notes: int = 6  # six strings
    dsp_cancel: float = 1.0  # remove a note's harmonics up to this multiple of their local median
    dsp_restrike_ratio: float = 1.25  # energy jump that counts as a new attack
    dsp_release: float = 0.15  # note ends when it falls below this share of its peak
    # overtone layers
    played_share: float = 0.60  # own share of a pitch's energy at or above this = played
    overtone_share: float = 0.25  # own share at or below this = overtone
    overtone_floor: float = 0.05  # report overtone-only pitches above this relative energy
    sympathetic_max_energy: float = 0.30

    def describe(self, engine: str) -> str:
        d = asdict(self)
        keep = {
            "model": ("bp_",),
            "dsp": ("dsp_",),
        }[engine]
        shared = ("onset_", "min_", "played_", "overtone_")
        return " ".join(f"{k}={v}" for k, v in d.items() if k.startswith(keep + shared))
