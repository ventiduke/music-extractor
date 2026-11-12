"""Command line: `extract notes memo.m4a` and `extract templates`."""

from __future__ import annotations

import argparse
from pathlib import Path

from .types import STANDARD_TUNING

DEFAULT_TEMPLATES = Path("data/templates/templates.json")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="extract", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    notes = sub.add_parser("notes", help="turn audio files into MIDI + JSON")
    notes.add_argument("audio", nargs="+", type=Path)
    notes.add_argument("--engine", choices=("model", "dsp"), default="model")
    notes.add_argument("--out", type=Path, default=Path("out"))
    notes.add_argument("--tuning", default=STANDARD_TUNING, help='open strings, e.g. "D2 A2 D3 G3 B3 E4"')
    notes.add_argument(
        "--templates", type=Path, default=None,
        help=f"overtone templates (default: {DEFAULT_TEMPLATES} if it exists)",
    )
    notes.add_argument("--no-templates", action="store_true", help="skip the overtone layers")

    tmpl = sub.add_parser("templates", help="build overtone templates from single-note recordings")
    tmpl.add_argument("folder", nargs="?", type=Path, default=Path("data/templates"))
    tmpl.add_argument("--out", type=Path, default=None)

    args = parser.parse_args(argv)
    from .layers import Templates, build_templates

    if args.command == "templates":
        templates = build_templates(args.folder)
        out = args.out or args.folder / "templates.json"
        templates.save(out)
        print(f"{len(templates.harmonics)} note templates -> {out}")
        return

    from .output import write
    from .pipeline import analyse

    path = args.templates or (DEFAULT_TEMPLATES if DEFAULT_TEMPLATES.exists() else None)
    templates = None if args.no_templates or path is None else Templates.read(path)
    if templates is None:
        print("no overtone templates: every pitch is labeled 'played'")
    for audio in args.audio:
        result = analyse(audio, engine=args.engine, templates=templates, tuning=args.tuning)
        mid, sidecar = write(result, args.out, audio.stem)
        print(f"{audio.name}: {len(result.notes)} notes in {len(result.segments)} segments -> {mid}, {sidecar}")


if __name__ == "__main__":
    main()
