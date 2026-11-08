"""Pure profile logic: replay practice events (contracts/v2 §3) into per-concept skill state.

No I/O besides reading the frozen vocabularies once. Everything is a function of (events, now), so
decay can be simulated by passing a later `now`.

XP (Duolingo-style, per concept):
  passed            30 x level multiplier (+15 % per rank of the exercise) x hint factor (-20 % per hint,
                    floor 40 %) x first-try bonus (1.25) x optimal bonus (1.2); halved when the exercise
                    is 4+ ranks below the learner. The first concept of an event gets full XP, others half.
  practiced         5          failed      3          skipped / hint_used / watched   0
  refresher         15 when correct, 2 when not.
Strength: 2^(-days since last practice / half-life). Half-life starts at 0.5 days, becomes 1 day on the
first success, doubles per success on a new day (x1.2 same day, cap 90 days) and halves on a failure
(floor 0.5). Strength below REFRESHER_THRESHOLD makes the concept due for a refresher.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable

CONTRACTS_V2 = Path(__file__).resolve().parents[3] / "contracts" / "v2"

PASS_BASE_XP = 30.0
LEVEL_STEP = 0.15
HINT_PENALTY = 0.2
MIN_HINT_FACTOR = 0.4
FIRST_TRY_BONUS = 1.25
OPTIMAL_BONUS = 1.2
EASY_GAP = 4
EASY_FACTOR = 0.5
SECONDARY_SHARE = 0.5
PRACTICE_XP = 5.0
FAIL_XP = 3.0
REFRESHER_CORRECT_XP = 15.0
REFRESHER_WRONG_XP = 2.0

UNPASSED_HALF_LIFE = 0.5
FIRST_SUCCESS_HALF_LIFE = 1.0
MAX_HALF_LIFE = 90.0
SAME_DAY_GROWTH = 1.2
REFRESHER_THRESHOLD = 0.35

EVENT_TYPES = {"watched", "practiced", "passed", "failed", "skipped", "hint_used", "refresher_answered"}
MAX_WATCH_SPAN_S = 6 * 3600


def _load(name: str) -> dict:
    return json.loads((CONTRACTS_V2 / name).read_text(encoding="utf-8"))


LEVELS: list[dict] = sorted(_load("levels.json")["levels"], key=lambda lv: lv["rank"])
LEVEL_BY_ID: dict[str, dict] = {lv["id"]: lv for lv in LEVELS}
CONCEPTS: dict[str, dict] = {c["id"]: c for c in _load("concepts.json")["concepts"]}


def level_for_xp(xp: float) -> dict:
    current = LEVELS[0]
    for lv in LEVELS:
        if xp >= lv["minXp"]:
            current = lv
    return current


def next_level(level: dict) -> dict | None:
    idx = level["rank"]  # ranks are 1-based and contiguous
    return LEVELS[idx] if idx < len(LEVELS) else None


def level_rank(level_id: str | None) -> int | None:
    lv = LEVEL_BY_ID.get(level_id or "")
    return lv["rank"] if lv else None


def parse_time(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def validate_event(raw: Any) -> tuple[dict | None, str | None]:
    """Normalise one incoming event. Returns (event, None) or (None, reason)."""
    if not isinstance(raw, dict):
        return None, "event must be an object"
    for key in ("id", "accountId", "at", "type"):
        if not isinstance(raw.get(key), str) or not raw[key].strip():
            return None, f"missing {key}"
    # Same bound as the extension's queue schema (A3), so nothing it accepts is rejected forever.
    if len(raw["id"]) > 200 or len(raw["accountId"]) > 200:
        return None, "id too long"
    if raw["type"] not in EVENT_TYPES:
        return None, f"unknown type {raw['type']!r}"
    try:
        at = parse_time(raw["at"])
    except ValueError:
        return None, "bad at timestamp"
    event = {k: v for k, v in raw.items() if v is not None}
    event["at"] = iso(at)
    concepts = raw.get("concepts") or []
    if not isinstance(concepts, list):
        return None, "concepts must be a list"
    # Unknown concept ids are dropped rather than failing the event (vocabulary only grows via the lead).
    event["concepts"] = [c for c in concepts if isinstance(c, str) and c in CONCEPTS]
    for key in ("attempts", "hintsUsed", "hintLevel"):
        if key in event and (not isinstance(event[key], int) or isinstance(event[key], bool) or event[key] < 0):
            return None, f"{key} must be a non-negative integer"
    if raw["type"] == "watched":
        span = raw.get("watchedS")
        if (
            not isinstance(span, list) or len(span) != 2
            or not all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in span)
            or span[0] < 0 or span[1] <= span[0] or span[1] - span[0] > MAX_WATCH_SPAN_S
        ):
            return None, "watched needs watchedS [start, end] with 0 <= start < end"
        if not isinstance(raw.get("videoId"), str):
            return None, "watched needs videoId"
    if raw["type"] == "refresher_answered" and not isinstance(raw.get("correct"), bool):
        return None, "refresher_answered needs correct"
    return event, None


@dataclass
class ConceptState:
    concept: str
    xp: float = 0.0
    passed: int = 0
    practiced: int = 0
    failed: int = 0
    skipped: int = 0
    hints_used: int = 0
    refreshers: int = 0
    videos: set[str] = field(default_factory=set)
    answered_questions: set[str] = field(default_factory=set)
    last_practiced: datetime | None = None
    last_success_day: date | None = None
    half_life_days: float = UNPASSED_HALF_LIFE
    level_ups: list[tuple[str, str]] = field(default_factory=list)  # (at, level id)

    @property
    def level(self) -> dict:
        return level_for_xp(self.xp)

    @property
    def active(self) -> bool:
        return self.last_practiced is not None

    def strength(self, now: datetime) -> float:
        if self.last_practiced is None:
            return 0.0
        days = max(0.0, (now - self.last_practiced).total_seconds() / 86400)
        return round(2 ** (-days / self.half_life_days), 2)

    def _success(self, at: datetime) -> None:
        day = at.date()
        if self.last_success_day is None:
            self.half_life_days = max(self.half_life_days, FIRST_SUCCESS_HALF_LIFE)
        elif day > self.last_success_day:
            self.half_life_days = min(MAX_HALF_LIFE, self.half_life_days * 2)
        else:
            self.half_life_days = min(MAX_HALF_LIFE, self.half_life_days * SAME_DAY_GROWTH)
        self.last_success_day = day

    def _failure(self) -> None:
        self.half_life_days = max(UNPASSED_HALF_LIFE, self.half_life_days * 0.5)

    def add_xp(self, amount: float, at: str) -> None:
        before = self.level["id"]
        self.xp += amount
        after = self.level["id"]
        if after != before:
            self.level_ups.append((at, after))


def pass_xp(event: dict, learner_rank: int) -> float:
    ex_rank = level_rank(event.get("level")) or learner_rank
    xp = PASS_BASE_XP * (1 + LEVEL_STEP * (ex_rank - 1))
    xp *= max(MIN_HINT_FACTOR, 1 - HINT_PENALTY * int(event.get("hintsUsed") or 0))
    if event.get("attempts") == 1:
        xp *= FIRST_TRY_BONUS
    if event.get("optimal") is True:
        xp *= OPTIMAL_BONUS
    if ex_rank <= learner_rank - EASY_GAP:
        xp *= EASY_FACTOR
    return xp


@dataclass
class Replay:
    concepts: dict[str, ConceptState]
    watched: dict[str, float]  # videoId -> honest seconds (union of watched intervals)

    def watched_for(self, state: ConceptState) -> float:
        return round(sum(self.watched.get(v, 0.0) for v in state.videos), 1)


def _union_seconds(spans: list[tuple[float, float]]) -> float:
    total, cur_start, cur_end = 0.0, None, None
    for start, end in sorted(spans):
        if cur_end is None or start > cur_end:
            if cur_end is not None:
                total += cur_end - cur_start
            cur_start, cur_end = start, end
        else:
            cur_end = max(cur_end, end)
    if cur_end is not None:
        total += cur_end - cur_start
    return total


def replay(events: Iterable[dict], now: datetime) -> Replay:
    """Fold events (any order) up to `now` into concept states."""
    ordered = sorted(
        (e for e in events if parse_time(e["at"]) <= now), key=lambda e: (parse_time(e["at"]), e["id"])
    )
    states: dict[str, ConceptState] = {}
    spans: dict[str, list[tuple[float, float]]] = {}
    for e in ordered:
        etype, at_str = e["type"], e["at"]
        at = parse_time(at_str)
        if etype == "watched":
            spans.setdefault(e["videoId"], []).append((float(e["watchedS"][0]), float(e["watchedS"][1])))
            continue
        for i, cid in enumerate(e.get("concepts") or []):
            st = states.setdefault(cid, ConceptState(cid))
            share = 1.0 if i == 0 else SECONDARY_SHARE
            if e.get("videoId") and etype != "skipped":
                st.videos.add(e["videoId"])
            if etype == "skipped":
                st.skipped += 1
            elif etype == "hint_used":
                st.hints_used += 1
            elif etype == "practiced":
                st.practiced += 1
                st.last_practiced = at
                st.add_xp(PRACTICE_XP * share, at_str)
            elif etype == "failed":
                st.practiced += 1
                st.failed += 1
                st.last_practiced = at
                st._failure()
                st.add_xp(FAIL_XP * share, at_str)
            elif etype == "passed":
                st.practiced += 1
                st.passed += 1
                st.last_practiced = at
                st._success(at)
                st.add_xp(pass_xp(e, st.level["rank"]) * share, at_str)
            elif etype == "refresher_answered":
                st.refreshers += 1
                st.last_practiced = at
                if e.get("exerciseId"):
                    st.answered_questions.add(e["exerciseId"])
                if e.get("correct"):
                    st._success(at)
                    st.add_xp(REFRESHER_CORRECT_XP * share, at_str)
                else:
                    st._failure()
                    st.add_xp(REFRESHER_WRONG_XP * share, at_str)
    return Replay(states, {vid: _union_seconds(s) for vid, s in spans.items()})


def skill_view(state: ConceptState, now: datetime) -> dict:
    lv = state.level
    return {
        "concept": state.concept,
        "level": lv["id"],
        "levelName": lv["name"],
        "xp": int(state.xp),
        "strength": state.strength(now),
        "lastPracticedAt": iso(state.last_practiced) if state.last_practiced else None,
        "passed": state.passed,
        "tutorials": len(state.videos),
    }


def refresher_due(rep: Replay, now: datetime) -> list[dict]:
    due = [
        (st.strength(now), cid) for cid, st in rep.concepts.items()
        if st.active and st.strength(now) < REFRESHER_THRESHOLD
    ]
    return [{"concept": cid, "reason": f"strength below {REFRESHER_THRESHOLD}"} for _, cid in sorted(due)]


def highlights(rep: Replay) -> list[str]:
    out: list[str] = []
    passed = sorted((st for st in rep.concepts.values() if st.passed), key=lambda s: (-s.xp, s.concept))
    for st in passed[:2]:
        name = CONCEPTS[st.concept]["name"]
        n, t = st.passed, max(1, len(st.videos))
        out.append(f"{name} · {n} challenge{'s' if n != 1 else ''} passed across {t} tutorial{'s' if t != 1 else ''}")
    top = max(rep.concepts.values(), key=lambda s: (s.level["rank"], s.xp), default=None)
    if top and top.level["rank"] >= 6:
        out.append(f"Reached {top.level['name']} in {CONCEPTS[top.concept]['name']}")
    return out[:3]
