"""Audio in, notes and segments out. The two engines plug in here."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

from . import engine_dsp, engine_model
from .audio import Spectrum, detect_onsets, load, segment_bounds
from .layers import Templates, label_layers
from .types import STANDARD_TUNING, NoteEvent, PitchEntry, Segment, Settings, note_name, parse_notes

ENGINES = ("model", "dsp")


@dataclass
class Result:
    source: str
    engine: str
    duration: float
    tuning: list[int]
    used_templates: bool
    settings: Settings
    segments: list[Segment]
    notes: list[NoteEvent]  # played notes only: what goes into the MIDI file

    def to_json(self) -> dict:
        return {
            "source": self.source,
            "engine": self.engine,
            "duration": round(self.duration, 3),
            "tuning": [note_name(m) for m in self.tuning],
            "overtone_layers": self.used_templates,
            "settings": asdict(self.settings),
            "segments": [
                {
                    "start": round(s.start, 3),
                    "end": round(s.end, 3),
                    "lowest_note": (
                        {"pitch": s.lowest_note.pitch, "name": s.lowest_note.name} if s.lowest_note else None
                    ),
                    "pitches": [
                        {
                            "pitch": p.pitch,
                            "name": p.name,
                            "layer": p.layer,
                            "source": p.source,
                            "source_pitch": p.source_pitch,
                            "source_harmonic": p.source_harmonic,
                            "energy": round(float(p.energy), 3),
                            "confidence": round(p.confidence, 3),
                        }
                        for p in s.pitches
                    ],
                }
                for s in self.segments
            ],
            "notes": [
                {
                    "pitch": n.pitch,
                    "name": note_name(n.pitch),
                    "start": round(n.start, 3),
                    "end": round(n.end, 3),
                    "velocity": round(n.velocity, 3),
                    "confidence": round(n.confidence, 3),
                }
                for n in self.notes
            ],
        }


def build_segments(
    notes: list[NoteEvent], bounds: list[tuple[float, float]], spec: Spectrum, cfg: Settings
) -> list[Segment]:
    """Collect the notes sounding in each onset-to-onset span, dropping very quiet ones."""
    segments = []
    for start, end in bounds:
        length = end - start
        entries: dict[int, PitchEntry] = {}
        raw: dict[int, float] = {}
        for n in notes:
            overlap = min(n.end, end) - max(n.start, start)
            if overlap < min(cfg.min_note_dur, 0.5 * length):
                continue
            raw[n.pitch] = spec.pitch_energy(n.pitch, start, min(end, start + 0.6))
            prior = entries.get(n.pitch)
            if prior is None or n.confidence > prior.confidence:
                entries[n.pitch] = PitchEntry(n.pitch, note_name(n.pitch), confidence=n.confidence)
        loudest = max(raw.values(), default=0.0) or 1e-12
        seg = Segment(start, end)
        for pitch, entry in sorted(entries.items()):
            entry.energy = raw[pitch] / loudest
            if entry.energy >= cfg.min_rel_energy:
                seg.pitches.append(entry)
        segments.append(seg)
    return segments


def _midi_notes(notes: list[NoteEvent], segments: list[Segment]) -> list[NoteEvent]:
    """Keep the notes whose pitch counts as played in the segment where they begin."""
    kept = []
    for n in notes:
        home = max(segments, key=lambda s: min(n.end, s.end) - max(n.start, s.start), default=None)
        if home is not None and n.pitch in home.played():
            kept.append(n)
    return kept


def analyse(
    path: str | Path,
    engine: str = "model",
    templates: Templates | None = None,
    tuning: str = STANDARD_TUNING,
    cfg: Settings | None = None,
) -> Result:
    cfg = cfg or Settings()
    if engine not in ENGINES:
        raise ValueError(f"engine must be one of {ENGINES}")
    y = load(path)
    return analyse_audio(y, Path(path).name, engine, templates, tuning, cfg)


def analyse_audio(
    y: np.ndarray, source: str, engine: str, templates: Templates | None, tuning: str, cfg: Settings
) -> Result:
    spec = Spectrum.of(y)
    onsets = detect_onsets(y, cfg)
    bounds = segment_bounds(y, onsets)
    notes = engine_model.detect(y, cfg) if engine == "model" else engine_dsp.detect(spec, bounds, cfg)
    notes = [
        n for n in notes
        if n.end - n.start >= cfg.min_note_dur and cfg.midi_lo <= n.pitch <= cfg.midi_hi
    ]
    segments = build_segments(notes, bounds, spec, cfg)
    open_strings = parse_notes(tuning)
    if templates is not None:
        label_layers(segments, notes, spec, templates, open_strings, cfg)
    segments = [s for s in segments if s.pitches]
    return Result(
        source=source,
        engine=engine,
        duration=spec.duration,
        tuning=open_strings,
        used_templates=templates is not None,
        settings=cfg,
        segments=segments,
        notes=_midi_notes(notes, segments),
    )
