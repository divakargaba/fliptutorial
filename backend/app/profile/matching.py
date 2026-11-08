"""Complementary matching: suggest public accounts strong where you are weak (and vice versa).

Scores complementarity across all concept groups, not only frontend/backend.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from .engine import Replay

CONCEPTS_PATH = Path(__file__).resolve().parents[3] / "contracts" / "v2" / "concepts.json"

# Plain-language names for the groups, used in the "why" sentence.
GROUP_LABELS: dict[str, str] = {
    "fundamentals": "fundamentals", "control-flow": "control flow", "data-structures": "data structures",
    "algorithms": "algorithms", "theory": "complexity analysis", "paradigms": "OOP & functional design",
    "databases": "databases", "web-frontend": "frontend", "web-backend": "backend APIs", "tools": "tooling",
}


@lru_cache(maxsize=1)
def _names() -> dict[str, str]:
    try:
        return {c["id"]: c["name"] for c in json.loads(CONCEPTS_PATH.read_text(encoding="utf-8"))["concepts"]}
    except (OSError, ValueError, KeyError):
        return {}


def _name(concept: str) -> str:
    return _names().get(concept, concept.replace("-", " "))


def _join(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]

STRONG_RANK = 6  # Intermediate I and up
TOP_N = 3  # only the strongest few complements count, so breadth alone does not win

# Concept groups from contracts/v2/concepts.json. Concepts in the same group
# cluster together; complementary PAIRS connect groups whose strengths cover
# each other (e.g. a strong frontend developer and a strong backend developer).
GROUPS: dict[str, set[str]] = {
    "fundamentals": {"variables", "types", "operators", "strings", "io"},
    "control-flow": {"conditionals", "loops", "functions", "recursion", "errors"},
    "data-structures": {"lists", "dicts", "sets", "stacks-queues", "linked-lists", "trees", "graphs", "heaps"},
    "algorithms": {"sorting", "searching", "two-pointers", "dynamic-programming", "greedy"},
    "theory": {"complexity"},
    "paradigms": {"oop", "functional"},
    "databases": {"sql-select", "sql-joins"},
    "web-frontend": {"js-dom", "js-async", "react-components", "react-state"},
    "web-backend": {"http-apis"},
    "tools": {"git", "testing"},
}

# Complementary group pairs: strong in one and weak in the other earns a bonus.
COMPLEMENTARY_PAIRS: list[tuple[str, str, float]] = [
    ("web-frontend", "web-backend", 25.0),
    ("web-frontend", "databases", 15.0),
    ("web-backend", "databases", 10.0),
    ("data-structures", "algorithms", 12.0),
    ("fundamentals", "paradigms", 8.0),
    ("control-flow", "data-structures", 8.0),
    ("algorithms", "databases", 10.0),
    ("paradigms", "web-frontend", 8.0),
    ("tools", "web-frontend", 5.0),
    ("tools", "web-backend", 5.0),
]


def _concept_to_group(concept: str) -> str | None:
    for group, members in GROUPS.items():
        if concept in members:
            return group
    return None


def _ranks(rep: Replay) -> dict[str, int]:
    return {cid: st.level["rank"] for cid, st in rep.concepts.items()}


def _strong(ranks: dict[str, int]) -> set[str]:
    return {c for c, r in ranks.items() if r >= STRONG_RANK}


def _strong_groups(strong_concepts: set[str]) -> set[str]:
    groups: set[str] = set()
    for concept in strong_concepts:
        group = _concept_to_group(concept)
        if group:
            groups.add(group)
    return groups


def _tier_word(rank: int) -> str:
    return "Expert" if rank >= 16 else "Advanced" if rank >= 11 else "Intermediate"


def match(me: dict, my_rep: Replay, others: list[tuple[dict, Replay]], limit: int = 3) -> list[dict]:
    """`me`/`others` are account dicts ({accountId, displayName, public}); only public others are suggested."""
    mine = _ranks(my_rep)
    my_strong = _strong(mine)
    my_groups = _strong_groups(my_strong)
    first = me["displayName"].split(" ")[0]
    results = []
    for acct, rep in others:
        if acct["accountId"] == me["accountId"] or not acct["public"]:
            continue
        theirs = _ranks(rep)
        their_strong = _strong(theirs)
        their_groups = _strong_groups(their_strong)
        gives = sorted((c for c in their_strong if mine.get(c, 1) < STRONG_RANK), key=lambda c: (-theirs[c], c))
        if not gives:
            continue
        gets = sorted((c for c in my_strong if theirs.get(c, 1) < STRONG_RANK), key=lambda c: (-mine[c], c))
        score = sum(theirs[c] - mine.get(c, 1) for c in gives[:TOP_N])
        score += 0.5 * sum(mine[c] - theirs.get(c, 1) for c in gets[:TOP_N])
        # Apply bonuses for complementary group pairs.
        for group_a, group_b, bonus in COMPLEMENTARY_PAIRS:
            if (my_groups & {group_a} and their_groups & {group_b}) or \
               (my_groups & {group_b} and their_groups & {group_a}):
                score += bonus
        full_stack = bool(
            (my_groups & {"web-frontend"} and their_groups & {"web-backend"}) or
            (my_groups & {"web-backend"} and their_groups & {"web-frontend"})
        )
        shown = gives[:2]
        why = (f"{_tier_word(min(theirs[c] for c in shown))} in {_join([_name(c) for c in shown])}, "
               f"where {first} is a beginner")
        pair = None
        for group_a, group_b, _ in COMPLEMENTARY_PAIRS:
            if my_groups & {group_a} and their_groups & {group_b}:
                pair = (group_a, group_b)
                break
            if my_groups & {group_b} and their_groups & {group_a}:
                pair = (group_b, group_a)
                break
        if gets:
            why += f". {first} can help back with {_join([_name(c) for c in gets[:2]])}"
        if full_stack:
            why += ". Together a full-stack pair (frontend + backend)"
        elif pair:
            why += f". Together you cover {GROUP_LABELS[pair[0]]} + {GROUP_LABELS[pair[1]]}"
        why += "."
        results.append({"accountId": acct["accountId"], "displayName": acct["displayName"], "why": why,
                        "score": round(score, 1), "fullStack": full_stack})
    results.sort(key=lambda m: (-m["score"], m["accountId"]))
    return results[:limit]
