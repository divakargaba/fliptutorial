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

SEED_VERSION = 2  # bump when the seed plans change; existing local DBs reseed their seed-* events

# (concept, passes, exercise level, days since last pass, videos)
Plan = list[tuple[str, int, str, float, list[str]]]

SEED_ACCOUNTS: list[tuple[str, str, bool, Plan, list[tuple[str, float]]]] = [
    # Ana: Python beginner. Loops/functions fresh; lists practiced long ago and failed -> refresher due.
    ("test-ana", "Ana (test)", True, [
        ("loops", 6, "beginner-2", 1, ["rfscVS0vtbw", "nLRL_NcnK-4"]),
        ("functions", 3, "beginner-1", 2, ["rfscVS0vtbw"]),
        ("conditionals", 2, "beginner-1", 3, ["nLRL_NcnK-4"]),
    ], [("lists", 9)]),
    # Ben: back-end. Strong HTTP APIs + SQL, beginner React. At most ~6 solved per tutorial.
    ("test-ben", "Ben (test)", True, [
        ("http-apis", 18, "intermediate-3", 1, ["GZvSYJDk-us", "iWYsBpA6CiE", "VaVXZHWDrhw"]),
        ("sql-joins", 19, "intermediate-3", 3, ["HXV3zeQKqGY", "9Pzj7Aj25lw", "7mz73uXD9DA", "2-1XQHAgDsM"]),
        ("sql-select", 14, "intermediate-2", 5, ["HXV3zeQKqGY", "7mz73uXD9DA", "9Pzj7Aj25lw"]),
        ("react-state", 1, "beginner-1", 4, ["O6P86uwfdR0"]),
    ], []),
    # Cam: front-end. Strong React + JS, beginner SQL.
    ("test-cam", "Cam (test)", True, [
        ("react-components", 20, "intermediate-3", 1, ["O6P86uwfdR0", "bMknfKXIFA8", "SqcY0GlETPk", "Rh3tobg7hEo"]),
        ("react-state", 18, "intermediate-3", 3, ["O6P86uwfdR0", "TNhaISOUy6Q", "4pO-HcG2igk"]),
        ("js-dom", 9, "intermediate-1", 4, ["PkZNo7MFNFg", "y17RuWkWdn8"]),
        ("js-async", 7, "intermediate-1", 6, ["PoRJizFvM7s", "V_Kr9OSfDeU"]),
        ("sql-select", 1, "beginner-1", 5, ["HXV3zeQKqGY"]),
    ], []),
    # Dee: algorithms. Strong recursion/DP/trees/graphs; recursion slightly stale.
    ("test-dee", "Dee (test)", True, [
        ("dynamic-programming", 15, "intermediate-3", 1, ["oBt53YbR9Kk", "Hdr64lKQ3e4", "66hDgWottdA"]),
        ("recursion", 12, "intermediate-3", 6, ["8hly31xKli0", "ngCos392W4w"]),
        ("trees", 11, "intermediate-2", 2, ["fAAZixBzIAI", "8hly31xKli0"]),
        ("graphs", 8, "intermediate-2", 3, ["tWVWeAqZ0WU", "8hly31xKli0"]),
        ("loops", 5, "beginner-5", 3, ["rfscVS0vtbw"]),
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
