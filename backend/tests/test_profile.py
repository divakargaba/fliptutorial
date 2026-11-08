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


@pytest.fixture(autouse=True)
def no_generator():
    """Offline: lane A2's refresher generator is off unless a test installs a stub."""
    skills.set_generator(None)
    yield
    skills.set_generator(skills._UNSET)


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
    q = {"now": "2026-11-09T18:00:00Z", "detail": "true"}
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


def test_ack_satisfies_extension_queue_check(empty):
    """A3 removes queued events only when the ack accounts for every sent id exactly once."""
    long_id = "e" * 200
    a3_shaped = [
        {**_pass(1, "loops", NOW), "id": long_id, "accountId": "a" * 200, "at": "2026-11-10T11:59:58.123Z"},
        {"id": "w1", "accountId": "test-x", "at": "2026-11-10T11:59:59.999Z", "type": "watched",
         "videoId": "rfscVS0vtbw", "watchedS": [12.5, 40.25]},
        {"id": "bad", "accountId": "test-x", "at": "2026-11-10T12:00:00.000Z", "type": "refresher_answered"},
    ]
    sent = [*a3_shaped, a3_shaped[0]]  # a resend inside one batch counts as a duplicate
    ack = empty.post("/v2/events", json={"events": sent}).json()
    rejected_ids = [r["id"] for r in ack["rejected"]]
    assert ack["accepted"] + ack["duplicates"] + len(rejected_ids) == len(sent)
    assert rejected_ids == ["bad"] and all(isinstance(r["reason"], str) for r in ack["rejected"])
    assert (ack["accepted"], ack["duplicates"]) == (2, 1)


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
    assert lv == {"accountId": "test-eli", "concept": "sql-joins", "level": "beginner-1", "levelName": "Beginner I",
                  "rank": 1, "xp": 0, "strength": 0.0}
    # Unknown concept or account: same beginner-1 default, never an error (contract §4).
    for path in ("/v2/profile/test-ana/level/quantum", "/v2/profile/nobody/level/loops"):
        r = seeded.get(path, params=NOW_Q)
        assert r.status_code == 200 and (r.json()["level"], r.json()["rank"], r.json()["xp"]) == ("beginner-1", 1, 0)
    assert seeded.get("/v2/profile/nobody/levels").json() == {"accountId": "nobody", "levels": {}}


def test_level_info_is_exact_contract_shape_and_levels_map(seeded):
    lv = seeded.get("/v2/profile/test-ben/level/sql-joins", params=NOW_Q).json()
    assert set(lv) == {"accountId", "concept", "level", "levelName", "rank", "xp", "strength"}
    assert (lv["level"], lv["rank"]) == ("advanced-2", 12) and lv["strength"] > 0.9
    levels = seeded.get("/v2/profile/test-ben/levels", params=NOW_Q).json()
    assert levels == {"accountId": "test-ben", "levels": {
        "http-apis": "advanced-1", "react-state": "beginner-1", "sql-joins": "advanced-2", "sql-select": "intermediate-4"}}


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
    fresh = empty.get("/v2/profile/test-x/level/sorting", params={**NOW_Q, "detail": "true"}).json()
    assert fresh["strength"] == 1.0 and not fresh["refresherDue"]
    assert empty.get("/v2/refresher/test-x", params=NOW_Q).status_code == 204
    later = {"now": engine.iso(NOW + timedelta(days=3))}
    assert empty.get("/v2/profile/test-x/level/sorting", params={**later, "detail": "true"}).json()["refresherDue"]
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
    after = empty.get("/v2/profile/test-x/level/sorting", params={**later, "detail": "true"}).json()
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


def _due_sorting(client) -> dict:
    client.post("/v2/events", json={"events": [_pass(1, "sorting", NOW)]})
    return {"now": engine.iso(NOW + timedelta(days=3))}


GOOD = {"title": "Stable sort", "prompt": "Which property keeps equal keys in their original order?",
        "choices": ["Stability", "In-place", "Adaptivity"], "answer": "Stability",
        "explanation": "A stable sort never reorders equal keys."}


def test_generated_refresher_is_cached_graded_and_replaced_after_answer(empty, tmp_path):
    calls = []

    async def gen(concept, name, level, avoid):
        calls.append((concept, name, level, list(avoid)))
        n = len(calls)
        return {**GOOD, "prompt": f"{GOOD['prompt']} (v{n})"}

    skills.set_generator(gen)
    later = _due_sorting(empty)
    first = empty.get("/v2/refresher/test-x", params=later).json()
    q = first["question"]
    assert q["id"].startswith("rf-gen-sorting-") and q["aiGenerated"] is True and q["style"] == "multiple_choice"
    assert q["level"] == "beginner-1" and [c["id"] for c in q["choices"]] == ["a", "b", "c"]
    assert "answer" not in json.dumps(first) and "explanation" not in q
    assert calls == [("sorting", engine.CONCEPTS["sorting"]["name"], "beginner-1", [])]
    # Same question again until answered (no second model call).
    assert empty.get("/v2/refresher/test-x", params=later).json()["question"] == q and len(calls) == 1
    # Lane A2 grades it by id.
    found = skills.lookup_refresher(q["id"])
    assert found["answer"] == "a" and found["question"] == q and found["explanation"]
    # Persisted: a fresh store on the same file still finds it.
    assert ProfileStore(profile.get_store().path, seed=False).get_generated(q["id"])["answer"] == "a"
    answered = {"id": "r1", "accountId": "test-x", "at": later["now"], "type": "refresher_answered",
                "exerciseId": q["id"], "concepts": ["sorting"], "correct": False}
    empty.post("/v2/events", json={"events": [answered]})
    days_on = {"now": engine.iso(NOW + timedelta(days=6))}  # answering resets decay; due again later
    second = empty.get("/v2/refresher/test-x", params=days_on).json()["question"]
    assert second["id"] != q["id"] and second["aiGenerated"] and calls[1][3] == [q["prompt"]]


def test_generation_is_bounded_per_concept_level(empty, monkeypatch):
    monkeypatch.setattr(skills, "MAX_GENERATED_PER_LEVEL", 2)  # small enough that the level stays beginner-1
    n = 0

    def gen(concept, name, level, avoid):  # sync generators work too
        nonlocal n
        n += 1
        return {**GOOD, "prompt": f"{GOOD['prompt']} #{n}"}

    skills.set_generator(gen)
    empty.post("/v2/events", json={"events": [_pass(1, "sorting", NOW, hintsUsed=3)]})  # low XP: stays beginner-1
    seen = []
    for i in range(skills.MAX_GENERATED_PER_LEVEL + 1):
        later = {"now": engine.iso(NOW + timedelta(days=3 * (i + 1)))}  # each answer resets decay
        q = empty.get("/v2/refresher/test-x", params=later).json()["question"]
        seen.append(q["id"])
        empty.post("/v2/events", json={"events": [{
            "id": f"r{i}", "accountId": "test-x", "at": later["now"], "type": "refresher_answered",
            "exerciseId": q["id"], "concepts": ["sorting"], "correct": False}]})
    assert n == 2 and seen[:2] == sorted(set(seen[:2]), key=seen.index) and seen[0].startswith("rf-gen-")
    assert seen[1].startswith("rf-gen-") and seen[2] == "rf-sorting-1"  # cap reached: the stored bank
    level = empty.get("/v2/profile/test-x/level/sorting", params={"now": engine.iso(NOW)}).json()["level"]
    assert level == "beginner-1" and len(profile.get_store().generated_for("sorting", "beginner-1")) == 2


@pytest.mark.parametrize("bad", [
    None, "text", {**GOOD, "answer": "Nope"}, {**GOOD, "choices": ["only one"]}, {**GOOD, "prompt": "short"},
    {**GOOD, "choices": ["Stability", "stability", "x"]}, {k: v for k, v in GOOD.items() if k != "explanation"},
])
def test_invalid_generated_output_falls_back_to_stored_bank(empty, bad):
    skills.set_generator(lambda *a: bad)
    later = _due_sorting(empty)
    assert empty.get("/v2/refresher/test-x", params=later).json()["question"]["id"] == "rf-sorting-1"


def test_failing_or_slow_generator_falls_back_and_backs_off(empty, monkeypatch):
    calls = 0

    async def slow(*a):
        nonlocal calls
        calls += 1
        await __import__("asyncio").sleep(5)

    monkeypatch.setattr(skills, "GENERATE_TIMEOUT_S", 0.05)
    skills.set_generator(slow)
    later = _due_sorting(empty)
    for _ in range(2):
        q = empty.get("/v2/refresher/test-x", params=later).json()["question"]
        assert q["id"] == "rf-sorting-1" and q["aiGenerated"] is False
    assert calls == 1  # no retry within the back-off window

    def boom(*a):
        raise RuntimeError("no key")

    skills.set_generator(boom)
    assert empty.get("/v2/refresher/test-x", params=later).json()["question"]["id"] == "rf-sorting-1"


def test_generator_can_be_disabled_by_env(monkeypatch):
    skills.set_generator(skills._UNSET)
    monkeypatch.setenv("BREAKPOINT_REFRESHER_GENERATE", "0")
    assert skills.get_generator() is None


def test_seeded_refreshers(seeded):
    ana = seeded.get("/v2/refresher/test-ana", params=NOW_Q).json()
    assert ana["concept"] == "lists" and ana["question"]["style"] == "multiple_choice"
    assert seeded.get("/v2/refresher/test-eli", params=NOW_Q).status_code == 204
    assert seeded.get("/v2/refresher/test-dee", params=NOW_Q).status_code == 204


def test_requested_skill_review_keeps_profile_and_default_due_behavior(seeded):
    before = seeded.get("/v2/profile/test-ana", params=NOW_Q).json()
    due = seeded.get("/v2/refresher/test-ana", params=NOW_Q).json()
    manual = seeded.get("/v2/refresher/test-ana", params={**NOW_Q, "concept": "loops"})
    assert manual.status_code == 200
    assert manual.json()["concept"] == "loops"
    assert "answer" not in manual.json()["question"]
    assert seeded.get("/v2/profile/test-ana", params=NOW_Q).json() == before
    assert seeded.get("/v2/refresher/test-ana", params=NOW_Q).json()["concept"] == due["concept"]
    assert seeded.get("/v2/refresher/test-ana", params={**NOW_Q, "concept": "bogus"}).status_code == 422
    assert seeded.get("/v2/refresher/test-ana", params={**NOW_Q, "concept": "sorting"}).status_code == 204


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


def test_public_toggle_controls_profile_and_matching(seeded):
    assert seeded.get("/v2/matches/test-cam", params=NOW_Q).json()["matches"][0]["accountId"] == "test-ben"
    r = seeded.post("/v2/profile/test-ben/public", json={"public": False})
    assert r.status_code == 200 and r.json() == {"accountId": "test-ben", "displayName": "Ben (test)", "public": False}
    assert seeded.get("/v2/profile/test-ben", params=NOW_Q).json()["public"] is False
    for acct in ("test-ana", "test-cam", "test-dee"):
        assert all(m["accountId"] != "test-ben" for m in seeded.get(f"/v2/matches/{acct}", params=NOW_Q).json()["matches"])
        assert all(c["accountId"] != "test-ben"
                   for c in seeded.get(f"/v2/profile/{acct}", params=NOW_Q).json()["complements"])
    accts = {a["accountId"]: a["public"] for a in seeded.get("/v2/accounts").json()["accounts"]}
    assert accts["test-ben"] is False and accts["test-ana"] is True
    assert seeded.post("/v2/profile/test-eli/public", json={"public": True}).json()["public"] is True
    assert seeded.post("/v2/profile/test-ben/public", json={"public": True}).json()["public"] is True
    assert seeded.get("/v2/matches/test-cam", params=NOW_Q).json()["matches"][0]["accountId"] == "test-ben"
    assert seeded.post("/v2/profile/nobody/public", json={"public": True}).status_code == 404
    for bad in ({"public": "yes"}, {}, [True]):
        assert seeded.post("/v2/profile/test-ben/public", json=bad).status_code == 400
    assert seeded.post("/v2/profile/test-ben/public", content=b"{").status_code == 400


def test_unknown_account_concept_and_bad_now(seeded):
    assert seeded.get("/v2/profile/nobody").status_code == 404
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
    assert "HTTP & APIs" in ben["why"] and "Ana is a beginner" in ben["why"]
    assert "-" not in ben["why"].split(".")[0].replace("full-stack", ""), ben["why"]  # readable names, no raw ids
    for acct in ("test-ana", "test-ben", "test-cam", "test-dee"):
        ms = seeded.get(f"/v2/matches/{acct}", params=NOW_Q).json()["matches"]
        assert ms and all(m["accountId"] not in {acct, "test-eli"} for m in ms)
        assert all(m["why"] for m in ms)


def test_public_profile_returns_full_profile_for_public_accounts(seeded):
    body = seeded.get("/v2/profile/test-ana/public", params=NOW_Q).json()
    assert body["schemaVersion"] == 2 and body["accountId"] == "test-ana"
    assert body["public"] is True
    assert set(body) == {"schemaVersion", "accountId", "displayName", "public", "skills",
                         "highlights", "refresherDue", "topInDemand", "complements"}


def test_public_profile_returns_404_for_private_accounts(seeded):
    seeded.post("/v2/profile/test-ben/public", json={"public": False})
    r = seeded.get("/v2/profile/test-ben/public", params=NOW_Q)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "PRIVATE_ACCOUNT"


def test_public_profile_returns_404_for_unknown_accounts(seeded):
    r = seeded.get("/v2/profile/nobody/public", params=NOW_Q)
    assert r.status_code == 404


def test_broader_matching_applies_group_pair_bonuses(empty):
    """Accounts strong in different concept groups get a complementary bonus."""
    base_time = NOW - timedelta(days=30)
    # User X: strong in data-structures (lists, dicts)
    # User Y: strong in algorithms (sorting, searching)
    events_x = []
    events_y = []
    for i in range(12):
        events_x.append({**_pass(i, "lists", base_time + timedelta(days=i)),
                         "accountId": "test-x", "level": f"intermediate-{min(i + 1, 5)}", "optimal": True})
        events_x.append({**_pass(100 + i, "dicts", base_time + timedelta(days=i)),
                         "accountId": "test-x", "level": f"intermediate-{min(i + 1, 5)}", "optimal": True})
        events_y.append({**_pass(200 + i, "sorting", base_time + timedelta(days=i)),
                         "accountId": "test-y", "level": f"intermediate-{min(i + 1, 5)}", "optimal": True})
        events_y.append({**_pass(300 + i, "searching", base_time + timedelta(days=i)),
                         "accountId": "test-y", "level": f"intermediate-{min(i + 1, 5)}", "optimal": True})
    empty.post("/v2/events", json={"events": events_x + events_y})
    empty.post("/v2/profile/test-x/public", json={"public": True})
    empty.post("/v2/profile/test-y/public", json={"public": True})
    ms = empty.get("/v2/matches/test-x", params=NOW_Q).json()["matches"]
    assert ms and ms[0]["accountId"] == "test-y"
    assert ms[0]["score"] > 0


# --- award: what one event earned (progress after a pass) ------------------------------------------


def test_award_for_a_first_try_pass_shows_progress_without_level_up(empty):
    ev = {**_pass(1, "recursion", NOW), "concepts": ["recursion", "functions", "conditionals"]}
    empty.post("/v2/events", json={"events": [ev]})
    a = empty.get(f"/v2/profile/test-x/award/{ev['id']}").json()
    assert a["type"] == "passed" and a["leveledUp"] is False
    rec, fn, cond = a["awards"]
    assert rec["concept"] == "recursion" and rec["primary"] is True
    assert rec["xpGained"] == 37.5 and rec["xpBefore"] == 0 and rec["xp"] == 37.5  # 30 x 1.25 first try
    assert rec["level"]["levelName"] == "Beginner I" and rec["nextLevel"]["levelName"] == "Beginner II"
    assert rec["xpToNext"] == 2.5 and rec["progress"] == 0.938  # 37.5 of 40
    assert fn["xpGained"] == cond["xpGained"] == 18.8 and fn["primary"] is False  # secondary concepts: half
    assert a["totalXpGained"] == 75.1


def test_award_reports_level_up_and_ignores_later_events(empty):
    first, second = _pass(1, "loops", NOW), _pass(2, "loops", NOW + timedelta(minutes=5))
    third = _pass(3, "loops", NOW + timedelta(minutes=10))
    empty.post("/v2/events", json={"events": [first, second, third]})
    a = empty.get(f"/v2/profile/test-x/award/{second['id']}").json()["awards"][0]
    assert a["leveledUp"] is True and a["levelBefore"]["levelName"] == "Beginner I"
    assert a["level"]["levelName"] == "Beginner II" and a["xpBefore"] == 37.5 and a["xp"] == 75.0
    assert a["nextLevel"]["levelName"] == "Beginner III" and a["xpToNext"] == 25.0
    assert a["progress"] == round((75 - 40) / (100 - 40), 3)


def test_award_for_a_failure_is_small_and_unknown_event_is_404(empty):
    fail = {**_pass(1, "loops", NOW), "id": "f1", "type": "failed", "misconception": "off-by-one"}
    empty.post("/v2/events", json={"events": [fail]})
    a = empty.get("/v2/profile/test-x/award/f1").json()
    assert a["awards"][0]["xpGained"] == engine.FAIL_XP and a["leveledUp"] is False
    missing = empty.get("/v2/profile/test-x/award/not-delivered-yet")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "EVENT_NOT_FOUND"
    assert empty.get("/v2/profile/nobody/award/f1").status_code == 404  # other accounts never see it


def test_contacts_are_optional_and_private_accounts_hidden(seeded):
    ben = seeded.get("/v2/profile/test-ben/contacts").json()
    assert ben["accountId"] == "test-ben" and ben["github"].startswith("https://") and ben["discord"]
    assert seeded.get("/v2/profile/test-dee/contacts").json() == {"accountId": "test-dee"}
    assert seeded.get("/v2/profile/test-eli/contacts").status_code == 404
    assert seeded.get("/v2/profile/nobody/contacts").status_code == 404


# --- in demand: hiring fields from the dated job-posting snapshot -----------------------------------

FIELDS_SNAPSHOT = {
    "fieldsPulledAt": "2026-11-08", "fieldsMethod": "test",
    "sources": [{"id": "adzuna", "title": "Adzuna", "url": "https://www.adzuna.ca/"}],
    "skills": [],
    "fields": [{
        "id": "energy-data", "name": "Energy data analytics", "summary": "s", "rising": True, "wefSkill": "AI and big data",
        "postings": {"calgary": 40, "alberta": 47, "canada": 80, "count": 40, "where": "Calgary", "scope": "city",
                     "searchUrl": "https://www.adzuna.ca/search?q=analyst", "titleContains": "analyst"},
        "skills": [{"name": "Python", "share": 0.14, "mentions": 11, "concepts": ["loops", "functions"]},
                   {"name": "SQL", "share": 0.19, "mentions": 15, "concepts": ["sql-select", "sql-joins"]},
                   {"name": "Excel", "share": 0.57, "mentions": 46, "concepts": []}],
        "alsoAskedFor": [{"name": "Degree", "mentions": 55, "share": 0.69}],
        "tutorials": [{"videoId": "vV12dGe_Fho", "url": "https://www.youtube.com/watch?v=vV12dGe_Fho", "title": "t",
                       "codingChallenges": 4, "firstChallenge": {"atS": 327, "title": "Extract the hour"}}],
    }],
}


def test_fields_show_the_learners_level_per_skill_chip(empty):
    skills.set_source(lambda: FIELDS_SNAPSHOT)
    try:
        empty.post("/v2/events", json={"events": [_pass(1, "functions", NOW), _pass(2, "functions", NOW)]})
        body = empty.get("/v2/skills/fields", params={"accountId": "test-x", **NOW_Q}).json()
        assert body["pulledAt"] == "2026-11-08" and len(body["fields"]) == 1
        f = body["fields"][0]
        assert f["postings"]["calgary"] == 40 and f["rising"] is True and f["tutorials"][0]["codingChallenges"] == 4
        chips = {c["name"]: c for c in f["skills"]}
        assert chips["Python"]["tracked"] and chips["Python"]["level"]["concept"] == "functions"
        assert chips["Python"]["level"]["levelName"] == "Beginner II"  # 75 XP across two first-try passes
        assert chips["SQL"]["tracked"] and chips["SQL"]["level"] is None  # not started
        assert chips["Excel"]["tracked"] is False and chips["Excel"]["level"] is None  # a tool Breakpoint doesn't teach
        anon = empty.get("/v2/skills/fields").json()["fields"][0]
        assert all(c["level"] is None for c in anon["skills"])
    finally:
        skills.set_source(skills.file_source())


def test_fields_are_empty_before_the_first_pull(empty):
    skills.set_source(lambda: {"skills": []})
    try:
        assert empty.get("/v2/skills/fields").json() == {"pulledAt": None, "method": None, "sources": [], "fields": []}
    finally:
        skills.set_source(skills.file_source())


def test_shipped_snapshot_has_dated_fields_with_verified_tutorials():
    data = json.loads((Path(__file__).resolve().parents[1] / "content" / "skills" / "in-demand.json").read_text(encoding="utf-8"))
    assert data["fieldsPulledAt"] and 3 <= len(data["fields"]) <= 5
    for f in data["fields"]:
        assert f["postings"]["searchUrl"].startswith("https://www.adzuna.ca/search?")
        assert f["skills"] and all(0 <= s["share"] <= 1 for s in f["skills"])
        assert all(r["share"] >= 0.10 for r in f["alsoAskedFor"])
        assert all(t["codingChallenges"] > 0 and t["url"].startswith("https://www.youtube.com/watch?v=") for t in f["tutorials"])
    assert data["skills"], "the old hand-picked list stays as the fallback card"
