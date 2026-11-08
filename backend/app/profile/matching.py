"""Complementary matching: suggest public accounts strong where you are weak (and vice versa)."""

from __future__ import annotations

from .engine import Replay

STRONG_RANK = 6  # Intermediate I and up
FRONTEND = {"js-dom", "js-async", "react-components", "react-state"}
BACKEND = {"sql-select", "sql-joins", "http-apis"}
PAIR_BONUS = 25.0
TOP_N = 3  # only the strongest few complements count, so breadth alone does not win


def _ranks(rep: Replay) -> dict[str, int]:
    return {cid: st.level["rank"] for cid, st in rep.concepts.items()}


def _strong(ranks: dict[str, int]) -> set[str]:
    return {c for c, r in ranks.items() if r >= STRONG_RANK}


def _tier_word(rank: int) -> str:
    return "Expert" if rank >= 16 else "Advanced" if rank >= 11 else "Intermediate"


def match(me: dict, my_rep: Replay, others: list[tuple[dict, Replay]], limit: int = 3) -> list[dict]:
    """`me`/`others` are account dicts ({accountId, displayName, public}); only public others are suggested."""
    mine = _ranks(my_rep)
    my_strong = _strong(mine)
    first = me["displayName"].split(" ")[0]
    results = []
    for acct, rep in others:
        if acct["accountId"] == me["accountId"] or not acct["public"]:
            continue
        theirs = _ranks(rep)
        their_strong = _strong(theirs)
        gives = sorted((c for c in their_strong if mine.get(c, 1) < STRONG_RANK), key=lambda c: (-theirs[c], c))
        if not gives:
            continue
        gets = sorted((c for c in my_strong if theirs.get(c, 1) < STRONG_RANK), key=lambda c: (-mine[c], c))
        score = sum(theirs[c] - mine.get(c, 1) for c in gives[:TOP_N])
        score += 0.5 * sum(mine[c] - theirs.get(c, 1) for c in gets[:TOP_N])
        full_stack = bool(
            (my_strong & FRONTEND and their_strong & BACKEND) or (my_strong & BACKEND and their_strong & FRONTEND)
        )
        if full_stack:
            score += PAIR_BONUS
        shown = gives[:2]
        why = f"{_tier_word(min(theirs[c] for c in shown))} in {' and '.join(shown)}, where {first} is a beginner"
        if full_stack:
            why += "; together a full-stack pair"
        elif gets:
            why += f"; {first} can help back with {gets[0]}"
        results.append({"accountId": acct["accountId"], "displayName": acct["displayName"], "why": why,
                        "score": round(score, 1), "fullStack": full_stack})
    results.sort(key=lambda m: (-m["score"], m["accountId"]))
    return results[:limit]
