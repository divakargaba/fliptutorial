"""Planner evaluation set (lane A1 Proof): labelled videos -> precision/recall of "qualifies".

Labels live in ``content/eval/labels.json``. Each video is labelled by hand from its captions
(and storyboard frames where captions were unclear) as time segments that cover the video:
``{"startS", "endS", "qualifies", "note"}``. A segment qualifies when it teaches or demonstrates
something concrete the learner can do or reason about in code (same rule as the classifier
prompt); intros, sponsors, chit-chat, career talk, music etc. do not.

Commands (run from ``backend/``)::

    python -m app.planner.evaluate probe <videoId>...      # title, caption kind, length
    python -m app.planner.evaluate fetch <videoId>...      # cache captions in content/eval/captions/ (gitignored)
    python -m app.planner.evaluate view <videoId> [step]   # condensed captions for labelling
    python -m app.planner.evaluate frames <videoId> <s>    # save the storyboard sheet holding second s
    python -m app.planner.evaluate run [videoId...]        # classify labelled videos (real Claude) -> results.json
    python -m app.planner.evaluate score                   # results.json + labels.json -> REPORT.md

``run`` uses the live planner's classification path (``Planner._classify``: windows, validation,
answer-on-screen check, numbering) with a throwaway plan store and no exercise generation.

Scoring (``score_video``): each predicted section gets a ground-truth label by overlap: it is a
true "qualifies" section when at least half of its time lies in labelled qualifying segments.
Section precision = true qualifying among predicted-qualifying sections; recall = predicted-
qualifying among true qualifying sections. Time-weighted versions use seconds instead of section
counts. A pause is correct when its time lies in a labelled qualifying segment and, for a
``question_posed`` pause, it does not sit after the answer of a labelled challenge
(``answerS <= t < endS``).
"""

from __future__ import annotations

import asyncio
import json
import math
import sys
import tempfile
from dataclasses import asdict
from pathlib import Path

from ..transcripts import Cue, Transcript, TranscriptFetcher

EVAL_DIR = Path(__file__).resolve().parents[2] / "content" / "eval"
LABELS = EVAL_DIR / "labels.json"
RESULTS = EVAL_DIR / "results.json"
REPORT = EVAL_DIR / "REPORT.md"
CAPTIONS = EVAL_DIR / "captions"
FRAMES = EVAL_DIR / "frames"
PRECISION_BAR = 0.9


# ---------------------------------------------------------------------------
# Captions cache (so labelling and the run see the same captions)
# ---------------------------------------------------------------------------


def _save_transcript(t: Transcript) -> None:
    CAPTIONS.mkdir(parents=True, exist_ok=True)
    d = {"videoId": t.video_id, "kind": t.kind, "language": t.language, "title": t.title,
         "cues": [[c.id, c.start_s, c.end_s, c.text] for c in t.cues]}
    (CAPTIONS / f"{t.video_id}.json").write_text(json.dumps(d), encoding="utf-8")


def truncate(t: Transcript, until_s: float | None) -> Transcript:
    """Long videos are labelled (and classified) only up to ``labelledUntilS``."""
    if until_s is None:
        return t
    return Transcript(t.video_id, t.kind, t.language, t.title, tuple(c for c in t.cues if c.start_s < until_s))


def load_transcript(video_id: str) -> Transcript | None:
    p = CAPTIONS / f"{video_id}.json"
    if not p.exists():
        return None
    d = json.loads(p.read_text(encoding="utf-8"))
    return Transcript(d["videoId"], d["kind"], d["language"], d["title"],
                      tuple(Cue(i, s, e, x) for i, s, e, x in d["cues"]))


async def _fetch(ids: list[str], save: bool) -> None:
    f = TranscriptFetcher()

    async def one(v: str) -> None:
        try:
            t = load_transcript(v) if save else None
            t = t or await f.get(v)
            if save:
                _save_transcript(t)
            print(f"{v}  {t.kind:6} {t.cues[-1].end_s / 60:6.1f} min  {t.title}")
        except Exception as exc:  # report and continue
            print(f"{v}  ERR {getattr(exc, 'code', type(exc).__name__)}")

    await asyncio.gather(*(one(v) for v in ids))
    await f.close()


def view(video_id: str, step: float = 60.0, width: int = 220) -> None:
    t = load_transcript(video_id)
    if t is None:
        sys.exit(f"no cached captions for {video_id}; run fetch first")
    print(f"# {video_id} {t.title} ({t.kind}, {t.cues[-1].end_s / 60:.1f} min)")
    bucket: list[str] = []
    start = 0.0
    for c in t.cues:
        if c.start_s >= start + step and bucket:
            print(f"[{int(start // 60):3d}:{int(start % 60):02d}] {' '.join(bucket)[:width]}")
            bucket, start = [], step * (c.start_s // step)
        bucket.append(c.text.replace("\n", " "))
    if bucket:
        print(f"[{int(start // 60):3d}:{int(start % 60):02d}] {' '.join(bucket)[:width]}")


async def _frames(video_id: str, at_s: float) -> None:
    from .screen import StoryboardFetcher, image_type

    sf = StoryboardFetcher()
    board = await sf.board(video_id)
    if board is None:
        sys.exit("no storyboard")
    k = board.frame_at(at_s)
    sheet = k // board.per_sheet
    data = await sf.sheet(board, sheet)
    if not data:
        sys.exit("sheet fetch failed")
    FRAMES.mkdir(parents=True, exist_ok=True)
    ext = {"image/webp": "webp"}.get(image_type(data) or "", "jpg")
    out = FRAMES / f"{video_id}-{sheet}.{ext}"
    out.write_bytes(data)
    first = board.time_of(sheet * board.per_sheet)
    print(f"{out}  {board.cols}x{board.rows} tiles, {board.interval_s:.0f}s apart, first tile at {first:.0f}s")


# ---------------------------------------------------------------------------
# Run the classifier
# ---------------------------------------------------------------------------


async def _run(ids: list[str], out: Path = RESULTS) -> None:
    from . import anthropic_model_call, resolve_model, screen_check
    from .service import Planner, PlanStore, VideoState

    labels = {v["videoId"]: v for v in json.loads(LABELS.read_text(encoding="utf-8"))["videos"]}
    results = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {"videos": {}}
    fetcher = TranscriptFetcher()

    async def fetch(v: str) -> Transcript:
        t = load_transcript(v)
        if t is None:
            t = await fetcher.get(v)
            _save_transcript(t)
        return truncate(t, labels[v].get("labelledUntilS"))

    async def no_verify(_ex) -> bool:  # never called: run does not generate exercises
        return False

    call = anthropic_model_call()
    sem = asyncio.Semaphore(4)
    with tempfile.TemporaryDirectory() as tmp:
        planner = Planner(fetch_transcript=fetch, model_call=call, verify=no_verify,
                          store=PlanStore(Path(tmp)), screen_check=screen_check(call),
                          max_new_videos_per_hour=10_000)

        async def one(v: str) -> None:
            async with sem:
                st = VideoState(v)
                await planner._classify(st)
                results["videos"][v] = {
                    "status": st.status, "reason": st.reason,
                    "sections": [{"startS": round(s.start_s, 1), "endS": round(s.end_s, 1), "title": s.title,
                                  "format": s.format, "language": s.language, "qualifies": s.qualifies,
                                  "confidence": s.confidence,
                                  "pauses": [{k: d[k] for k in ("id", "pause_at_s", "reveal_at_s", "trigger",
                                                               "concept", "idea", "rank", "screen")}
                                             for d in map(asdict, s.pauses)]}
                                 for s in st.sections],
                }
                print(f"{v}  {st.status:10} sections={len(st.sections)} pauses={len(st.slots)}")

        await asyncio.gather(*(one(v) for v in (ids or list(labels))))
    await fetcher.close()
    results["model"] = resolve_model()
    out.write_text(json.dumps(results, indent=1) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Scoring (pure, unit-tested)
# ---------------------------------------------------------------------------


def _overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def qualifying_seconds(segments: list[dict], start: float, end: float) -> float:
    return sum(_overlap(start, end, g["startS"], g["endS"]) for g in segments if g["qualifies"])


def labelled_at(segments: list[dict], t: float) -> bool:
    return any(g["startS"] <= t < g["endS"] and g["qualifies"] for g in segments)


def score_video(label: dict, result: dict) -> dict:
    """Counts for one video: sections tp/fp/fn/tn, seconds tp/fp/fn, pauses correct/total."""
    segs = label["segments"]
    until = label.get("labelledUntilS") or max(g["endS"] for g in segs)
    c = {"tp": 0, "fp": 0, "fn": 0, "tn": 0, "tp_s": 0.0, "fp_s": 0.0, "fn_s": 0.0,
         "pauses": 0, "pauses_ok": 0, "bad_pauses": [], "errors": []}
    sections = [{**s, "endS": min(s["endS"], until)} for s in result.get("sections", []) if s["startS"] < until]
    for s in sections:
        dur = max(0.0, s["endS"] - s["startS"])
        q_s = qualifying_seconds(segs, s["startS"], s["endS"])
        truth = dur > 0 and q_s >= 0.5 * dur
        pred = bool(s["qualifies"])
        kind = {(True, True): "tp", (True, False): "fp", (False, True): "fn", (False, False): "tn"}[(pred, truth)]
        c[kind] += 1
        if kind in ("fp", "fn"):
            c["errors"].append({"kind": kind.upper(), "startS": s["startS"], "endS": s["endS"],
                                "labelledShare": round(q_s / dur, 2) if dur else 0.0, "format": s.get("format", ""),
                                "confidence": s.get("confidence", ""), "title": s.get("title", "")})
        if pred:
            c["tp_s"] += q_s
            c["fp_s"] += dur - q_s
        else:
            c["fn_s"] += q_s
        for p in s.get("pauses", []):
            t = p["pause_at_s"]
            if t >= until:
                continue  # past the labelled span (the last cue can end a little after it)
            ok = labelled_at(segs, t)
            if p.get("trigger") == "question_posed":  # demonstration pauses ask a NEW problem, so they may follow an answer
                for ch in label.get("challenges", []):
                    if ch["answerS"] <= t < ch["endS"]:
                        ok = False  # the instructor already gave the answer to this challenge
            c["pauses"] += 1
            c["pauses_ok"] += ok
            if not ok:
                c["bad_pauses"].append(t)
    # Labelled qualifying time the classifier never covered (e.g. a window it skipped) is missed.
    covered = sum(_overlap(s["startS"], s["endS"], g["startS"], g["endS"])
                  for s in sections for g in segs if g["qualifies"])
    c["fn_s"] += max(0.0, sum(g["endS"] - g["startS"] for g in segs if g["qualifies"]) - covered)
    return c


def _ratio(a: float, b: float) -> float | None:
    return a / b if b else None


def pause_kinds(result: dict) -> dict:
    """Planned kind of every pause: coding vs concept (MC) under the current rule (``planned_kind``)
    and under the previous rule (concept_complete always got a concept question). Before generation:
    an exercise that later fails generation or the sandbox verify still falls back to a concept question."""
    from types import SimpleNamespace

    from .service import planned_kind

    c = {"coding": 0, "concept": 0, "coding_old": 0, "concept_old": 0}
    for s in result.get("sections", []):
        sec = SimpleNamespace(format=s.get("format", ""), language=str(s.get("language", "")).lower())
        for p in s.get("pauses", []):
            kind = planned_kind(sec, SimpleNamespace(trigger=p.get("trigger", "")))
            c[kind] += 1
            old = "concept" if p.get("trigger") == "concept_complete" else kind
            c[f"{old}_old"] += 1
    return c


def summarize(labels: list[dict], results: dict) -> dict:
    tot = {"tp": 0, "fp": 0, "fn": 0, "tn": 0, "tp_s": 0.0, "fp_s": 0.0, "fn_s": 0.0, "pauses": 0, "pauses_ok": 0,
           "coding": 0, "concept": 0, "coding_old": 0, "concept_old": 0}
    per = []
    verdict_ok = 0
    for lab in labels:
        res = results["videos"].get(lab["videoId"])
        if res is None:
            continue
        c = {**score_video(lab, res), **pause_kinds(res)}
        for k in tot:
            tot[k] += c[k]
        coding = any(g["qualifies"] for g in lab["segments"])
        predicted = res["status"] in ("classified", "ready", "planning")
        verdict_ok += coding == predicted
        per.append({"videoId": lab["videoId"], "category": lab["category"], "coding": coding,
                    "status": res["status"], **c})
    return {
        "videos": len(per), "verdict_accuracy": _ratio(verdict_ok, len(per)),
        "precision": _ratio(tot["tp"], tot["tp"] + tot["fp"]), "recall": _ratio(tot["tp"], tot["tp"] + tot["fn"]),
        "precision_time": _ratio(tot["tp_s"], tot["tp_s"] + tot["fp_s"]),
        "recall_time": _ratio(tot["tp_s"], tot["tp_s"] + tot["fn_s"]),
        "pause_correct": _ratio(tot["pauses_ok"], tot["pauses"]), "totals": tot, "per_video": per,
    }


def _pct(x: float | None) -> str:
    return "n/a" if x is None else f"{x:.3f}"


def wilson_low(k: int, n: int, z: float = 1.96) -> float | None:
    """Lower end of the 95% Wilson interval for k successes out of n."""
    if not n:
        return None
    p = k / n
    centre = p + z * z / (2 * n)
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (centre - margin) / (1 + z * z / n)


def _meets(s: dict) -> bool:
    return s["precision"] is not None and s["precision"] >= PRECISION_BAR


def report(labels: list[dict], results: dict, extra: list[tuple[str, dict]] = ()) -> str:
    s = summarize(labels, results)
    t = s["totals"]
    others = [(name, summarize(labels, r)) for name, r in extra]
    on = _meets(s) and all(_meets(o) for _, o in others)
    lines = [
        "# Planner eval: section \"qualifies\" precision / recall",
        "",
        f"Model `{results.get('model', '?')}`, {s['videos']} labelled videos "
        f"(`labels.json`, labelled from captions and storyboard frames). Regenerate with "
        "`python -m app.planner.evaluate run && python -m app.planner.evaluate score` from `backend/`.",
        "",
        "| Metric | Value |",
        "| --- | --- |",
        f"| Section precision (qualifies) | **{_pct(s['precision'])}** ({t['tp']} / {t['tp'] + t['fp']}; "
        f"95% lower bound {_pct(wilson_low(t['tp'], t['tp'] + t['fp']))}) |",
        f"| Section recall (qualifies) | **{_pct(s['recall'])}** ({t['tp']} / {t['tp'] + t['fn']}) |",
        f"| Time-weighted precision | {_pct(s['precision_time'])} |",
        f"| Time-weighted recall | {_pct(s['recall_time'])} |",
        f"| Video verdict accuracy (coding vs not_coding) | {_pct(s['verdict_accuracy'])} |",
        f"| Pauses inside labelled teaching, before a labelled answer | {_pct(s['pause_correct'])} "
        f"({t['pauses_ok']} / {t['pauses']}) |",
        f"| Planned coding : concept (MC) pauses | **{t['coding']} : {t['concept']}** "
        f"(previous rule, concept_complete always MC: {t['coding_old']} : {t['concept_old']}) |",
        "",
        "Planned kinds are before generation; a coding pause whose exercise fails generation or the "
        "sandbox verify still falls back to a concept question.",
        "",
        f"Bar: auto-pause turns on when section precision >= {PRECISION_BAR}"
        + (" in every run" if others else "") + ". "
        f"Result: **{'met, auto-pause on' if on else 'not met, auto-pause stays off'}**.",
        "",
    ]
    if others:
        lines += ["## Repeat runs (same labels, same captions)", "",
                  "| Run | Precision | Recall | Time precision | Time recall | Verdict accuracy | Pauses ok | Coding : MC |",
                  "| --- | --- | --- | --- | --- | --- | --- | --- |"]
        for name, o in [(results.get("name", "results.json"), s), *others]:
            lines.append(f"| `{name}` | {_pct(o['precision'])} | {_pct(o['recall'])} | {_pct(o['precision_time'])} "
                         f"| {_pct(o['recall_time'])} | {_pct(o['verdict_accuracy'])} | {_pct(o['pause_correct'])} "
                         f"| {o['totals']['coding']} : {o['totals']['concept']} |")
        lines.append("")
    lines += [
        "## Per video",
        "",
        "| Video | Category | Labelled coding | Status | TP | FP | FN | TN | Pauses ok | Wrong pauses (s) |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    titles = {lab["videoId"]: lab.get("title", "") for lab in labels}
    for p in s["per_video"]:
        bad = ", ".join(f"{b:.0f}" for b in p["bad_pauses"]) or "-"
        lines.append(f"| `{p['videoId']}` {titles[p['videoId']][:50]} | {p['category']} | {'yes' if p['coding'] else 'no'} "
                     f"| {p['status']} | {p['tp']} | {p['fp']} | {p['fn']} | {p['tn']} | {p['pauses_ok']}/{p['pauses']} | {bad} |")
    lines += ["", "## Misclassified sections", "",
              "Labelled share = fraction of the section's time labelled as qualifying (>= 0.5 counts as qualifying).", "",
              "| Video | Kind | Span (s) | Labelled share | Format | Confidence | Section title |",
              "| --- | --- | --- | --- | --- | --- | --- |"]
    for p in s["per_video"]:
        for e in p["errors"]:
            lines.append(f"| `{p['videoId']}` | {e['kind']} | {e['startS']:.0f}-{e['endS']:.0f} | {e['labelledShare']:.2f} "
                         f"| {e['format']} | {e['confidence']} | {e['title']} |")
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> None:
    if not argv:
        sys.exit(__doc__)
    cmd, args = argv[0], argv[1:]
    if cmd in ("probe", "fetch"):
        asyncio.run(_fetch(args, save=cmd == "fetch"))
    elif cmd == "view":
        step, width = 60.0, 220
        if "--step" in args:
            i = args.index("--step")
            step = float(args.pop(i + 1))
            args.pop(i)
        if "--width" in args:
            i = args.index("--width")
            width = int(args.pop(i + 1))
            args.pop(i)
        for v in args:
            view(v, step, width)
    elif cmd == "frames":
        asyncio.run(_frames(args[0], float(args[1])))
    elif cmd == "run":
        out = RESULTS
        if "--out" in args:
            i = args.index("--out")
            out = Path(args.pop(i + 1))
            args.pop(i)
        asyncio.run(_run(args, out))
    elif cmd == "score":
        labels = json.loads(LABELS.read_text(encoding="utf-8"))["videos"]
        paths = [Path(a) for a in args] or [RESULTS]
        runs = [(p.name, {**json.loads(p.read_text(encoding="utf-8")), "name": p.name}) for p in paths]
        REPORT.write_text(report(labels, runs[0][1], runs[1:]), encoding="utf-8")
        print(REPORT.read_text(encoding="utf-8"))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
