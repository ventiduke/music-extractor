"""Render the editor's sound library from the FluidR3_GM soundfont (MIT licence).

Each instrument becomes one MP3 "sprite" (its sampled notes back to back) plus an
entry in web/editor/sounds/library.json saying where each note sits. The editor
plays the nearest sample, re-pitched, so sampling every few semitones is enough.

Needs fluidsynth, ffmpeg and the soundfont:
    apt-get install fluidsynth fluid-soundfont-gm
    uv run python tools/render_sounds.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import mido
import numpy as np
import soundfile as sf

SF2 = "/usr/share/sounds/sf2/FluidR3_GM.sf2"
OUT = Path("web/editor/sounds")
SR = 44100
LEAD_IN = 0.05  # silence before each note in a sprite (s)

# id, name, category, GM program, lowest, highest, step, seconds, sustained?
INSTRUMENTS = [
    ("piano", "Grand piano", "Keys", 0, 28, 100, 3, 4.5, False),
    ("epiano", "Electric piano", "Keys", 4, 36, 88, 4, 4.0, False),
    ("organ", "Organ", "Keys", 16, 36, 88, 4, 3.0, True),
    ("vibes", "Vibraphone", "Keys", 11, 53, 89, 4, 3.5, False),
    ("marimba", "Marimba", "Keys", 12, 45, 88, 4, 2.0, False),
    ("steel", "Steel guitar", "Guitar", 25, 40, 86, 3, 4.0, False),
    ("nylon", "Nylon guitar", "Guitar", 24, 40, 86, 3, 3.5, False),
    ("clean", "Clean electric", "Guitar", 27, 40, 86, 4, 4.0, False),
    ("drive", "Overdriven guitar", "Guitar", 29, 40, 80, 4, 4.0, True),
    ("harp", "Harp", "Guitar", 46, 36, 96, 4, 3.5, False),
    ("bass", "Electric bass", "Bass", 33, 28, 64, 3, 3.0, False),
    ("upright", "Upright bass", "Bass", 32, 28, 64, 3, 3.0, False),
    ("synthbass", "Synth bass", "Bass", 38, 28, 64, 4, 2.5, False),
    ("strings", "String section", "Strings and pads", 48, 36, 96, 4, 4.5, True),
    ("cello", "Cello", "Strings and pads", 42, 36, 72, 4, 4.0, True),
    ("violin", "Violin", "Strings and pads", 40, 55, 96, 4, 4.0, True),
    ("pad", "Warm pad", "Strings and pads", 89, 36, 88, 4, 5.5, True),
    ("choir", "Choir", "Strings and pads", 52, 43, 84, 4, 4.5, True),
    ("brass", "Brass section", "Winds and leads", 61, 40, 84, 4, 3.5, True),
    ("sax", "Alto sax", "Winds and leads", 65, 49, 84, 4, 3.5, True),
    ("flute", "Flute", "Winds and leads", 73, 60, 96, 4, 3.5, True),
    ("saw", "Saw lead", "Winds and leads", 81, 36, 96, 4, 3.5, True),
    ("square", "Square lead", "Winds and leads", 80, 36, 96, 4, 3.5, True),
]
# id, name, GM drum kit program
KITS = [("kit", "Standard kit", 0), ("kit-power", "Power kit", 16), ("kit-808", "808 kit", 25), ("kit-jazz", "Jazz kit", 32), ("kit-brush", "Brush kit", 40)]
# pitch, seconds
DRUM_HITS = [(36, 1.0), (37, 0.6), (38, 1.0), (39, 0.8), (41, 1.4), (45, 1.2), (48, 1.0), (42, 0.5), (44, 0.5), (46, 1.6), (49, 3.0), (51, 2.5), (53, 2.0), (54, 0.8), (56, 0.8), (70, 0.5), (75, 0.5)]


def render(events: list[tuple[float, int, float]], program: int, drums: bool, total: float) -> np.ndarray:
    """Play (time, pitch, seconds held) through fluidsynth and return mono audio."""
    mid = mido.MidiFile(ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    channel = 9 if drums else 0
    track.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))  # 120 bpm: 960 ticks per second
    track.append(mido.Message("program_change", program=program, channel=channel, time=0))
    msgs = []
    for t, pitch, held in events:
        msgs.append((t, mido.Message("note_on", note=pitch, velocity=100, channel=channel)))
        msgs.append((t + held, mido.Message("note_off", note=pitch, velocity=0, channel=channel)))
    msgs.append((total, mido.Message("note_off", note=0, velocity=0, channel=channel)))
    now = 0.0
    for t, msg in sorted(msgs, key=lambda m: m[0]):
        track.append(msg.copy(time=int(round((t - now) * 960))))
        now = t
    with tempfile.TemporaryDirectory() as tmp:
        mid.save(f"{tmp}/in.mid")
        cmd = ["fluidsynth", "-ni", "-q", "-g", "0.7", "-R", "0", "-C", "0", "-r", str(SR), "-F", f"{tmp}/out.wav", SF2, f"{tmp}/in.mid"]
        subprocess.run(cmd, check=True, capture_output=True)
        audio, sr = sf.read(f"{tmp}/out.wav", always_2d=True)
    assert sr == SR
    return audio.mean(axis=1)


def sprite(name: str, takes: list[tuple[int, np.ndarray]]) -> list[dict]:
    """Write the takes back to back as one MP3 and return where each one starts."""
    peak = max(float(np.abs(a).max()) for _, a in takes) or 1.0
    parts, index, at = [], [], 0.0
    for pitch, audio in takes:
        audio = audio / peak * 0.9
        quiet = np.flatnonzero(np.abs(audio) > 0.002)
        audio = audio[: (quiet[-1] + int(0.05 * SR)) if len(quiet) else int(0.1 * SR)]
        fade = min(len(audio), int(0.03 * SR))
        audio[-fade:] *= np.linspace(1, 0, fade)
        parts += [np.zeros(int(LEAD_IN * SR)), audio]
        index.append({"pitch": pitch, "start": round(at + LEAD_IN, 4), "length": round(len(audio) / SR, 4)})
        at += LEAD_IN + len(audio) / SR
    data = np.concatenate(parts).astype(np.float32)
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-", "-codec:a", "libmp3lame", "-q:a", "5", str(OUT / f"{name}.mp3")]
    subprocess.run(cmd, input=data.tobytes(), check=True)
    return index


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    library = {"source": "FluidR3_GM soundfont by Frank Wen (MIT licence), rendered with FluidSynth", "instruments": []}
    for ident, name, category, program, lo, hi, step, seconds, sustained in INSTRUMENTS:
        pitches = list(range(lo, hi + 1, step))
        slot = seconds + 1.5
        held = seconds - (0.4 if sustained else 0.1)
        audio = render([(i * slot, p, held) for i, p in enumerate(pitches)], program, False, len(pitches) * slot)
        takes = [(p, audio[int(i * slot * SR) : int((i + 1) * slot * SR)].copy()) for i, p in enumerate(pitches)]
        entry = {"id": ident, "name": name, "category": category, "kind": "pitched", "file": f"{ident}.mp3", "sustained": sustained, "samples": sprite(ident, takes)}
        if sustained:
            entry["loop"] = [1.0, round(held - 0.4, 2)]  # steady part of every sample, for notes longer than the sample
        library["instruments"].append(entry)
        print(f"{ident}: {len(pitches)} notes, {(OUT / f'{ident}.mp3').stat().st_size // 1024} KB", file=sys.stderr)
    for ident, name, program in KITS:
        slot = 4.0
        audio = render([(i * slot, p, 0.2) for i, (p, _) in enumerate(DRUM_HITS)], program, True, len(DRUM_HITS) * slot)
        takes = [(p, audio[int(i * slot * SR) : int((i * slot + secs) * SR)].copy()) for i, (p, secs) in enumerate(DRUM_HITS)]
        library["instruments"].append({"id": ident, "name": name, "category": "Drums", "kind": "drums", "file": f"{ident}.mp3", "sustained": False, "samples": sprite(ident, takes)})
        print(f"{ident}: {(OUT / f'{ident}.mp3').stat().st_size // 1024} KB", file=sys.stderr)
    (OUT / "library.json").write_text(json.dumps(library, separators=(",", ":")))
    total = sum(f.stat().st_size for f in OUT.glob("*.mp3"))
    print(f"{len(library['instruments'])} instruments, {total / 1e6:.1f} MB", file=sys.stderr)


if __name__ == "__main__":
    main()
