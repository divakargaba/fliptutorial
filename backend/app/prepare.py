"""Video prep pipeline: transcript scan, review verification, and publishing.

Commands (run from backend/):

    .venv/bin/python -m app.prepare scan    --video-id VIDEO_ID
    .venv/bin/python -m app.prepare verify  --video-id VIDEO_ID
    .venv/bin/python -m app.prepare publish --video-id VIDEO_ID

Flow (PRD §3):

* ``scan`` loads the seed's timestamped transcript, asks Gemini for challenge
  candidates per scan window (structured output, cue ids required), validates
  them, and writes ``content/drafts/{videoId}.scan.json``. Nothing here is
  served at runtime.
* A human reviews the candidate against the original video and writes
  ``content/reviewed/{videoId}.json`` (timing, evidence, exercise, tests).
* ``verify`` validates the reviewed file, recomputes the safe pause, runs the
  reference solution (must pass every case) and the known-wrong solution (must
  fail at least one), and records the digest of exactly what it verified in
  ``content/drafts/{videoId}.verified.json``.
* ``publish`` revalidates, re-runs verification, refuses if the reviewed file
  changed since ``verify``, and atomically writes ``content/approved/{videoId}.json``.
  Any failure leaves the previous approved file untouched.

Errors exit nonzero with a stable code on stderr, e.g. ``INVALID_TRANSCRIPT``.
Keys, hidden tests and solution code are never printed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from pydantic import BaseModel, Field, ValidationError

from .catalog import APPROVED_DIR, VIDEO_ID_RE, ApprovedRecord, build_public_response
from .grader import _build_wrapper

BACKEND_DIR = Path(__file__).resolve().parent.parent
CONTENT_DIR = BACKEND_DIR / "content"
SEEDS_PATH = CONTENT_DIR / "seeds.json"
DRAFTS_DIR = CONTENT_DIR / "drafts"
REVIEWED_DIR = CONTENT_DIR / "reviewed"

LANGUAGES = ("python", "java", "javascript", "other", "unknown")
PUBLISHABLE_LANGUAGES = ("python",)
CONCEPT_TAGS = (
    "arithmetic",
    "loops",
    "conditionals",
    "functions",
    "arrays",
    "strings",
    "binary-search",
    "hash-map",
    "two-pointers",
    "recursion",
    "sorting",
)
# Tags that would spoil the approach if shown; kept internal only.
INTERNAL_TAGS = ("hash-map", "two-pointers", "binary-search")

PREFERRED_LEAD_S = 2.0
MIN_LEAD_S = 1.0
SCAN_CHUNK_S = 300.0
SCAN_OVERLAP_S = 60.0
SOLUTION_TIMEOUT_S = 5.0
# Review-only keys stripped from the reviewed file before it becomes an approved record.
REVIEW_ONLY_KEYS = ("reviewNote",)
REVIEW_ONLY_BREAKPOINT_KEYS = ("evidence", "windowId")


class PrepError(Exception):
    """A prep failure with a stable code (PRD §7)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# Seeds and transcripts
# ---------------------------------------------------------------------------


def _read_json(path: Path, missing_code: str, invalid_code: str) -> Any:
    if not path.is_file():
        raise PrepError(missing_code, f"{path.name} not found")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PrepError(invalid_code, f"{path.name} is not valid JSON: {exc}") from exc


def load_seed(video_id: str, seeds_path: Path = SEEDS_PATH) -> dict:
    if not VIDEO_ID_RE.match(video_id):
        raise PrepError("INVALID_VIDEO_ID", f"malformed video id {video_id!r}")
    seeds = _read_json(seeds_path, "SEEDS_UNAVAILABLE", "INVALID_SEEDS")
    for seed in seeds.get("videos", []):
        if seed.get("videoId") == video_id:
            return seed
    raise PrepError("UNKNOWN_VIDEO", f"{video_id} is not in {seeds_path.name}")


@dataclass(frozen=True)
class Cue:
    id: str
    start_s: float
    end_s: float
    text: str


def _finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def cue_id_for(start_s: float) -> str:
    """Stable cue id derived from the start time in milliseconds."""
    return f"c{round(start_s * 1000):08d}"


def parse_transcript(raw: Any) -> list[Cue]:
    """Validate a transcript excerpt and return cues with stable ids.

    Raises INVALID_TRANSCRIPT for empty, malformed, nonfinite, or
    nonmonotonic input.
    """
    cues_raw = raw.get("cues") if isinstance(raw, dict) else raw
    if not isinstance(cues_raw, list) or not cues_raw:
        raise PrepError("INVALID_TRANSCRIPT", "transcript has no cues")

    cues: list[Cue] = []
    seen: set[str] = set()
    prev_start = -math.inf
    for i, item in enumerate(cues_raw):
        if not isinstance(item, dict):
            raise PrepError("INVALID_TRANSCRIPT", f"cue {i} is not an object")
        start, end, text = item.get("start_s"), item.get("end_s"), item.get("text")
        if not _finite_number(start) or start < 0:
            raise PrepError("INVALID_TRANSCRIPT", f"cue {i} has missing or invalid start_s")
        if end is None:
            end = start
        if not _finite_number(end) or end < start:
            raise PrepError("INVALID_TRANSCRIPT", f"cue {i} has invalid end_s")
        if not isinstance(text, str) or not text.strip():
            raise PrepError("INVALID_TRANSCRIPT", f"cue {i} has empty text")
        if start < prev_start:
            raise PrepError("INVALID_TRANSCRIPT", f"cue {i} is out of order (start_s {start} < {prev_start})")
        cue_id = item.get("id") or cue_id_for(start)
        if not isinstance(cue_id, str) or cue_id in seen:
            raise PrepError("INVALID_TRANSCRIPT", f"cue {i} has a duplicate or invalid id")
        seen.add(cue_id)
        prev_start = start
        cues.append(Cue(cue_id, float(start), float(end), text.strip()))
    return cues


def load_transcript(seed: dict, content_dir: Path = CONTENT_DIR) -> list[Cue]:
    rel = seed.get("transcriptPath")
    if not rel:
        raise PrepError("TRANSCRIPT_UNAVAILABLE", f"seed {seed.get('videoId')} has no transcriptPath")
    raw = _read_json(content_dir / rel, "TRANSCRIPT_UNAVAILABLE", "INVALID_TRANSCRIPT")
    return parse_transcript(raw)


def window_chunks(start_s: float, end_s: float) -> list[tuple[float, float]]:
    """Split a scan window into overlapping five-minute chunks."""
    if end_s - start_s <= SCAN_CHUNK_S:
        return [(start_s, end_s)]
    chunks = []
    t = start_s
    while t < end_s:
        chunks.append((t, min(t + SCAN_CHUNK_S, end_s)))
        if t + SCAN_CHUNK_S >= end_s:
            break
        t += SCAN_CHUNK_S - SCAN_OVERLAP_S
    return chunks


def cues_in(cues: list[Cue], start_s: float, end_s: float) -> list[Cue]:
    return [c for c in cues if c.end_s >= start_s and c.start_s <= end_s]


# ---------------------------------------------------------------------------
# Gemini candidate detection
# ---------------------------------------------------------------------------


class ProviderCandidate(BaseModel):
    """Structured-output schema sent to Gemini (plain types only)."""

    title: str
    task: str
    inputs: str
    expectedOutput: str
    functionName: str
    setupEndCueId: str
    spokenRevealCueId: str
    language: str
    languageEvidence: str
    conceptTags: list[str] = Field(default_factory=list)


class ProviderResponse(BaseModel):
    candidates: list[ProviderCandidate]


Detector = Callable[[str], str]
"""Takes a prompt, returns the model's raw JSON text."""


def build_prompt(seed: dict, window: dict, cues: list[Cue]) -> str:
    lines = "\n".join(f"[{c.id}] ({c.start_s:.2f}-{c.end_s:.2f}) {c.text}" for c in cues)
    return (
        "You find coding exercises in a programming tutorial transcript.\n"
        f"Course: {seed.get('title', '')} ({seed.get('channel', '')}). "
        f"Chapter hint: {window.get('label', window.get('id', ''))}.\n"
        "Return a candidate only when the instructor poses a self-contained task a "
        "learner could attempt before the solution is shown. If the excerpt is only a "
        "demonstration without a separable task, return zero candidates.\n"
        "For each candidate give: title, task (plain text), inputs, expectedOutput, a "
        "Python functionName, setupEndCueId (the cue where the task is fully set up), "
        "spokenRevealCueId (the earliest cue where the instructor starts giving the "
        "solution; hints are not reveals), language (one of "
        f"{', '.join(LANGUAGES)}) with languageEvidence from actual code syntax and "
        f"course context, and conceptTags from: {', '.join(CONCEPT_TAGS)}.\n"
        "Cue ids MUST be copied exactly from the brackets below.\n\n"
        f"{lines}\n"
    )


def gemini_detector() -> Detector:
    """Real detector using the Google Gen AI SDK. Key read from env only."""
    try:
        from dotenv import load_dotenv

        load_dotenv(BACKEND_DIR / ".env")
    except ImportError:  # pragma: no cover
        pass
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise PrepError("PREP_PROVIDER_ERROR", "GEMINI_API_KEY is not set in backend/.env")
    model = os.environ.get("GEMINI_MODEL") or "gemini-flash-latest"

    def detect(prompt: str) -> str:
        try:
            from google import genai
            from google.genai import types

            client = genai.Client(api_key=api_key)
            resp = client.models.generate_content(
                model=model,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=ProviderResponse,
                    temperature=0,
                ),
            )
            text = resp.text
        except PrepError:
            raise
        except Exception as exc:  # provider/network/SDK failure
            raise PrepError("PREP_PROVIDER_ERROR", f"Gemini call failed: {type(exc).__name__}") from exc
        if not text:
            raise PrepError("PREP_PROVIDER_ERROR", "Gemini returned an empty response")
        return text

    return detect


def parse_provider_response(text: str) -> ProviderResponse:
    try:
        return ProviderResponse.model_validate_json(text)
    except ValidationError as exc:
        raise PrepError("INVALID_DRAFT", f"model output failed schema validation: {exc.error_count()} error(s)") from exc


def assess_candidate(c: ProviderCandidate, cues: list[Cue], window: dict) -> dict:
    """Turn a provider candidate into a draft entry with status and reasons."""
    by_id = {cue.id: cue for cue in cues}
    reasons: list[str] = []
    setup = by_id.get(c.setupEndCueId)
    reveal = by_id.get(c.spokenRevealCueId)
    if setup is None:
        reasons.append(f"setupEndCueId {c.setupEndCueId!r} is not in the supplied excerpt")
    if reveal is None:
        reasons.append(f"spokenRevealCueId {c.spokenRevealCueId!r} is not in the supplied excerpt")
    if setup and reveal and setup.end_s >= reveal.start_s:
        reasons.append("setup overlaps the spoken reveal")

    language = c.language.strip().lower()
    if language not in LANGUAGES:
        language = "unknown"
    if language not in PUBLISHABLE_LANGUAGES:
        reasons.append(f"language {language!r} is not publishable in this release")

    tags = [t for t in c.conceptTags if t in CONCEPT_TAGS]
    dropped = [t for t in c.conceptTags if t not in CONCEPT_TAGS]

    if language not in PUBLISHABLE_LANGUAGES:
        status = "unsupported"
    elif reasons:
        status = "held"
    else:
        status = "candidate"

    return {
        "status": status,
        "reasons": reasons,
        "windowId": window.get("id"),
        "title": c.title,
        "task": c.task,
        "inputs": c.inputs,
        "expectedOutput": c.expectedOutput,
        "functionName": c.functionName,
        "language": language,
        "languageEvidence": c.languageEvidence,
        "conceptTags": tags,
        "internalTags": [t for t in tags if t in INTERNAL_TAGS],
        "droppedTags": dropped,
        "setupEndCueId": c.setupEndCueId,
        "spokenRevealCueId": c.spokenRevealCueId,
        "setupEndS": setup.end_s if setup else None,
        "firstSpokenRevealS": reveal.start_s if reveal else None,
        "reviewClip": None,
    }


def _overlaps(a: dict, b: dict) -> bool:
    if None in (a["setupEndS"], a["firstSpokenRevealS"], b["setupEndS"], b["firstSpokenRevealS"]):
        return False
    return a["setupEndS"] <= b["firstSpokenRevealS"] and b["setupEndS"] <= a["firstSpokenRevealS"]


def dedupe(candidates: list[dict]) -> list[dict]:
    """Drop candidates from overlapping chunks that cover the same setup/reveal span."""
    kept: list[dict] = []
    for cand in candidates:
        if any(_overlaps(cand, k) and k["status"] == cand["status"] for k in kept):
            continue
        kept.append(cand)
    return kept


def scan(
    video_id: str,
    detector: Detector | None = None,
    *,
    seeds_path: Path = SEEDS_PATH,
    content_dir: Path = CONTENT_DIR,
    drafts_dir: Path = DRAFTS_DIR,
) -> Path:
    seed = load_seed(video_id, seeds_path)
    cues = load_transcript(seed, content_dir)
    windows = seed.get("scanWindows") or [
        {"id": "full", "startS": cues[0].start_s, "endS": cues[-1].end_s}
    ]
    detect = detector or gemini_detector()

    found: list[dict] = []
    for window in windows:
        ws, we = window.get("startS"), window.get("endS")
        if not (_finite_number(ws) and _finite_number(we) and ws < we):
            raise PrepError("INVALID_SEEDS", f"window {window.get('id')} has invalid bounds")
        for cs, ce in window_chunks(float(ws), float(we)):
            chunk = cues_in(cues, cs, ce)
            if not chunk:
                raise PrepError("TRANSCRIPT_UNAVAILABLE", f"no cues cover {cs:.0f}-{ce:.0f} s")
            response = parse_provider_response(detect(build_prompt(seed, window, chunk)))
            for cand in response.candidates:
                entry = assess_candidate(cand, chunk, window)
                if entry["setupEndS"] is not None:
                    clip_start = max(float(ws), entry["setupEndS"] - 30.0)
                    clip_end = min(float(we), (entry["firstSpokenRevealS"] or entry["setupEndS"]) + 30.0)
                    entry["reviewClip"] = {
                        "url": seed.get("url") or f"https://www.youtube.com/watch?v={video_id}",
                        "startS": clip_start,
                        "endS": clip_end,
                    }
                entry["windowStartS"] = float(ws)
                entry["windowEndS"] = float(we)
                found.append(entry)

    candidates = dedupe(found)
    draft = {
        "schemaVersion": 1,
        "videoId": video_id,
        "kind": "scan",
        "note": "Generated draft. Review timing in the original video, then write content/reviewed/{videoId}.json.",
        "candidates": candidates,
    }
    drafts_dir.mkdir(parents=True, exist_ok=True)
    out = drafts_dir / f"{video_id}.scan.json"
    _atomic_write(out, draft)

    usable = [c for c in candidates if c["status"] == "candidate"]
    if not usable:
        raise PrepError(
            "NO_USABLE_CANDIDATE",
            f"{len(candidates)} candidate(s), none usable; see {out.name} for reasons",
        )
    return out


# ---------------------------------------------------------------------------
# Timing
# ---------------------------------------------------------------------------


def normalize_video_time(t: Any, basis: str, clip_start_s: float = 0.0) -> float:
    """Convert a Gemini timestamp to the full YouTube timeline exactly once.

    ``basis`` must be stated: ``"video"`` (already absolute) or ``"clip"``
    (relative to ``clip_start_s``).
    """
    if not _finite_number(t):
        raise PrepError("INVALID_TIMING", f"nonfinite timestamp {t!r}")
    if basis == "video":
        return float(t)
    if basis == "clip":
        if not _finite_number(clip_start_s):
            raise PrepError("INVALID_TIMING", "clip start is missing")
        return float(clip_start_s) + float(t)
    raise PrepError("INVALID_TIMING", f"unknown timestamp basis {basis!r}")


def compute_timing(
    window_start_s: Any,
    window_end_s: Any,
    setup_end_s: Any,
    first_spoken_reveal_s: Any,
    first_visual_reveal_s: Any,
) -> dict[str, float]:
    """Return revealAtS/pauseAtS for reviewed times, or raise INVALID_TIMING.

    reveal = earliest non-null reveal channel. Prefer pause = reveal - 2.0;
    require windowStart <= setupEnd <= pause <= reveal - 1.0 and reveal <= windowEnd.
    """
    for name, v in (
        ("windowStartS", window_start_s),
        ("windowEndS", window_end_s),
        ("setupEndS", setup_end_s),
    ):
        if not _finite_number(v):
            raise PrepError("INVALID_TIMING", f"{name} is missing or nonfinite")
    reveals = []
    for name, v in (("firstSpokenRevealS", first_spoken_reveal_s), ("firstVisualRevealS", first_visual_reveal_s)):
        if v is None:
            continue
        if not _finite_number(v):
            raise PrepError("INVALID_TIMING", f"{name} is nonfinite")
        reveals.append(float(v))
    if not reveals:
        raise PrepError("INVALID_TIMING", "no reveal time recorded")

    reveal = min(reveals)
    setup = float(setup_end_s)
    if setup >= reveal:
        raise PrepError("INVALID_TIMING", "setup overlaps the reveal")
    pause = round(reveal - PREFERRED_LEAD_S, 3)
    if pause < setup:
        pause = setup  # still safe if at least MIN_LEAD_S before the reveal
    if not (window_start_s <= setup <= pause <= reveal - MIN_LEAD_S):
        raise PrepError("INVALID_TIMING", "no safe pause window between setup and reveal")
    if reveal > window_end_s:
        raise PrepError("INVALID_TIMING", "reveal is after the window end")
    return {"revealAtS": reveal, "pauseAtS": pause}


# ---------------------------------------------------------------------------
# Verify and publish
# ---------------------------------------------------------------------------


def _strip_review_fields(reviewed: dict) -> dict:
    record = {k: v for k, v in reviewed.items() if k not in REVIEW_ONLY_KEYS}
    record["breakpoints"] = [
        {k: v for k, v in bp.items() if k not in REVIEW_ONLY_BREAKPOINT_KEYS}
        for bp in reviewed.get("breakpoints", [])
    ]
    return record


def compute_digest(record: dict) -> str:
    """Digest of the record content (excluding revision/digest), canonical JSON."""
    body = {k: v for k, v in record.items() if k not in ("revision", "approvedDigest")}
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _run_solution(code: str, function_name: str, args: list) -> tuple[bool, Any]:
    """Run trusted reviewed code locally in an isolated interpreter."""
    source = _build_wrapper(code, function_name, args)
    try:
        proc = subprocess.run(
            [sys.executable, "-I", "-c", source],
            capture_output=True,
            text=True,
            timeout=SOLUTION_TIMEOUT_S,
            cwd=tempfile.gettempdir(),
        )
    except subprocess.TimeoutExpired:
        return False, None
    lines = [l for l in proc.stdout.splitlines() if l.strip()]
    if proc.returncode != 0 or not lines:
        return False, None
    try:
        parsed = json.loads(lines[-1])
    except json.JSONDecodeError:
        return False, None
    if not isinstance(parsed, dict) or not parsed.get("ok"):
        return False, None
    return True, parsed.get("value")


def _case_passes(code: str, function_name: str, args: list, expected: Any) -> bool:
    ok, actual = _run_solution(code, function_name, args)
    return ok and actual == expected and type(actual) is type(expected)


def build_verified_record(reviewed: dict, video_id: str) -> tuple[dict, ApprovedRecord]:
    """Validate a reviewed file and return the approved-shape dict and model.

    Raises INVALID_DRAFT / INVALID_TIMING / VERIFY_FAILED.
    """
    if reviewed.get("videoId") != video_id:
        raise PrepError("INVALID_DRAFT", f"reviewed videoId {reviewed.get('videoId')!r} != {video_id}")
    record = _strip_review_fields(reviewed)
    if not record["breakpoints"]:
        raise PrepError("INVALID_DRAFT", "reviewed file has no breakpoints")

    prev_reveal = -math.inf
    exercise_ids: set[str] = set()
    for bp in sorted(record["breakpoints"], key=lambda b: b.get("pauseAtS") or 0):
        bid = bp.get("id")
        timing = compute_timing(
            bp.get("windowStartS"),
            bp.get("windowEndS"),
            bp.get("setupEndS"),
            bp.get("firstSpokenRevealS"),
            bp.get("firstVisualRevealS"),
        )
        for key, value in timing.items():
            if key in bp and not (_finite_number(bp[key]) and abs(bp[key] - value) < 1e-6):
                raise PrepError("INVALID_TIMING", f"breakpoint {bid}: {key} {bp[key]!r} != computed {value}")
            bp.setdefault(key, value)
        if timing["pauseAtS"] <= prev_reveal:
            raise PrepError("INVALID_TIMING", f"breakpoint {bid} overlaps the previous breakpoint")
        prev_reveal = timing["revealAtS"]

        ex = bp.get("exercise") or {}
        if ex.get("id") in exercise_ids:
            raise PrepError("INVALID_DRAFT", f"duplicate exercise id {ex.get('id')!r}")
        exercise_ids.add(ex.get("id"))
        if not 1 <= len(ex.get("examples") or []) <= 2:
            raise PrepError("INVALID_DRAFT", f"breakpoint {bid}: use one or two visible examples")
        if len(ex.get("hiddenTests") or []) < 3:
            raise PrepError("INVALID_DRAFT", f"breakpoint {bid}: at least three hidden tests required")
        bad_tags = [t for t in ex.get("conceptTags") or [] if t not in CONCEPT_TAGS]
        if bad_tags:
            raise PrepError("INVALID_DRAFT", f"breakpoint {bid}: unknown concept tags {bad_tags}")

    record["breakpoints"].sort(key=lambda b: b["pauseAtS"])
    record.setdefault("schemaVersion", 1)
    digest = compute_digest(record)
    full = {**record, "revision": f"{video_id}-{digest}", "approvedDigest": digest}
    try:
        model = ApprovedRecord.model_validate(full)
        build_public_response(model)
    except ValidationError as exc:
        first = exc.errors()[0]
        loc = ".".join(str(p) for p in first["loc"])
        raise PrepError("INVALID_DRAFT", f"field {loc}: {first['msg']}") from exc

    for bp in model.breakpoints:
        ex = bp.exercise
        fn = ex.functionName
        if not fn.isidentifier():
            raise PrepError("INVALID_DRAFT", f"{ex.id}: functionName is not an identifier")
        for label, code in (("starterCode", ex.starterCode), ("referenceSolution", ex.referenceSolution),
                            ("knownWrongSolution", ex.knownWrongSolution)):
            try:
                compile(code, label, "exec")
            except SyntaxError as exc:
                raise PrepError("INVALID_DRAFT", f"{ex.id}: {label} does not compile") from exc
            if f"def {fn}(" not in code:
                raise PrepError("INVALID_DRAFT", f"{ex.id}: {label} does not define {fn}")
        cases = [*ex.examples, *ex.hiddenTests]
        failing = [i for i, c in enumerate(cases) if not _case_passes(ex.referenceSolution, fn, c.args, c.expected)]
        if failing:
            raise PrepError("VERIFY_FAILED", f"{ex.id}: reference solution fails case(s) {failing}")
        if all(_case_passes(ex.knownWrongSolution, fn, c.args, c.expected) for c in cases):
            raise PrepError("VERIFY_FAILED", f"{ex.id}: known-wrong solution passes every case; add tests")
    return full, model


def _load_reviewed(video_id: str, reviewed_dir: Path) -> dict:
    data = _read_json(reviewed_dir / f"{video_id}.json", "INVALID_DRAFT", "INVALID_DRAFT")
    if not isinstance(data, dict):
        raise PrepError("INVALID_DRAFT", "reviewed file is not an object")
    return data


def verify(
    video_id: str,
    *,
    reviewed_dir: Path = REVIEWED_DIR,
    drafts_dir: Path = DRAFTS_DIR,
) -> Path:
    if not VIDEO_ID_RE.match(video_id):
        raise PrepError("INVALID_VIDEO_ID", f"malformed video id {video_id!r}")
    full, model = build_verified_record(_load_reviewed(video_id, reviewed_dir), video_id)
    stamp = {
        "videoId": video_id,
        "approvedDigest": full["approvedDigest"],
        "breakpoints": len(model.breakpoints),
        "cases": sum(len(b.exercise.examples) + len(b.exercise.hiddenTests) for b in model.breakpoints),
    }
    drafts_dir.mkdir(parents=True, exist_ok=True)
    out = drafts_dir / f"{video_id}.verified.json"
    _atomic_write(out, stamp)
    return out


def publish(
    video_id: str,
    *,
    reviewed_dir: Path = REVIEWED_DIR,
    drafts_dir: Path = DRAFTS_DIR,
    approved_dir: Path = APPROVED_DIR,
) -> Path:
    if not VIDEO_ID_RE.match(video_id):
        raise PrepError("INVALID_VIDEO_ID", f"malformed video id {video_id!r}")
    stamp = _read_json(drafts_dir / f"{video_id}.verified.json", "NOT_VERIFIED", "NOT_VERIFIED")
    full, _ = build_verified_record(_load_reviewed(video_id, reviewed_dir), video_id)
    if stamp.get("approvedDigest") != full["approvedDigest"]:
        raise PrepError("NOT_VERIFIED", "reviewed file changed since verify; run verify again")
    approved_dir.mkdir(parents=True, exist_ok=True)
    out = approved_dir / f"{video_id}.json"
    _atomic_write(out, full)
    return out


def _atomic_write(path: Path, data: Any) -> None:
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.prepare", description=__doc__.split("\n\n")[0])
    parser.add_argument("command", choices=("scan", "verify", "publish"))
    parser.add_argument("--video-id", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "scan":
            out = scan(args.video_id)
        elif args.command == "verify":
            out = verify(args.video_id)
        else:
            out = publish(args.video_id)
    except PrepError as exc:
        print(f"{exc.code}: {exc.message}", file=sys.stderr)
        return 1
    print(f"{args.command} ok: {out.relative_to(BACKEND_DIR) if out.is_relative_to(BACKEND_DIR) else out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
