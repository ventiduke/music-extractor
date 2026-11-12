"""Score the engines against labeled clips and log every run.

    score                                 # data/clips, both engines
    score --clips data/synth/clips --templates data/synth/templates/templates.json

labels.csv has one row per labeled span: clip, start, end, notes
(`notes` like "E2 B2 E3 G#3"; blank start/end mean the whole clip).
Each run appends its per-span and overall scores to eval/results.csv.
"""

from __future__ import annotations

import argparse
import csv
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from extract.layers import Templates
from extract.pipeline import Result, analyse
from extract.types import STANDARD_TUNING, Settings, note_name, parse_notes

# Starting targets from the build plan.
TARGETS = {
    "precision": 0.85,
    "recall": 0.80,
    "pc_precision": 0.90,
    "pc_recall": 0.90,
    "lowest_ok": 0.90,
    "onset_within_50ms": 1.0,
}
FIELDS = [
    "run", "clip", "start", "approach", "settings", "precision", "recall", "pc_precision",
    "pc_recall", "lowest_ok", "onset_err_ms", "missed", "extra",
]


@dataclass
class Score:
    precision: float
    recall: float
    pc_precision: float
    pc_recall: float
    lowest_ok: bool
    onset_err_ms: float | None
    missed: list[int]
    extra: list[int]


def _ratio(hit: int, total: int) -> float:
    return hit / total if total else 1.0


def predicted_notes(result: Result, start: float, end: float, min_share: float = 0.3) -> set[int]:
    """Played pitches that sound for at least `min_share` of a labeled span."""
    held: dict[int, float] = defaultdict(float)
    for seg in result.segments:
        overlap = min(seg.end, end) - max(seg.start, start)
        if overlap > 0:
            for pitch in seg.played():
                held[pitch] += overlap
    return {p for p, t in held.items() if t >= min_share * (end - start)}


def score_span(result: Result, start: float | None, end: float | None, truth: set[int]) -> Score:
    a = 0.0 if start is None else start
    b = result.duration if end is None else end
    pred = predicted_notes(result, a, b)
    pc_pred, pc_truth = {p % 12 for p in pred}, {p % 12 for p in truth}
    onset = None
    if start is not None and result.segments:
        onset = 1000 * min(abs(s.start - start) for s in result.segments)
    return Score(
        precision=_ratio(len(pred & truth), len(pred)) if pred else 0.0,
        recall=_ratio(len(pred & truth), len(truth)),
        pc_precision=_ratio(len(pc_pred & pc_truth), len(pc_pred)) if pred else 0.0,
        pc_recall=_ratio(len(pc_pred & pc_truth), len(pc_truth)),
        lowest_ok=bool(pred) and min(pred) == min(truth),
        onset_err_ms=onset,
        missed=sorted(truth - pred),
        extra=sorted(pred - truth),
    )


def read_labels(path: Path) -> dict[str, list[tuple[float | None, float | None, set[int]]]]:
    spans = defaultdict(list)
    with open(path, newline="") as fh:
        for row in csv.DictReader(fh):
            if not (row.get("clip") or "").strip():
                continue
            start = float(row["start"]) if (row.get("start") or "").strip() else None
            end = float(row["end"]) if (row.get("end") or "").strip() else None
            spans[row["clip"].strip()].append((start, end, set(parse_notes(row["notes"]))))
    return spans


def summarise(scores: list[Score]) -> dict[str, float]:
    n = len(scores)
    onsets = [s.onset_err_ms for s in scores if s.onset_err_ms is not None]
    out = {k: sum(getattr(s, k) for s in scores) / n for k in ("precision", "recall", "pc_precision", "pc_recall")}
    out["lowest_ok"] = sum(s.lowest_ok for s in scores) / n
    if onsets:
        out["onset_within_50ms"] = sum(e <= 50 for e in onsets) / len(onsets)
        out["onset_err_ms"] = sum(onsets) / len(onsets)
    return out


def run(
    clips: Path, engines: list[str], templates: Templates | None, tuning: str, cfg: Settings,
    results: Path | None, verbose: bool = True,
) -> dict[str, dict[str, float]]:
    labels = read_labels(clips / "labels.csv")
    if not labels:
        raise SystemExit(f"{clips / 'labels.csv'} has no labeled spans yet")
    stamp = datetime.now().isoformat(timespec="seconds")
    rows, summaries = [], {}
    for engine in engines:
        approach = engine + ("+layers" if templates else "")
        settings = cfg.describe(engine)
        scores: list[Score] = []
        for clip, spans in labels.items():
            result = analyse(clips / clip, engine=engine, templates=templates, tuning=tuning, cfg=cfg)
            for start, end, truth in spans:
                s = score_span(result, start, end, truth)
                scores.append(s)
                rows.append({
                    "run": stamp, "clip": clip, "start": "" if start is None else start,
                    "approach": approach, "settings": settings,
                    "precision": round(s.precision, 3), "recall": round(s.recall, 3),
                    "pc_precision": round(s.pc_precision, 3), "pc_recall": round(s.pc_recall, 3),
                    "lowest_ok": int(s.lowest_ok),
                    "onset_err_ms": "" if s.onset_err_ms is None else round(s.onset_err_ms, 1),
                    "missed": " ".join(map(note_name, s.missed)),
                    "extra": " ".join(map(note_name, s.extra)),
                })
                if verbose and (s.missed or s.extra):
                    where = f"{clip} @{start}" if start is not None else clip
                    print(f"  [{approach}] {where}: missed {rows[-1]['missed'] or '-'}, extra {rows[-1]['extra'] or '-'}")
        summary = summaries[approach] = summarise(scores)
        rows.append({
            "run": stamp, "clip": "ALL", "start": "", "approach": approach, "settings": settings,
            **{k: round(v, 3) for k, v in summary.items() if k in FIELDS}, "missed": "", "extra": "",
        })
    if results is not None:
        results.parent.mkdir(parents=True, exist_ok=True)
        new = not results.exists()
        with open(results, "a", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=FIELDS)
            if new:
                writer.writeheader()
            writer.writerows(rows)
    if verbose:
        print(f"\n{'metric':<20}" + "".join(f"{a:>14}" for a in summaries) + f"{'target':>10}")
        for metric, target in TARGETS.items():
            cells = ""
            for summary in summaries.values():
                value = summary.get(metric)
                mark = "" if value is None else (" ok" if value >= target else " --")
                cells += f"{'n/a' if value is None else f'{value:.0%}{mark}':>14}"
            print(f"{metric:<20}{cells}{target:>10.0%}")
    return summaries


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="score", description=__doc__.split("\n")[0])
    parser.add_argument("--clips", type=Path, default=Path("data/clips"))
    parser.add_argument("--engine", nargs="+", choices=("model", "dsp"), default=["model", "dsp"])
    parser.add_argument("--templates", type=Path, default=None)
    parser.add_argument("--tuning", default=STANDARD_TUNING)
    parser.add_argument("--results", type=Path, default=Path("eval/results.csv"))
    args = parser.parse_args(argv)
    templates = Templates.read(args.templates) if args.templates else None
    run(args.clips, args.engine, templates, args.tuning, Settings(), args.results)


if __name__ == "__main__":
    main()
