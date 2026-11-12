"""Phase 1 engine: Spotify's Basic Pitch note model, run through ONNX."""

from __future__ import annotations

import contextlib
import io
import logging
import tempfile
import warnings
from functools import lru_cache
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

from .audio import SR
from .types import NoteEvent, Settings


@lru_cache(maxsize=1)
def _model():
    # basic_pitch logs a warning for every backend that is not installed.
    logging.disable(logging.WARNING)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            from basic_pitch import FilenameSuffix, build_icassp_2022_model_path
            from basic_pitch.inference import Model

            return Model(build_icassp_2022_model_path(FilenameSuffix.onnx))
    finally:
        logging.disable(logging.NOTSET)


def detect(y: np.ndarray, cfg: Settings) -> list[NoteEvent]:
    from basic_pitch.inference import predict

    model = _model()
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "clip.wav"
        sf.write(wav, y, SR)
        with contextlib.redirect_stdout(io.StringIO()), warnings.catch_warnings():
            warnings.simplefilter("ignore")
            _, _, events = predict(
                wav,
                model,
                onset_threshold=cfg.bp_onset_threshold,
                frame_threshold=cfg.bp_frame_threshold,
                minimum_note_length=cfg.min_note_dur * 1000,
                minimum_frequency=float(librosa.midi_to_hz(cfg.midi_lo - 0.5)),
                maximum_frequency=float(librosa.midi_to_hz(cfg.midi_hi + 0.5)),
            )
    return [
        NoteEvent(int(p), float(s), float(e), float(a), float(a))
        for s, e, p, a, _ in sorted(events, key=lambda ev: (ev[0], ev[2]))
    ]
