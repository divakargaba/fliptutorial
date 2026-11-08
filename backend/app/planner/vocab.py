"""Shared v2 vocabularies (contracts/v2/levels.json, concepts.json) and plan constants."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

CONTRACTS_V2 = Path(__file__).resolve().parents[3] / "contracts" / "v2"

LANGUAGES = (
    "python", "javascript", "typescript", "java", "cpp", "c", "csharp", "go", "rust", "sql", "pseudocode", "unknown",
)
FORMATS = ("code", "theory", "mixed", "off_topic")
QUESTION_STYLES = ("multiple_choice", "short_answer", "predict_output")
DEFAULT_LEVEL = "beginner-1"

# Languages whose coding exercises can be verified in Judge0 today (reference passes,
# known-wrong fails). Other languages get concept questions until lane A2's runners land.
CODING_LANGUAGES = ("python",)


@lru_cache(maxsize=1)
def _levels() -> dict[str, dict]:
    data = json.loads((CONTRACTS_V2 / "levels.json").read_text(encoding="utf-8"))
    return {lv["id"]: lv for lv in data["levels"]}


@lru_cache(maxsize=1)
def concept_ids() -> tuple[str, ...]:
    data = json.loads((CONTRACTS_V2 / "concepts.json").read_text(encoding="utf-8"))
    return tuple(c["id"] for c in data["concepts"])


def is_level(level: str) -> bool:
    return level in _levels()


def tier_of(level: str) -> str:
    """beginner | intermediate | advanced | expert (unknown levels count as beginner)."""
    return _levels().get(level, {}).get("tier", "beginner")


def tier_floor_level(tier: str) -> str:
    """Lowest level id in a tier: the level stamped on exercises generated for that tier."""
    for lv in sorted(_levels().values(), key=lambda v: v["rank"]):
        if lv["tier"] == tier:
            return lv["id"]
    return DEFAULT_LEVEL


TIER_GUIDANCE = {
    "beginner": "The learner is a beginner: one small step, plain wording, no tricky edge cases beyond the obvious.",
    "intermediate": "The learner is intermediate: combine the idea with one earlier concept and include a meaningful edge case; an efficient solution should be possible.",
    "advanced": "The learner is advanced: require careful edge cases and an efficient solution; avoid hand-holding in the wording.",
    "expert": "The learner is an expert: make it a compact but demanding variation that tests deep understanding of the idea.",
}
