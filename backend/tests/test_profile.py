"""Lane B1 profile engine: contract fixture ingest, XP/levels, decay + refresher, in-demand, matching.

Offline only: a temporary SQLite file per test, a fixed clock, and the router mounted on a bare app.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import profile
from app.profile import engine, skills
from app.profile.store import ProfileStore

V2 = Path(__file__).resolve().parents[2] / "contracts" / "v2"
NOW = datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)
NOW_Q = {"now": engine.iso(NOW)}


def _fixture(name: str) -> dict:
    return json.loads((V2 / name).read_text(encoding="utf-8"))


def _client(store: ProfileStore) -> TestClient:
    profile.set_store(store)
    app = FastAPI()
    app.include_router(profile.router)
    return TestClient(app)


@pytest.fixture()
def empty(tmp_path):
    client = _client(ProfileStore(tmp_path / "p.db", seed=False))
    yield client
    profile.set_store(None)


@pytest.fixture()
def seeded(tmp_path):
    client = _client(ProfileStore(tmp_path / "p.db", now=NOW))
    yield client
    profile.set_store(None)


def _pass(i: int, concept: str, at: datetime, **kw) -> dict:
    return {"id": f"p{concept}{i}", "accountId": "test-x", "at": engine.iso(at), "type": "passed",
            "videoId": "v1", "exerciseId": f"ex{i}", "concepts": [concept], "level": "beginner-1",
            "attempts": 1, "hintsUsed": 0, **kw}


# --- ingest (contract §3) ---------------------------------------------------------------------------


def test_fixture_events_ingest_idempotently(empty):
    events = _fixture("practice-events.fixture.json")["events"]
    first = empty.post("/v2/events", json={"events": events}).json()
    assert first == {"accepted": 6, "duplicates": 0, "rejected": []}
    again = empty.post("/v2/events", json={"events": events}).json()
    assert again == {"accepted": 0, "duplicates": 6, "rejected": []}
    assert any(a["accountId"] == "test-ana" and a["public"] is False
               for a in empty.get("/v2/accounts").json()["accounts"])


def test_fixture_stream_levels_and_private_stats(empty):
    empty.post("/v2/events", json=_fixture("practice-events.fixture.json"))
    q = {"now": "2026-11-09T18:00:00Z"}
    loops = empty.get("/v2/profile/test-ana/level/loops", params=q).json()
    # failed 3 + passed (beginner-1, 2nd try, 1 hint) 30*0.8=24 + correct refresher 15 = 42 -> Beginner II (40).
    assert (loops["xp"], loops["level"], loops["levelName"], loops["tier"]) == (42, "beginner-2", "Beginner II", "beginner")
    assert loops["nextLevel"] == {"level": "beginner-3", "levelName": "Beginner III", "minXp": 100}
    assert loops["stats"] == {"watchedS": 203.3, "practiced": 2, "passed": 1, "failed": 1, "skipped": 0,
                              "hintsUsed": 1, "refreshers": 1}
    functions = empty.get("/v2/profile/test-ana/level/functions", params=q).json()
    assert functions["xp"] == 13 and functions["level"] == "beginner-1"  # secondary concept earns half
    lists = empty.get("/v2/profile/test-ana/level/lists", params=q).json()
    assert lists["xp"] == 0 and lists["stats"]["skipped"] == 1  # skips earn nothing
    # Events after `now` are not counted yet.
    early = empty.get("/v2/profile/test-ana/level/loops", params={"now": "2026-11-08T03:03:00Z"}).json()
    assert early["xp"] == 3


def test_bad_events_rejected_individually_and_bad_bodies(empty):
    good = _pass(1, "loops", NOW)
    bad = [
        {"id": "b1", "accountId": "test-x", "at": "nope", "type": "passed"},
        {"id": "b2", "accountId": "test-x", "at": "2026-11-08T00:00:00Z", "type": "teleported"},
        {"id": "b3", "accountId": "test-x", "at": "2026-11-08T00:00:00Z", "type": "watched", "videoId": "v", "watchedS": [50, 10]},
        {"id": "b4", "accountId": "test-x", "at": "2026-11-08T00:00:00Z", "type": "refresher_answered"},
        {"accountId": "test-x", "at": "2026-11-08T00:00:00Z", "type": "passed"},
        "not an object",
    ]
    body = empty.post("/v2/events", json={"events": [good, *bad]}).json()
    assert body["accepted"] == 1 and len(body["rejected"]) == 6
    assert empty.post("/v2/events", json={"nope": []}).status_code == 400
    assert empty.post("/v2/events", content=b"{", headers={"content-type": "application/json"}).status_code == 400
    assert empty.post("/v2/events", json={"events": [good] * 501}).status_code == 413


def test_unknown_concepts_are_dropped_not_fatal(empty):
    e = _pass(1, "loops", NOW)
    e["concepts"] = ["quantum-vibes", "loops"]
    assert empty.post("/v2/events", json={"events": [e]}).json()["accepted"] == 1
    assert empty.get("/v2/profile/test-x/level/loops", params=NOW_Q).json()["xp"] == 37  # 30 * 1.25, full share


def test_watch_time_is_union_of_intervals():
    ev = [{"id": f"w{i}", "accountId": "a", "at": "2026-11-08T00:00:00Z", "type": "watched", "videoId": "v",
           "watchedS": span} for i, span in enumerate([[0, 100], [50, 150], [300, 400]])]
    ev.append(_pass(1, "loops", NOW, videoId="v"))
    rep = engine.replay(ev, NOW)
    assert rep.watched["v"] == 250
    assert rep.watched_for(rep.concepts["loops"]) == 250


# --- XP and levels ----------------------------------------------------------------------------------


def test_xp_rewards_harder_levels_fewer_hints_first_try_and_optimal():
    base = {"level": "beginner-1", "attempts": 2, "hintsUsed": 0}
    assert engine.pass_xp({**base, "level": "intermediate-1"}, 1) > engine.pass_xp(base, 1)
    assert engine.pass_xp({**base, "hintsUsed": 2}, 1) < engine.pass_xp(base, 1)
    assert engine.pass_xp({**base, "hintsUsed": 9}, 1) == pytest.approx(30 * 0.4)  # hint floor
    assert engine.pass_xp({**base, "attempts": 1}, 1) == pytest.approx(30 * 1.25)
    assert engine.pass_xp({**base, "optimal": True}, 1) == pytest.approx(30 * 1.2)
    assert engine.pass_xp(base, 8) == pytest.approx(15)  # far-too-easy exercise is halved


def test_generated_stream_levels_up_through_tiers(empty):
    start = NOW - timedelta(days=60)
    events = []
    for i in range(40):
        lvl = engine.LEVELS[min(i // 3, 24)]["id"]
        events.append(_pass(i, "recursion", start + timedelta(days=i), level=lvl, optimal=i % 2 == 0))
    empty.post("/v2/events", json={"events": events})
    rep = engine.replay(events, NOW)
    ups = [lv for _, lv in rep.concepts["recursion"].level_ups]
    ranks = [engine.LEVEL_BY_ID[lv]["rank"] for lv in ups]
    assert ranks == sorted(ranks) and ups[0] == "beginner-2"
    assert {"beginner", "intermediate", "advanced"} <= {engine.LEVEL_BY_ID[lv]["tier"] for lv in ups}
    level = empty.get("/v2/profile/test-x/level/recursion", params=NOW_Q).json()
    assert level["level"] == ups[-1] and level["xp"] >= engine.LEVEL_BY_ID[ups[-1]]["minXp"]


def test_everyone_starts_at_beginner_one(seeded):
    lv = seeded.get("/v2/profile/test-eli/level/sql-joins", params=NOW_Q).json()
    assert (lv["level"], lv["xp"], lv["strength"], lv["refresherDue"]) == ("beginner-1", 0, 0.0, False)


# --- decay and refreshers ---------------------------------------------------------------------------


def test_strength_decays_and_spaced_practice_lasts_longer():
    massed = [_pass(i, "loops", NOW + timedelta(minutes=i)) for i in range(5)]
    spaced = [_pass(i, "loops", NOW + timedelta(days=i)) for i in range(5)]
    last_m, last_s = NOW + timedelta(minutes=4), NOW + timedelta(days=4)
    m = engine.replay(massed, last_m).concepts["loops"]
    assert m.strength(last_m) == 1.0
    s7 = engine.replay(spaced, last_s + timedelta(days=7)).concepts["loops"].strength(last_s + timedelta(days=7))
    m7 = engine.replay(massed, last_m + timedelta(days=7)).concepts["loops"].strength(last_m + timedelta(days=7))
    assert s7 > 0.35 > m7
    strengths = [m.strength(last_m + timedelta(days=d)) for d in range(6)]
    assert strengths == sorted(strengths, reverse=True)


def test_refresher_due_after_simulated_days_and_cleared_by_answer(empty):
    empty.post("/v2/events", json={"events": [_pass(1, "sorting", NOW)]})
    fresh = empty.get("/v2/profile/test-x/level/sorting", params=NOW_Q).json()
    assert fresh["strength"] == 1.0 and not fresh["refresherDue"]
    assert empty.get("/v2/refresher/test-x", params=NOW_Q).status_code == 204
    later = {"now": engine.iso(NOW + timedelta(days=3))}
    assert empty.get("/v2/profile/test-x/level/sorting", params=later).json()["refresherDue"]
    prof = empty.get("/v2/profile/test-x", params=later).json()
    assert prof["refresherDue"] == [{"concept": "sorting", "reason": "strength below 0.35"}]
    r = empty.get("/v2/refresher/test-x", params=later)
    assert r.status_code == 200
    body = r.json()
    assert body["concept"] == "sorting" and body["question"]["id"] == "rf-sorting-1"
    assert "answer" not in json.dumps(body) and "explanation" not in body["question"]
    answered = {"id": "r1", "accountId": "test-x", "at": later["now"], "type": "refresher_answered",
                "exerciseId": body["question"]["id"], "concepts": ["sorting"], "correct": True}
    empty.post("/v2/events", json={"events": [answered]})
    after = empty.get("/v2/profile/test-x/level/sorting", params=later).json()
    assert after["strength"] == 1.0 and not after["refresherDue"] and after["xp"] == 52  # 37 + 15
    assert empty.get("/v2/refresher/test-x", params=later).status_code == 204


def test_refresher_bank_covers_every_concept_with_valid_answers():
    bank = skills._load_bank()
    assert {q["concept"] for q in bank.values()} == set(engine.CONCEPTS)
    for qid, q in bank.items():
        assert qid.startswith("rf-") and q["level"] in engine.LEVEL_BY_ID
        assert q["answer"] in {c["id"] for c in q["choices"]}
        found = skills.lookup_refresher(qid)
        assert found["answer"] == q["answer"] and found["question"]["concepts"] == [q["concept"]]
    assert skills.lookup_refresher("nope") is None


def test_seeded_refreshers(seeded):
    ana = seeded.get("/v2/refresher/test-ana", params=NOW_Q).json()
    assert ana["concept"] == "lists" and ana["question"]["style"] == "multiple_choice"
    assert seeded.get("/v2/refresher/test-eli", params=NOW_Q).status_code == 204
    assert seeded.get("/v2/refresher/test-dee", params=NOW_Q).status_code == 204


# --- profile (contract §4) --------------------------------------------------------------------------


def test_profile_matches_public_contract_shape(seeded):
    fixture = _fixture("public-profile.fixture.json")
    body = seeded.get("/v2/profile/test-ana", params=NOW_Q).json()
    assert set(body) == set(fixture)
    assert body["schemaVersion"] == 2 and body["displayName"] == "Ana (test)" and body["public"] is True
    for s in body["skills"]:
        assert set(s) == set(fixture["skills"][0])
        assert s["lastPracticedAt"] and 0 <= s["strength"] <= 1
        assert engine.LEVEL_BY_ID[s["level"]]["name"] == s["levelName"]
    for key in ("topInDemand", "complements", "refresherDue"):
        for item in body[key]:
            assert set(item) == set(fixture[key][0])
    assert "watched" not in json.dumps(body).lower()  # watch history never exposed
    assert [s["concept"] for s in body["skills"]][0] == "loops"
    assert body["highlights"][0].startswith("Loops · 6 challenges passed across 2 tutorials")


def test_unknown_account_concept_and_bad_now(seeded):
    assert seeded.get("/v2/profile/nobody").status_code == 404
    assert seeded.get("/v2/profile/test-ana/level/quantum").json()["error"]["code"] == "UNKNOWN_CONCEPT"
    assert seeded.get("/v2/refresher/nobody").status_code == 404
    assert seeded.get("/v2/matches/nobody").status_code == 404
    assert seeded.get("/v2/profile/test-ana", params={"now": "yesterday"}).status_code == 400


def test_seeded_accounts_have_distinct_skill_mixes(seeded):
    accts = seeded.get("/v2/accounts").json()["accounts"]
    assert [a["accountId"] for a in accts] == ["test-ana", "test-ben", "test-cam", "test-dee", "test-eli"]
    tiers = {}
    for a in accts:
        p = seeded.get(f"/v2/profile/{a['accountId']}", params=NOW_Q).json()
        tiers[a["accountId"]] = {s["concept"]: engine.LEVEL_BY_ID[s["level"]]["tier"] for s in p["skills"]}
    assert tiers["test-ben"]["sql-joins"] == tiers["test-ben"]["http-apis"] == "advanced"
    assert tiers["test-cam"]["react-components"] == tiers["test-cam"]["react-state"] == "advanced"
    assert tiers["test-dee"]["recursion"] == "intermediate"
    assert set(tiers["test-ana"].values()) == {"beginner"} and tiers["test-eli"] == {}


def test_reopening_store_does_not_reseed(tmp_path):
    ProfileStore(tmp_path / "p.db", now=NOW)
    n = len(ProfileStore(tmp_path / "p.db").events_for("test-ben"))
    again = ProfileStore(tmp_path / "p.db", now=NOW + timedelta(days=5))
    assert len(again.events_for("test-ben")) == n and len(again.list_accounts()) == 5


# --- in-demand skills -------------------------------------------------------------------------------


def test_in_demand_top_three_with_sources_and_videos(seeded):
    body = seeded.get("/v2/skills/in-demand").json()
    assert body["asOf"] == "2026-11-08" and len(body["skills"]) == 3
    for s in body["skills"]:
        assert s["concept"] in engine.CONCEPTS and s["videoUrl"].startswith("https://www.youtube.com/watch?v=")
        assert s["sources"] and all(src["url"].startswith("https://") for src in s["sources"])
    ben = seeded.get("/v2/skills/in-demand", params={"accountId": "test-ben", **NOW_Q}).json()["skills"]
    assert len(ben) == 3 and not {"http-apis", "sql-joins"} & {s["concept"] for s in ben}  # already Advanced


def test_in_demand_source_is_swappable(seeded):
    custom = {"asOf": "2027-01-01", "sources": [{"id": "x", "title": "feed", "url": "https://example.com"}],
              "skills": [{"concept": "git", "reason": "r", "videoUrl": "https://www.youtube.com/watch?v=RGOj5yH7evk",
                          "sourceIds": ["x"]}, {"concept": "not-a-concept", "reason": "r", "videoUrl": "u"}]}
    skills.set_source(lambda: custom)
    try:
        body = seeded.get("/v2/skills/in-demand").json()
        assert body["asOf"] == "2027-01-01" and [s["concept"] for s in body["skills"]] == ["git"]
    finally:
        skills.set_source(skills.file_source())


# --- matching ---------------------------------------------------------------------------------------


def test_frontend_and_backend_pair_up_as_full_stack(seeded):
    cam = seeded.get("/v2/matches/test-cam", params=NOW_Q).json()["matches"]
    assert cam[0]["accountId"] == "test-ben" and cam[0]["fullStack"]
    assert "full-stack pair" in cam[0]["why"]
    ben = seeded.get("/v2/matches/test-ben", params=NOW_Q).json()["matches"]
    assert ben[0]["accountId"] == "test-cam" and ben[0]["fullStack"]


def test_matches_explain_why_and_skip_private_accounts(seeded):
    ana = seeded.get("/v2/profile/test-ana", params=NOW_Q).json()["complements"]
    ben = next(m for m in ana if m["accountId"] == "test-ben")
    assert ben["why"] == "Advanced in http-apis and sql-joins, where Ana is a beginner"
    for acct in ("test-ana", "test-ben", "test-cam", "test-dee"):
        ms = seeded.get(f"/v2/matches/{acct}", params=NOW_Q).json()["matches"]
        assert ms and all(m["accountId"] not in {acct, "test-eli"} for m in ms)
        assert all(m["why"] for m in ms)
