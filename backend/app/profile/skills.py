"""In-demand skills (swappable source), the stored refresher-question bank and generated refreshers."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import logging
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from .engine import CONCEPTS, REFRESHER_THRESHOLD, Replay, level_rank

SKILLS_DIR = Path(__file__).resolve().parents[2] / "content" / "skills"

# ---------------------------------------------------------------------------
# In-demand skills. The source is any callable returning the in-demand.json shape, so a job-post feed
# or news digest can replace the hand-picked file without touching the endpoints.
# ---------------------------------------------------------------------------


def file_source(path: Path | str | None = None) -> Callable[[], dict]:
    def load() -> dict:
        p = Path(path or os.environ.get("BREAKPOINT_IN_DEMAND_FILE") or SKILLS_DIR / "in-demand.json")
        return json.loads(p.read_text(encoding="utf-8"))

    return load


_source: Callable[[], dict] = file_source()


def set_source(source: Callable[[], dict]) -> None:
    global _source
    _source = source


def in_demand_list() -> dict:
    data = _source()
    sources = {s["id"]: s for s in data.get("sources", [])}
    skills = []
    for s in data.get("skills", []):
        if s.get("concept") not in CONCEPTS or not s.get("videoUrl"):
            continue
        skills.append({
            "concept": s["concept"], "name": CONCEPTS[s["concept"]]["name"], "reason": s["reason"],
            "videoUrl": s["videoUrl"], "videoTitle": s.get("videoTitle"),
            "sources": [sources[i] for i in s.get("sourceIds", []) if i in sources],
        })
    return {"asOf": data.get("asOf"), "method": data.get("method"), "skills": skills}


def in_demand_fields(rep: Replay | None) -> dict:
    """Hiring fields from the dated Adzuna snapshot (pull_in_demand.py), with the learner's Breakpoint level
    for each skill chip: the best level across the chip's concepts they have practiced, None when they have
    not started, and `tracked: false` for tools Breakpoint does not teach (ArcGIS, Power BI...)."""
    data = _source()
    fields = []
    for f in data.get("fields", []):
        chips = []
        for s in f.get("skills", []):
            concepts = [c for c in s.get("concepts", []) if c in CONCEPTS]
            practiced = [rep.concepts[c] for c in concepts
                         if rep and c in rep.concepts and (rep.concepts[c].active or rep.concepts[c].xp > 0)]
            best = max(practiced, key=lambda st: (st.level["rank"], st.xp), default=None)
            chips.append({
                "name": s["name"], "share": s.get("share"), "mentions": s.get("mentions"), "tracked": bool(concepts),
                "level": ({"level": best.level["id"], "levelName": best.level["name"], "rank": best.level["rank"],
                           "concept": best.concept} if best else None),
            })
        fields.append({**{k: f[k] for k in ("id", "name", "summary", "rising", "wefSkill", "postings") if k in f},
                       "skills": chips, "alsoAskedFor": f.get("alsoAskedFor", []), "tutorials": f.get("tutorials", [])})
    sources = [s for s in data.get("sources", []) if s.get("id") in ("adzuna", "wef-foj-2025")]
    return {"pulledAt": data.get("fieldsPulledAt"), "method": data.get("fieldsMethod"), "sources": sources,
            "fields": fields}


def top_in_demand(rep: Replay | None, limit: int = 3) -> list[dict]:
    """Top N in-demand skills, skipping ones the learner is already Advanced+ in."""
    out = []
    for s in in_demand_list()["skills"]:
        st = rep.concepts.get(s["concept"]) if rep else None
        if st and st.level["rank"] >= 11:
            continue
        out.append({"concept": s["concept"], "reason": s["reason"], "videoUrl": s["videoUrl"]})
        if len(out) == limit:
            break
    return out


# ---------------------------------------------------------------------------
# Refresher bank
# ---------------------------------------------------------------------------

_bank: dict[str, dict] | None = None


def _load_bank() -> dict[str, dict]:
    global _bank
    if _bank is None:
        raw = json.loads((SKILLS_DIR / "refreshers.json").read_text(encoding="utf-8"))
        _bank = {q["id"]: q for q in raw["questions"] if q["concept"] in CONCEPTS}
    return _bank


def _revision(q: dict) -> str:
    digest = hashlib.sha256(json.dumps(q, sort_keys=True).encode()).hexdigest()[:12]
    return f"{q['id']}-{digest}"


def public_question(q: dict) -> dict:
    """Same shape as a plan `question` (contracts/v2 §1); never includes the answer."""
    return {
        "id": q["id"], "revision": _revision(q), "title": q["title"], "style": "multiple_choice",
        "prompt": q["prompt"], "choices": q["choices"], "concepts": [q["concept"]], "level": q["level"],
        "aiGenerated": bool(q.get("aiGenerated")),
    }


def _store():
    from . import get_store  # lazy: the package imports this module

    return get_store()


def lookup_refresher(question_id: str) -> dict | None:
    """Private lookup for lane A2's /v2/answer: question (public shape) + answer + explanation.
    Covers the stored bank and questions generated by lane A2 (ids `rf-gen-…`, kept in the profile DB)."""
    q = _load_bank().get(question_id)
    if not q and isinstance(question_id, str) and question_id.startswith(GENERATED_PREFIX):
        q = _store().get_generated(question_id)
    if not q:
        return None
    return {"question": public_question(q), "answer": q["answer"], "explanation": q["explanation"]}


# ---------------------------------------------------------------------------
# Generated refreshers. Lane A2 supplies the generator; B1 validates, caches and serves its output and
# falls back to the stored bank whenever generation is off, missing, slow or invalid.
#
# Generator: (concept_id, concept_name, level_id, avoid_prompts) -> dict | None (sync or async), where the
# dict is {title, prompt, choices: [{id, text}] | [text], answer: choice id or exact choice text, explanation}.
# Default: app.feedback.refresher.generate_refresher when that module exists. BREAKPOINT_REFRESHER_GENERATE=0
# turns generation off.
# ---------------------------------------------------------------------------

GENERATED_PREFIX = "rf-gen-"
GENERATE_TIMEOUT_S = 15.0
MAX_GENERATED_PER_LEVEL = 5  # per (concept, level), shared by every local account: bounds model spend
RETRY_AFTER_FAILURE_S = 600.0

RefresherGenerator = Callable[[str, str, str, list[str]], Any]

_UNSET: Any = object()
_generator: Any = _UNSET
_locks: dict[tuple[str, str], asyncio.Lock] = {}
_failed_at: dict[tuple[str, str], float] = {}
log = logging.getLogger(__name__)


def set_generator(generator: RefresherGenerator | None) -> None:
    """Tests/demos replace lane A2's generator; None turns generation off."""
    global _generator
    _generator = generator
    _failed_at.clear()


def _default_generator() -> RefresherGenerator | None:
    if os.environ.get("BREAKPOINT_REFRESHER_GENERATE", "1").strip().lower() in {"0", "false", "off", "no"}:
        return None
    try:
        from ..feedback.refresher import generate_refresher  # lane A2
    except Exception:  # module not merged yet, or its dependencies are missing
        return None
    return generate_refresher


def get_generator() -> RefresherGenerator | None:
    return _default_generator() if _generator is _UNSET else _generator


def _text(value: Any, low: int, high: int) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if low <= len(value) <= high else None


def validate_generated(raw: Any, concept: str, level: str) -> dict | None:
    """Normalise generator output into a stored multiple-choice refresher, or None if it is unusable."""
    if not isinstance(raw, dict):
        return None
    title, prompt = _text(raw.get("title"), 1, 100), _text(raw.get("prompt"), 10, 800)
    explanation = _text(raw.get("explanation"), 1, 800)
    choices_raw = raw.get("choices")
    if not (title and prompt and explanation and isinstance(choices_raw, list) and 2 <= len(choices_raw) <= 6):
        return None
    choices = []
    for i, c in enumerate(choices_raw):
        text = _text(c.get("text") if isinstance(c, dict) else c, 1, 300)
        cid = (c.get("id") if isinstance(c, dict) else None) or "abcdef"[i]
        if not text or not isinstance(cid, str) or not cid.strip():
            return None
        choices.append({"id": cid.strip(), "text": text})
    ids, texts = [c["id"] for c in choices], [c["text"].casefold() for c in choices]
    if len(set(ids)) != len(ids) or len(set(texts)) != len(texts):
        return None
    answer = raw.get("answer")
    if isinstance(answer, str) and answer.strip() not in ids:
        answer = next((c["id"] for c in choices if c["text"].casefold() == answer.strip().casefold()), None)
    if not isinstance(answer, str) or answer.strip() not in ids:
        return None
    digest = hashlib.sha256(json.dumps([concept, level, prompt, choices], sort_keys=True).encode()).hexdigest()[:12]
    return {
        "id": f"{GENERATED_PREFIX}{concept}-{digest}", "concept": concept, "level": level, "title": title,
        "prompt": prompt, "choices": choices, "answer": answer.strip(), "explanation": explanation,
        "aiGenerated": True,
    }


async def _call_generator(gen: RefresherGenerator, concept: str, level: str, avoid: list[str]) -> Any:
    name = CONCEPTS[concept]["name"]
    if inspect.iscoroutinefunction(gen):
        return await asyncio.wait_for(gen(concept, name, level, avoid), GENERATE_TIMEOUT_S)
    result = await asyncio.wait_for(asyncio.to_thread(gen, concept, name, level, avoid), GENERATE_TIMEOUT_S)
    return await asyncio.wait_for(result, GENERATE_TIMEOUT_S) if inspect.isawaitable(result) else result


async def _generated_refresher(store, concept: str, level: str, answered: set[str]) -> dict | None:
    """An unanswered cached generated question, else a newly generated one (bounded), else None."""
    key = (concept, level)
    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:  # concurrent requests reuse one generation instead of paying twice
        cached = store.generated_for(concept, level)
        unanswered = [q for q in cached if q["id"] not in answered]
        if unanswered:
            return unanswered[0]
        gen = get_generator()
        if gen is None or len(cached) >= MAX_GENERATED_PER_LEVEL:
            return None
        if time.monotonic() - _failed_at.get(key, float("-inf")) < RETRY_AFTER_FAILURE_S:
            return None
        try:
            raw = await _call_generator(gen, concept, level, [q["prompt"] for q in cached])
        except Exception as exc:  # timeout, provider error, missing key: the stored bank still works
            log.warning("refresher generation failed for %s/%s: %s", concept, level, type(exc).__name__)
            raw = None
        q = validate_generated(raw, concept, level)
        if q is None or q["id"] in {c["id"] for c in cached}:
            _failed_at[key] = time.monotonic()
            return None
        store.add_generated(q)
        return q


def _stored_refresher(cid: str, st) -> dict | None:
    candidates = [q for q in _load_bank().values() if q["concept"] == cid
                  and (level_rank(q["level"]) or 1) <= st.level["rank"]]
    if not candidates:
        return None
    fresh = [q for q in candidates if q["id"] not in st.answered_questions] or candidates
    fresh.sort(key=lambda q: (-(level_rank(q["level"]) or 1), q["id"]))
    return fresh[st.refreshers % len(fresh)] if fresh is candidates else fresh[0]


async def pick_refresher(rep: Replay, now: datetime, store=None) -> dict | None:
    """One refresher for the weakest due concept: a question generated by lane A2 at the learner's level
    when available, otherwise a stored one. None when nothing is due."""
    store = store or _store()
    due = sorted(
        (st.strength(now), cid) for cid, st in rep.concepts.items()
        if st.active and st.strength(now) < REFRESHER_THRESHOLD
    )
    for strength, cid in due:
        st = rep.concepts[cid]
        q = await _generated_refresher(store, cid, st.level["id"], st.answered_questions)
        q = q or _stored_refresher(cid, st)
        if q is None:
            continue
        return {
            "concept": cid, "conceptName": CONCEPTS[cid]["name"], "strength": strength,
            "reason": f"strength below {REFRESHER_THRESHOLD}", "question": public_question(q),
        }
    return None
