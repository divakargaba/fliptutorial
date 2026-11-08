"""In-demand skills (swappable source) and the stored refresher-question bank."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Callable

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
        "aiGenerated": False,
    }


def lookup_refresher(question_id: str) -> dict | None:
    """Private lookup for lane A2's /v2/answer: question (public shape) + answer + explanation."""
    q = _load_bank().get(question_id)
    if not q:
        return None
    return {"question": public_question(q), "answer": q["answer"], "explanation": q["explanation"]}


def pick_refresher(rep: Replay, now: datetime) -> dict | None:
    """One refresher for the weakest due concept that has a stored question, or None."""
    bank = _load_bank()
    due = sorted(
        (st.strength(now), cid) for cid, st in rep.concepts.items()
        if st.active and st.strength(now) < REFRESHER_THRESHOLD
    )
    for strength, cid in due:
        st = rep.concepts[cid]
        candidates = [q for q in bank.values() if q["concept"] == cid
                      and (level_rank(q["level"]) or 1) <= st.level["rank"]]
        if not candidates:
            continue
        fresh = [q for q in candidates if q["id"] not in st.answered_questions] or candidates
        fresh.sort(key=lambda q: (-(level_rank(q["level"]) or 1), q["id"]))
        q = fresh[st.refreshers % len(fresh)] if fresh is candidates else fresh[0]
        return {
            "concept": cid, "conceptName": CONCEPTS[cid]["name"], "strength": strength,
            "reason": f"strength below {REFRESHER_THRESHOLD}", "question": public_question(q),
        }
    return None
