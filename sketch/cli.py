"""Command line for the song sketch.

    sketch build memo.m4a                      memo -> sketch, MIDI, previews
    sketch show out/memo.sketch.json           bar-by-bar text summary
    sketch edit out/memo.sketch.json OP ...    transpose, velocity, clear, thin, repeat, delete, tempo
    sketch parts out/memo.sketch.json          regenerate bass / pad / drums from the guitar
    sketch render out/memo.sketch.json         sketch -> MIDI and previews (after any edit)
"""

from __future__ import annotations

import argparse
from pathlib import Path

PART_CHOICES = ("guitar", "bass", "pad", "drums", "all")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="sketch", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    b = sub.add_parser("build", help="memo -> sketch JSON, MIDI and previews")
    b.add_argument("audio", nargs="+", type=Path)
    b.add_argument("--out", type=Path, default=Path("out"))
    b.add_argument("--meter", type=int, default=None, help="beats per bar (default: guess, usually 4)")
    b.add_argument("--downbeat-shift", type=int, default=None, help="move bar lines later by this many beats")
    b.add_argument(
        "--beats", type=Path, default=None,
        help="tapped-beat file (default: data/beats/NAME.beats.json if it exists; --no-beats ignores it)",
    )
    b.add_argument("--no-beats", action="store_true", help="use the automatic beat tracker even if taps exist")
    b.add_argument("--no-parts", action="store_true", help="skip the generated bass, pad and drums")
    b.add_argument("--no-previews", action="store_true")

    r = sub.add_parser("render", help="sketch JSON -> MIDI and previews")
    r.add_argument("sketch", nargs="+", type=Path)
    r.add_argument("--no-previews", action="store_true")

    s = sub.add_parser("show", help="bar-by-bar text summary")
    s.add_argument("sketch", type=Path)
    s.add_argument("--bars", help="e.g. 5-8")

    x = sub.add_parser("project", help="sketch -> song project for the editor (bars, tracks, chords, scales)")
    x.add_argument("sketch", nargs="+", type=Path)

    p = sub.add_parser("parts", help="regenerate bass / pad / drums from the guitar notes")
    p.add_argument("sketch", type=Path)
    p.add_argument("--only", nargs="+", choices=("bass", "pad", "drums"), default=["bass", "pad", "drums"])

    e = sub.add_parser("edit", help="change the sketch; run `render` afterwards to hear it")
    e.add_argument("sketch", type=Path)
    ops = e.add_subparsers(dest="op", required=True)

    def scoped(name: str, text: str, default_part: str = "all") -> argparse.ArgumentParser:
        op = ops.add_parser(name, help=text)
        op.add_argument("--bars", help="e.g. 5-8 (default: whole song)")
        op.add_argument("--part", nargs="+", choices=PART_CHOICES, default=[default_part])
        return op

    scoped("transpose", "move pitches up or down").add_argument("semitones", type=int)
    scoped("velocity", "louder or softer").add_argument("scale", type=float)
    scoped("clear", "remove the notes in these bars")
    t = scoped("thin", "keep only on-grid and/or loud notes", default_part="guitar")
    t.add_argument("--grid", type=float, help="keep notes starting on multiples of this many beats (1 = on the beat)")
    t.add_argument("--min-velocity", type=float, help="keep notes at least this loud (0-1)")
    rep = ops.add_parser("repeat", help="play these bars again right after themselves")
    rep.add_argument("bars")
    rep.add_argument("--times", type=int, default=1)
    ops.add_parser("delete", help="cut these bars out").add_argument("bars")
    tp = ops.add_parser("tempo", help="set the steady tempo, for the whole song or for some bars")
    tp.add_argument("bpm", type=float)
    tp.add_argument("--bars", help="e.g. 5-8 (default: whole song)")

    args = parser.parse_args(argv)
    from . import build as sk
    from . import edit

    if args.command == "build":
        for audio in args.audio:
            beats = args.beats or Path("data/beats") / f"{audio.stem}.beats.json"
            beats = beats if beats.exists() and not args.no_beats else None
            sketch = sk.build(
                audio, meter=args.meter, downbeat_shift=args.downbeat_shift, parts=not args.no_parts, beats=beats
            )
            print(f"beat grid from {'your taps (' + str(beats) + ')' if beats else 'the automatic tracker'}")
            path = sk.write(sketch, args.out / f"{audio.stem}.sketch.json")
            if sketch["division_from"].startswith("notes"):
                print(f"each beat divides in {sketch['division']}, going by the {sketch['division_from']}")
            print("\n".join(line for line in edit.overview(sketch).split("\n") if not line.startswith("bar ")))
            for made in [path, *sk.render(path, previews=not args.no_previews, light=True)]:
                print(f"  {made}")
    elif args.command == "render":
        for path in args.sketch:
            sk.write(sk.refresh(sk.read(path)), path)
            for made in sk.render(path, previews=not args.no_previews):
                print(f"  {made}")
    elif args.command == "project":
        from . import project as pj

        for path in args.sketch:
            project = pj.from_sketch(sk.refresh(sk.read(path)))
            out = pj.write(project, path.with_name(path.name.removesuffix(".sketch.json") + ".project.json"))
            print(f"{out}: {len(project['bars'])} bars, {len(project['sections'])} sections, {len(project['tracks'])} tracks")
            print("  chords: " + ", ".join(f"{c['name']} ({c['beats']} beats)" for c in project["chords"][:10]))
            print("  scales: " + ", ".join(
                f"{s['name']} {s['fit']:.0%}" + ("" if s["bars"] == [1, len(project["bars"])] else f" in bars {s['bars'][0]}-{s['bars'][1]}")
                for s in project["scales"]
            ))
    elif args.command == "show":
        print(edit.overview(sk.refresh(sk.read(args.sketch)), args.bars))
    elif args.command == "parts":
        sketch = sk.refresh(sk.read(args.sketch))
        edit.regenerate(sketch, only=tuple(args.only))
        sk.write(sk.refresh(sketch), args.sketch)
        print(f"regenerated {', '.join(args.only)}")
    else:
        sketch = sk.refresh(sk.read(args.sketch))
        parts = tuple(getattr(args, "part", ()))
        if args.op == "transpose":
            print(f"{edit.transpose(sketch, args.semitones, args.bars, parts)} notes transposed")
        elif args.op == "velocity":
            print(f"{edit.velocity(sketch, args.scale, args.bars, parts)} notes changed")
        elif args.op == "clear":
            print(f"{edit.clear(sketch, args.bars, parts)} notes removed")
        elif args.op == "thin":
            if args.grid is None and args.min_velocity is None:
                raise SystemExit("thin needs --grid and/or --min-velocity")
            print(f"{edit.thin(sketch, args.grid, args.min_velocity, args.bars, parts)} notes removed")
        elif args.op == "repeat":
            edit.repeat(sketch, args.bars, args.times)
        elif args.op == "delete":
            edit.delete(sketch, args.bars)
        elif args.op == "tempo":
            edit.tempo(sketch, args.bpm, args.bars)
        sketch = sk.refresh(sketch)
        sk.write(sketch, args.sketch)
        print(edit.overview(sketch).split("\n")[0])


if __name__ == "__main__":
    main()
