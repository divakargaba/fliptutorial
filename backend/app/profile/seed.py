"""Seeded local test accounts with different skill mixes, expressed as generated practice events.

Seeding writes ordinary contract events (ids `seed-…`) relative to the moment the DB is created, so the
profiles, levels, decay and matching all come from the same replay path as live events.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from .engine import iso

if TYPE_CHECKING:
    from .store import ProfileStore

# (concept, passes, exercise level, days since last pass, videos)
Plan = list[tuple[str, int, str, float, list[str]]]

SEED_ACCOUNTS: list[tuple[str, str, bool, Plan, list[tuple[str, float]]]] = [
    # Ana: Python beginner. Loops/functions fresh; lists practiced long ago and failed -> refresher due.
    ("test-ana", "Ana (test)", True, [
        ("loops", 6, "beginner-2", 1, ["rfscVS0vtbw", "nLRL_NcnK-4"]),
        ("functions", 3, "beginner-1", 2, ["rfscVS0vtbw"]),
        ("conditionals", 2, "beginner-1", 3, ["nLRL_NcnK-4"]),
    ], [("lists", 9)]),
    # Ben: back-end. Strong SQL + HTTP APIs, beginner React.
    ("test-ben", "Ben (test)", True, [
        ("sql-joins", 18, "intermediate-3", 1, ["HXV3zeQKqGY"]),
        ("sql-select", 14, "intermediate-2", 2, ["HXV3zeQKqGY"]),
        ("http-apis", 18, "intermediate-3", 1, ["GZvSYJDk-us"]),
        ("react-state", 1, "beginner-1", 4, ["O6P86uwfdR0"]),
    ], []),
    # Cam: front-end. Strong React + JS, beginner SQL/APIs.
    ("test-cam", "Cam (test)", True, [
        ("react-components", 18, "intermediate-3", 1, ["O6P86uwfdR0"]),
        ("react-state", 18, "intermediate-3", 1, ["O6P86uwfdR0"]),
        ("js-dom", 12, "intermediate-1", 2, ["PkZNo7MFNFg"]),
        ("js-async", 10, "intermediate-1", 3, ["PoRJizFvM7s"]),
        ("sql-select", 1, "beginner-1", 5, ["HXV3zeQKqGY"]),
    ], []),
    # Dee: algorithms. Strong recursion/DP/graphs/trees; recursion slightly stale.
    ("test-dee", "Dee (test)", True, [
        ("recursion", 16, "intermediate-3", 6, ["8hly31xKli0"]),
        ("dynamic-programming", 14, "intermediate-3", 1, ["oBt53YbR9Kk"]),
        ("graphs", 10, "intermediate-2", 2, ["8hly31xKli0"]),
        ("trees", 12, "intermediate-2", 2, ["8hly31xKli0"]),
        ("loops", 8, "beginner-5", 3, ["rfscVS0vtbw"]),
    ], []),
    # Eli: brand-new private learner; everything at Beginner I.
    ("test-eli", "Eli (test)", False, [], []),
]


def seed_events(account_id: str, plan: Plan, failed: list[tuple[str, float]], now: datetime) -> list[dict]:
    events: list[dict] = []
    for concept, passes, level, last_days, videos in plan:
        for i in range(passes):
            # One pass per day, ending `last_days` ago; alternate first-try, a hint now and then.
            at = now - timedelta(days=last_days + (passes - 1 - i), hours=2)
            video = videos[i % len(videos)]
            tag = f"seed-{account_id}-{concept}-{i}"
            if i < len(videos):  # first visit to each tutorial: 10 minutes of honest playback
                events.append({"id": f"{tag}-w", "accountId": account_id, "at": iso(at - timedelta(minutes=20)),
                               "type": "watched", "videoId": video, "watchedS": [0, 600]})
            events.append({
                "id": tag, "accountId": account_id, "at": iso(at), "type": "passed", "videoId": video,
                "exerciseId": f"seed-{concept}-{i}", "concepts": [concept], "level": level,
                "attempts": 1 if i % 3 else 2, "hintsUsed": 1 if i % 4 == 3 else 0,
                "optimal": level.startswith(("intermediate", "advanced", "expert")),
            })
    for concept, days in failed:
        at = now - timedelta(days=days)
        events.append({"id": f"seed-{account_id}-{concept}-fail", "accountId": account_id, "at": iso(at),
                       "type": "failed", "videoId": "rfscVS0vtbw", "exerciseId": f"seed-{concept}-fail",
                       "concepts": [concept], "level": "beginner-1", "attempts": 1, "hintsUsed": 0})
        events.append({"id": f"seed-{account_id}-{concept}-practiced", "accountId": account_id,
                       "at": iso(at + timedelta(minutes=5)), "type": "practiced", "videoId": "rfscVS0vtbw",
                       "exerciseId": f"seed-{concept}-fail", "concepts": [concept]})
    return events


def seed_store(store: "ProfileStore", now: datetime) -> None:
    for account_id, name, public, plan, failed in SEED_ACCOUNTS:
        store.upsert_account(account_id, name, public, seeded=True)
        store.add_events(seed_events(account_id, plan, failed, now))
