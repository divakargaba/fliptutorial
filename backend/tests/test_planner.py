"""Lane A1 planner: offline tests with stubbed Claude, Judge0 and captions."""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import planner as planner_api
from app.planner.classify import Numberer, PauseSlot, Section, WindowOut, make_blocks, pause_cap
from app.planner.generate import QuestionOut
from app.planner.service import Planner, PlanStore
from app.testme import GenOutput
from app.transcripts import Cue, Transcript, TranscriptError, cue_id_for

CONTRACTS_V2 = Path(__file__).resolve().parents[2] / "contracts" / "v2"
SECRET_KEYS = ("answer", "explanation", "referenceSolution", "knownWrongSolution", "hiddenTests", "functionName")


# ---------------------------------------------------------------------------
# Synthetic video: intro (0-120 s), Python loops (120-900 s), theory (900-1800 s)
# ---------------------------------------------------------------------------


def cue_text(t: int) -> str:
    if t < 120:
        return f"welcome back to the channel, smash subscribe {t}"
    if t == 410:
        return "can you write a function that adds the numbers from one to n?"
    if 420 <= t < 440:
        return f"ANSWER_REVEALED the solution is total plus equals i {t}"
    if t < 900:
        return f"in python a for loop repeats the body for each item in range {t}"
    return f"big o notation describes how the running time grows with n {t}"


def make_transcript(duration: int = 1800, video_id: str = "vidPlanner1", fn=cue_text) -> Transcript:
    cues = tuple(Cue(cue_id_for(t), float(t), float(t + 5), fn(t)) for t in range(0, duration, 5))
    return Transcript(video_id, "manual", "en", "Python loops and Big O", cues)


def blk(t: int) -> str:
    return f"b{t // 20}"


def coding_window() -> dict:
    return {
        "videoIsAboutProgramming": True,
        "reason": "A Python tutorial on loops followed by complexity theory.",
        "sections": [
            {"startBlock": "b0", "endBlock": "b5", "title": "Intro", "format": "off_topic", "language": "unknown",
             "languageEvidence": "", "concepts": [], "qualifies": False, "confidence": "high",
             "evidenceBlocks": ["b0"], "pauses": []},
            {"startBlock": "b6", "endBlock": "b44", "title": "For loops", "format": "code", "language": "Python",
             "languageEvidence": "in python a for loop", "concepts": ["loops", "not-a-concept"], "qualifies": True,
             "confidence": "high", "evidenceBlocks": [blk(200), "b999"],
             "pauses": [
                 {"afterBlock": blk(410), "trigger": "question_posed", "answerBlock": blk(420), "concept": "loops",
                  "idea": "sum the numbers 1..n with a loop", "importance": 1},
                 {"afterBlock": blk(700), "trigger": "demonstration", "answerBlock": "", "concept": "loops",
                  "idea": "loop with a running total -> count matches", "importance": 2},
                 {"afterBlock": blk(720), "trigger": "demonstration", "answerBlock": "", "concept": "loops",
                  "idea": "too close to the previous pause", "importance": 3},
             ]},
            {"startBlock": "b999", "endBlock": "b1000", "title": "Bogus", "format": "code", "language": "python",
             "languageEvidence": "", "concepts": [], "qualifies": True, "confidence": "high",
             "evidenceBlocks": [], "pauses": []},
            {"startBlock": "b45", "endBlock": "b89", "title": "Big O", "format": "theory", "language": "pseudocode",
             "languageEvidence": "", "concepts": ["complexity"], "qualifies": True, "confidence": "high",
             "evidenceBlocks": [blk(1000)],
             "pauses": [{"afterBlock": blk(1200), "trigger": "concept_complete", "answerBlock": "",
                         "concept": "complexity", "idea": "growth of a single loop", "importance": 1}]},
        ],
    }


GOOD_EXERCISE = {
    "status": "ok", "language": "python", "languageEvidence": "def", "title": "Sum to n",
    "statement": "Write sum_to(n) that returns 1 + 2 + ... + n using a loop.", "functionName": "sum_to",
    "starterCode": "def sum_to(n):\n    pass\n",
    "referenceSolution": "def sum_to(n):\n    total = 0\n    for i in range(1, n + 1):\n        total += i\n    return total\n",
    "examples": [{"argsJson": "[3]", "expectedJson": "6"}],
    "hiddenTests": [{"argsJson": "[1]", "expectedJson": "1"}, {"argsJson": "[0]", "expectedJson": "0"},
                    {"argsJson": "[5]", "expectedJson": "15"}],
    "wrongMistake": "off by one", "wrongFailsOnArgsJson": "[5]",
    "knownWrongSolution": "def sum_to(n):\n    total = 0\n    for i in range(1, n):\n        total += i\n    return total\n",
    "conceptTags": ["loops"], "conceptEvidenceCueIds": [],
}

GOOD_QUESTION = {
    "status": "ok", "title": "Growth of one loop", "style": "multiple_choice",
    "prompt": "A loop runs once per item in a list of n items. How does its running time grow?",
    "choices": [{"id": "a", "text": "O(1)"}, {"id": "b", "text": "O(n)"}, {"id": "c", "text": "O(n^2)"}],
    "answer": "b", "explanation": "One step per item.", "concepts": ["complexity"], "evidenceCueIds": [],
}


class StubModel:
    def __init__(self, window=coding_window, exercise=GOOD_EXERCISE, question=GOOD_QUESTION):
        self.window, self.exercise, self.question = window, exercise, question
        self.calls: list[tuple[str, str]] = []

    async def __call__(self, prompt: str, model) -> str:
        self.calls.append((model.__name__, prompt))
        await asyncio.sleep(0)
        first_cue = re.search(r"\[(c\d{8})\]", prompt)
        if model is WindowOut:
            return json.dumps(self.window())
        if model is GenOutput:
            return json.dumps({**self.exercise, "conceptEvidenceCueIds": [first_cue.group(1)]})
        if model is QuestionOut:
            return json.dumps({**self.question, "evidenceCueIds": [first_cue.group(1)]})
        raise AssertionError(model)

    def count(self, name: str) -> int:
        return sum(1 for n, _ in self.calls if n == name)


def make_planner(tmp_path, model=None, verify_ok=True, transcript=None, fetch=None) -> Planner:
    transcript = transcript or make_transcript()

    async def default_fetch(video_id: str) -> Transcript:
        return transcript

    async def verify(ex) -> bool:
        return verify_ok

    return Planner(fetch_transcript=fetch or default_fetch, model_call=model or StubModel(), verify=verify,
                   store=PlanStore(tmp_path))


async def run_to_ready(p: Planner, video_id="vidPlanner1", level="beginner-1") -> tuple[dict, dict]:
    first = p.request(video_id, level)
    await p.wait_idle()
    return first, p.request(video_id, level)


def assert_no_secrets(obj) -> None:
    text = json.dumps(obj)
    for key in SECRET_KEYS:
        assert f'"{key}"' not in text, key


# ---------------------------------------------------------------------------
# Plan lifecycle
# ---------------------------------------------------------------------------


def test_plan_starts_planning_then_ready(tmp_path):
    first, plan = asyncio.run(run_to_ready(make_planner(tmp_path)))
    assert first["status"] == "planning"
    assert first["pauses"] == []
    assert plan["status"] == "ready"
    assert plan["verdict"]["qualifies"] is True
    assert plan["verdict"]["evidence"]

    secs = plan["sections"]
    assert [s["id"] for s in secs] == ["s1", "s2", "s3"]  # bogus section with unknown blocks dropped
    intro, loops, theory = secs
    assert intro["qualifies"] is False and intro["format"] == "off_topic"
    assert loops["language"] == "python" and loops["concepts"] == ["loops"]
    assert theory["format"] == "theory" and theory["language"] == "pseudocode"
    # evidence text is copied from the real captions, never from the model
    assert loops["evidence"] and all("for loop" in e["text"] for e in loops["evidence"])


def test_pauses_ranked_spaced_and_before_answer(tmp_path):
    _, plan = asyncio.run(run_to_ready(make_planner(tmp_path)))
    pauses = plan["pauses"]
    assert [p["id"] for p in pauses] == ["p1", "p2", "p3"]  # the pause 20 s after another was dropped
    q, demo, theory = pauses
    assert q["sectionId"] == "s2" and q["kind"] == "coding" and q["rank"] == 1
    assert q["pauseAtS"] == 415.0  # end of the cue that asks the question
    assert q["revealAtS"] == 420.0 and q["pauseAtS"] < q["revealAtS"]
    assert demo["rank"] == 2 and demo["revealAtS"] is None
    assert theory["kind"] == "concept" and theory["rank"] == 1
    assert all(p["ready"] for p in pauses)
    ex = q["exercise"]
    assert ex["language"] == "python" and ex["aiGenerated"] is True and ex["level"] == "beginner-1"
    assert ex["examples"] == [{"args": [3], "expected": 6}]
    question = theory["question"]
    assert question["style"] == "multiple_choice" and len(question["choices"]) == 3
    assert_no_secrets(plan)


def test_plan_matches_contract_fixture_shape(tmp_path):
    _, plan = asyncio.run(run_to_ready(make_planner(tmp_path)))
    fixture = json.loads((CONTRACTS_V2 / "exercise-plan.fixture.json").read_text())
    assert set(plan) == set(fixture)
    assert set(plan["verdict"]) == set(fixture["verdict"])
    assert set(plan["sections"][0]) == set(fixture["sections"][0])
    fx_coding, fx_concept = fixture["pauses"][0], fixture["pauses"][1]
    coding = next(p for p in plan["pauses"] if p["kind"] == "coding")
    concept = next(p for p in plan["pauses"] if p["kind"] == "concept")
    assert set(coding) == set(fx_coding) and set(coding["exercise"]) == set(fx_coding["exercise"])
    assert set(concept) == set(fx_concept) and set(concept["question"]) == set(fx_concept["question"])


def test_generation_sees_only_captions_before_the_pause(tmp_path):
    model = StubModel()
    asyncio.run(run_to_ready(make_planner(tmp_path, model=model)))
    gen_prompts = [p for n, p in model.calls if n == "GenOutput"]
    assert gen_prompts
    first = next(p for p in gen_prompts if "sum the numbers" in p)
    assert "ANSWER_REVEALED" not in first
    assert "can you write a function" in first


def test_private_items_found_for_grading(tmp_path):
    p = make_planner(tmp_path)
    _, plan = asyncio.run(run_to_ready(p))
    ex_id = plan["pauses"][0]["exercise"]["id"]
    priv = p.find_exercise(ex_id)
    assert priv and priv.exercise.functionName == "sum_to" and len(priv.exercise.hiddenTests) == 3
    assert priv.revision == plan["pauses"][0]["exercise"]["revision"]
    q_id = plan["pauses"][2]["question"]["id"]
    q = p.find_question(q_id)
    assert q and q.answer == "b"
    assert p.find_exercise("nope") is None and p.find_question("nope") is None


def test_cached_plan_is_instant_for_next_viewer(tmp_path):
    asyncio.run(run_to_ready(make_planner(tmp_path)))
    model = StubModel()

    async def fresh():
        p2 = make_planner(tmp_path, model=model)
        plan = p2.request("vidPlanner1", "beginner-3")  # same tier: beginner
        found = p2.find_exercise(plan["pauses"][0]["exercise"]["id"])
        return plan, found

    plan, found = asyncio.run(fresh())
    assert plan["status"] == "ready" and all(p["ready"] for p in plan["pauses"])
    assert plan["learnerLevel"] == "beginner-3"
    assert model.calls == []
    assert found is not None
    assert (tmp_path / "vidPlanner1.json").exists()


def test_new_tier_reuses_classification(tmp_path):
    p = make_planner(tmp_path)
    asyncio.run(run_to_ready(p))
    model = StubModel()
    p.model_call = model

    async def go():
        first = p.request("vidPlanner1", "intermediate-1")
        await p.wait_idle()
        return first, p.request("vidPlanner1", "intermediate-1")

    first, plan = asyncio.run(go())
    assert first["status"] == "planning" and first["sections"]  # sections known, items pending
    assert all(not x["ready"] for x in first["pauses"])
    assert plan["status"] == "ready"
    assert model.count("WindowOut") == 0
    assert plan["pauses"][0]["exercise"]["level"].startswith("intermediate")
    assert any("intermediate" in prompt for _, prompt in model.calls)


def test_earliest_window_pauses_ready_before_later_windows(tmp_path):
    # 90-minute video = 3 windows; block until the 2nd window is classified
    gate = asyncio.Event()
    model = StubModel()
    real = model.__call__

    async def gated(prompt, out_model):
        if out_model is WindowOut and model.count("WindowOut") >= 1:
            await gate.wait()
        return await real(prompt, out_model)

    async def go():
        p = make_planner(tmp_path, model=gated, transcript=make_transcript(5400))
        p.request("vidPlanner1", "beginner-1")
        for _ in range(200):
            await asyncio.sleep(0)
        mid = p.request("vidPlanner1", "beginner-1")
        gate.set()
        await p.wait_idle()
        return mid, p.request("vidPlanner1", "beginner-1")

    mid, final = asyncio.run(go())
    assert mid["status"] == "planning"
    assert mid["pauses"] and all(x["ready"] for x in mid["pauses"])  # window 1 already playable
    assert mid["verdict"]["qualifies"] is True and mid["verdict"]["evidence"]
    assert "Python tutorial" in mid["verdict"]["reason"]
    assert final["status"] == "ready"
    ids = [x["id"] for x in final["pauses"]]
    assert ids[: len(mid["pauses"])] == [x["id"] for x in mid["pauses"]]  # ids stay stable


# ---------------------------------------------------------------------------
# Verdicts and failures
# ---------------------------------------------------------------------------


def not_coding_window() -> dict:
    return {"videoIsAboutProgramming": False, "reason": "A music video; no programming is taught.",
            "sections": [{"startBlock": "b0", "endBlock": "b8", "title": "Song", "format": "off_topic",
                          "language": "unknown", "languageEvidence": "", "concepts": [], "qualifies": False,
                          "confidence": "high", "evidenceBlocks": ["b1"], "pauses": []}]}


def test_not_coding_video(tmp_path):
    model = StubModel(window=not_coding_window)
    transcript = make_transcript(5400, fn=lambda t: f"we're no strangers to love {t}")
    _, plan = asyncio.run(run_to_ready(make_planner(tmp_path, model=model, transcript=transcript)))
    assert plan["status"] == "not_coding"
    assert plan["verdict"]["qualifies"] is False and "music" in plan["verdict"]["reason"].lower()
    assert plan["verdict"]["evidence"][0]["text"].startswith("we're no strangers")
    assert plan["pauses"] == []
    assert model.count("WindowOut") == 1  # stopped after the first window
    assert model.count("GenOutput") == model.count("QuestionOut") == 0


def test_code_mentioning_vlog_does_not_qualify(tmp_path):
    def vlog():
        w = not_coding_window()
        w["videoIsAboutProgramming"] = True  # talks about programming careers
        w["sections"][0].update(format="theory", qualifies=True, confidence="low")
        return w

    _, plan = asyncio.run(run_to_ready(make_planner(tmp_path, model=StubModel(window=vlog))))
    assert plan["status"] == "not_coding"


def test_no_captions(tmp_path):
    async def fetch(video_id):
        raise TranscriptError("NO_CAPTIONS", "none")

    _, plan = asyncio.run(run_to_ready(make_planner(tmp_path, fetch=fetch)))
    assert plan["status"] == "no_captions" and plan["pauses"] == [] and plan["sections"] == []
    assert not (tmp_path / "vidPlanner1.json").exists()


def test_failed_verify_falls_back_to_concept_question(tmp_path):
    _, plan = asyncio.run(run_to_ready(make_planner(tmp_path, verify_ok=False)))
    assert plan["status"] == "ready"
    assert all(p["kind"] == "concept" and p["question"] for p in plan["pauses"])


def test_bad_items_are_dropped_not_shown(tmp_path):
    bad_q = {**GOOD_QUESTION, "answer": "z"}
    model = StubModel(exercise={**GOOD_EXERCISE, "functionName": "not valid"}, question=bad_q)
    _, plan = asyncio.run(run_to_ready(make_planner(tmp_path, model=model)))
    assert plan["status"] == "ready" and plan["pauses"] == []
    assert plan["verdict"]["qualifies"] is True


def test_model_unavailable_is_error_and_not_cached(tmp_path):
    from app.planner.service import PlannerUnavailable

    async def broken(prompt, model):
        raise PlannerUnavailable("Planner unavailable: ANTHROPIC_API_KEY is not set.")

    _, plan = asyncio.run(run_to_ready(make_planner(tmp_path, model=broken)))
    assert plan["status"] == "error" and "ANTHROPIC_API_KEY" in plan["verdict"]["reason"]
    assert not (tmp_path / "vidPlanner1.json").exists()


def test_hourly_new_video_limit(tmp_path):
    async def go():
        p = make_planner(tmp_path)
        p.max_new_videos_per_hour = 1
        a = p.request("vidPlanner1", "beginner-1")
        b = p.request("vidPlanner2", "beginner-1")
        await p.wait_idle()
        return a, b

    a, b = asyncio.run(go())
    assert a["status"] == "planning" and b["status"] == "error"


# ---------------------------------------------------------------------------
# Ranking / cap units
# ---------------------------------------------------------------------------


def _section(pauses):
    s = Section(0, 600, "t", "code", "python", ["loops"], True, "high", [])
    s.pauses = pauses
    return s


def test_pause_cap_scales_with_length():
    assert pause_cap(60) == 2 and pause_cap(1800) == 5 and pause_cap(36000) == 30


def test_numberer_cap_keeps_best_ranked():
    slots = [PauseSlot(0, 100.0 + 70 * i, None, "demonstration", "loops", f"i{i}", 3) for i in range(6)]
    slots[4].importance = 1
    kept = Numberer().add([_section(slots)], window_s=300)  # cap 2
    assert len(kept) == 2 and slots[4] in kept
    assert slots[4].rank == 1
    assert [p.id for p in kept] == ["p1", "p2"]


def test_learner_levels_set_level_per_pause_concept(tmp_path):
    model = StubModel()
    p = make_planner(tmp_path, model=model)
    levels = {"loops": "intermediate-2"}

    async def go():
        p.request("vidPlanner1", "beginner-1", levels)
        await p.wait_idle()
        return p.request("vidPlanner1", "beginner-1", levels)

    plan = asyncio.run(go())
    assert plan["status"] == "ready" and plan["learnerLevel"] == "beginner-1"
    coding = [x for x in plan["pauses"] if x["kind"] == "coding"]
    concept = [x for x in plan["pauses"] if x["kind"] == "concept"]
    assert coding and all(x["exercise"]["level"].startswith("intermediate") for x in coding)
    assert concept and all(x["question"]["level"].startswith("beginner") for x in concept)
    # Only the wanted tier per concept is generated: no beginner loops items, no intermediate complexity items.
    assert model.count("GenOutput") == len(coding) and model.count("QuestionOut") == len(concept)
    assert p.peek("vidPlanner1") == plan  # GET without a level uses the latest POST's levels


def test_widening_learner_levels_generates_only_new_items(tmp_path):
    p = make_planner(tmp_path)
    asyncio.run(run_to_ready(p))
    model = StubModel()
    p.model_call = model

    async def go():
        first = p.request("vidPlanner1", "beginner-1", {"complexity": "advanced-1"})
        await p.wait_idle()
        return first, p.request("vidPlanner1", "beginner-1", {"complexity": "advanced-1"})

    first, plan = asyncio.run(go())
    assert first["status"] == "planning"
    assert plan["status"] == "ready"
    q = next(x for x in plan["pauses"] if x["kind"] == "concept")
    assert q["question"]["level"].startswith("advanced")
    assert model.count("QuestionOut") == 1 and model.count("GenOutput") == 0 and model.count("WindowOut") == 0
    assert p.request("vidPlanner1", "beginner-1")["status"] == "ready"  # beginner items still cached


def test_make_blocks_groups_cues():
    blocks = make_blocks(make_transcript(100))
    assert [b.id for b in blocks] == ["b0", "b1", "b2", "b3", "b4"]
    assert blocks[1].start_s == 20.0


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


@pytest.fixture()
def client(tmp_path):
    from app.main import app

    planner_api.set_planner(make_planner(tmp_path))
    with TestClient(app) as c:
        yield c
    planner_api.set_planner(None)


def test_api_validation_and_get(client):
    assert client.post("/v2/plan", json={"videoId": "bad id"}).status_code == 422
    r = client.post("/v2/plan", json={"videoId": "vidPlanner1", "learnerLevel": "wizard-9"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "INVALID_LEVEL"
    r = client.get("/v2/plan/vidUnknown1")
    assert r.status_code == 404 and r.json()["error"]["code"] == "PLAN_NOT_FOUND"

    r = client.post("/v2/plan", json={"videoId": "vidPlanner1"})
    assert r.status_code == 200
    body = r.json()
    assert body["schemaVersion"] == 2 and body["learnerLevel"] == "beginner-1"
    assert body["status"] in ("planning", "ready")
    g = client.get("/v2/plan/vidPlanner1")
    assert g.status_code == 200 and g.json()["videoId"] == "vidPlanner1"

    r = client.post("/v2/plan", json={"videoId": "vidPlanner1", "learnerLevels": {"loops": "wizard-9"}})
    assert r.status_code == 422 and r.json()["error"]["code"] == "INVALID_LEVEL"
    r = client.post("/v2/plan", json={"videoId": "vidPlanner1", "learnerLevel": "beginner-2",
                                      "learnerLevels": {"loops": "advanced-1", "not-a-concept": "expert-1"}})
    assert r.status_code == 200 and r.json()["learnerLevel"] == "beginner-2"
    assert client.get("/v2/plan/vidPlanner1").json()["learnerLevel"] == "beginner-2"
