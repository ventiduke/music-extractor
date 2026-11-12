"""Command line: `sketch build memo.m4a`, then `sketch render out/memo.sketch.json` after edits."""

from __future__ import annotations

import argparse
from pathlib import Path


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="sketch", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    b = sub.add_parser("build", help="memo -> sketch JSON, tidied MIDI and previews")
    b.add_argument("audio", nargs="+", type=Path)
    b.add_argument("--out", type=Path, default=Path("out"))
    b.add_argument("--meter", type=int, default=4, help="beats per bar (default 4)")
    b.add_argument("--downbeat-shift", type=int, default=None, help="move bar lines later by this many beats")
    b.add_argument("--strength", type=float, default=1.0, help="1 = snap fully to the grid, 0 = keep played timing")
    b.add_argument("--no-previews", action="store_true")

    r = sub.add_parser("render", help="sketch JSON (after editing) -> tidied MIDI and previews")
    r.add_argument("sketch", nargs="+", type=Path)
    r.add_argument("--no-previews", action="store_true")

    args = parser.parse_args(argv)
    from . import build as sk

    if args.command == "build":
        for audio in args.audio:
            sketch = sk.build(audio, meter=args.meter, downbeat_shift=args.downbeat_shift, strength=args.strength)
            path = sk.write(sketch, args.out / f"{audio.stem}.sketch.json")
            key = sketch["key"]
            print(
                f"{audio.name}: {sketch['tempo_bpm']} bpm, {sketch['bars']} bars of {sketch['meter']}, "
                f"{key['tonic']} {key['mode']}, {len(sketch['notes'])} notes kept, {len(sketch['dropped'])} dropped"
            )
            for made in [path, *sk.render(path, previews=not args.no_previews)]:
                print(f"  {made}")
    else:
        for path in args.sketch:
            sk.write(sk.refresh(sk.read(path)[0]), path)
            for made in sk.render(path, previews=not args.no_previews):
                print(f"  {made}")


if __name__ == "__main__":
    main()
