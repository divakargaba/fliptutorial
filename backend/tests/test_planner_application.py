"""Theory = application: theory pauses try a coding exercise first (in Python), concept questions
apply the idea to a new input (multiple choice only as the fallback), and wrong choices carry private
why-wrong notes that /v2/answer serves without a model call. Offline (stubbed model / planner)."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.feedback import register_question
from app.feedback.concepts import explain_wrong_answer
from app.planner import generate
from app.planner.classify import Section
from app.planner.generate import PrivateQuestion, QuestionOut, check_question, coding_language_for
from app.planner.service import planned_kind
from app.testme import _CheckFailed
from app.transcripts import Clip, Cue

from tests.test_planner import GOOD_QUESTION, StubModel, assert_no_secrets, make_planner, run_to_ready


def section(fmt: str, language: str) -> Section:
    return Section(0.0, 60.0, "s", fmt, language, ["complexity"], True, "high", [])


@pytest.mark.parametrize("fmt,language,expected", [
    ("code", "python", "python"),
    ("mixed", "python", "python"),
    ("theory", "pseudocode", "python"),   # theory: implement the idea
    ("theory", "unknown", "python"),
    ("theory", "python", "python"),
    ("code", "pseudocode", "python"),     # language-neutral code
    ("code", "rust", None),               # no grader yet -> application question
    ("off_topic", "python", None),
])
def test_coding_language_for(fmt, language, expected, monkeypatch):
    monkeypatch.setattr(generate, "coding_languages", lambda: ("python",))
    assert coding_language_for(section(fmt, language)) == expected
    assert planned_kind(section(fmt, language), None) == ("coding" if expected else "concept")


def test_gradable_language_keeps_its_own_language(monkeypatch):
    monkeypatch.setattr(generate, "coding_languages", lambda: ("python", "javascript", "java", "cpp"))
    assert coding_language_for(section("code", "javascript")) == "javascript"
    assert coding_language_for(section("theory", "java")) == "java"


def test_codeable_theory_becomes_a_python_coding_exercise(tmp_path):
    model = StubModel(theory_codeable=True)
    _, plan = asyncio.run(run_to_ready(make_planner(tmp_path, model=model)))
    theory = plan["pauses"][-1]
    assert theory["sectionId"] != plan["pauses"][0]["sectionId"]
    assert theory["kind"] == "coding" and theory["exercise"]["language"] == "python"
    prompts = [pr for n, pr in model.calls if n == "GenOutput" and "growth of a single loop" in pr]
    assert prompts and "APPLY it" in prompts[0] and 'language is "python"' in prompts[0]
    assert model.count("QuestionOut") == 0
    assert_no_secrets(plan)


def test_uncodeable_theory_falls_back_to_a_question(tmp_path):
    model = StubModel()  # noExercise for theory
    _, plan = asyncio.run(run_to_ready(make_planner(tmp_path, model=model)))
    assert plan["pauses"][-1]["kind"] == "concept"


# --- application-first questions -------------------------------------------------------------

CLIP = Clip("vid", "manual", "Graphs", 5.0, 0.0, (Cue("c00000001", 0.0, 5.0, "relaxation updates a distance"),))


def q(**over) -> QuestionOut:
    return QuestionOut.model_validate({**GOOD_QUESTION, "evidenceCueIds": ["c00000001"], **over})


def test_bare_multiple_choice_is_rejected_until_the_last_attempt():
    bare = q(mcReason="")
    with pytest.raises(_CheckFailed, match="apply the idea"):
        check_question(bare, CLIP, "pq-1", "r-1", "beginner-1", ["graphs"])
    assert check_question(bare, CLIP, "pq-1", "r-1", "beginner-1", ["graphs"], allow_bare_mc=True).style == "multiple_choice"


def test_application_short_answer_is_accepted_first_time():
    out = q(style="short_answer", choices=[], answer="3 (2 + 1)", mcReason="",
            prompt="U has distance 2 and the edge U->V costs 1; V is at Infinity. What is V's distance after relaxing U->V?")
    pq = check_question(out, CLIP, "pq-1", "r-1", "beginner-1", ["graphs"])
    assert pq.style == "short_answer" and pq.choice_notes == {} and pq.retry_hint


def test_prompt_asks_for_application_and_notes():
    pr = generate.question_prompt(CLIP, section("theory", "pseudocode"), _slot(), "beginner", None)
    assert "APPLY the idea" in pr and "last resort" in pr and "whyWrong" in pr and "retryHint" in pr


def _slot():
    from app.planner.classify import PauseSlot
    return PauseSlot(section_index=0, pause_at_s=5.0, reveal_at_s=None, trigger="concept_complete",
                     concept="graphs", idea="relaxation", importance=1, id="p1", rank=1)


def test_notes_stay_private_and_survive_the_cache():
    pq = check_question(q(), CLIP, "pq-1", "r-1", "beginner-1", ["complexity"])
    assert set(pq.choice_notes) == {"a", "c"} and "b" not in pq.choice_notes  # never for the correct choice
    assert pq.retry_hint
    public = json.dumps(pq.public())
    assert "mistake" not in public and "whyWrong" not in public and pq.retry_hint not in public
    again = PrivateQuestion.load(json.loads(json.dumps(pq.dump())))
    assert again.choice_notes == pq.choice_notes and again.retry_hint == pq.retry_hint
    old = {k: v for k, v in pq.dump().items() if k not in ("choiceNotes", "retryHint")}  # pre-change cache file
    assert PrivateQuestion.load(old).choice_notes == {} and PrivateQuestion.load(old).retry_hint == ""


def test_incomplete_or_correct_choice_notes_are_dropped():
    out = q(choices=[{"id": "a", "text": "O(1)", "mistake": "", "whyWrong": "half a note"},
                     {"id": "b", "text": "O(n)", "mistake": "x", "whyWrong": "y"},
                     {"id": "c", "text": "O(n^2)", "mistake": "Nested loop", "whyWrong": "Only one loop."}])
    assert check_question(out, CLIP, "pq-1", "r-1", "beginner-1", ["complexity"]).choice_notes == {
        "c": {"mistake": "Nested loop", "whyWrong": "Only one loop."}}


# --- /v2/answer serves the stored notes ------------------------------------------------------

PROMPT = "U has distance 2 and the edge U->V costs 1; V is at Infinity. What is V's distance after relaxing U->V?"
CHOICES = [{"id": "a", "text": "1"}, {"id": "b", "text": "2"}, {"id": "c", "text": "3"}, {"id": "d", "text": "Infinity"}]
NOTES = {"a": {"mistake": "Used the edge cost alone", "whyWrong": "1 is only the edge from U to V."},
         "d": {"mistake": "Skipped the update", "whyWrong": "Any real path beats Infinity, so V must change."}}


@pytest.mark.asyncio
async def test_stored_note_is_served_without_a_model_call():
    async def must_not_call(prompt: str) -> str:
        raise AssertionError("model called")
    fb = await explain_wrong_answer(style="multiple_choice", prompt=PROMPT, learner_answer="a", correct_answer="c",
                                    choices=CHOICES, choice_notes=NOTES, retry_hint="Add U's distance and the edge.",
                                    model_call=must_not_call)
    assert fb.misconception == "Used the edge cost alone" and fb.nextStep == "Add U's distance and the edge."


@pytest.mark.asyncio
async def test_leaky_note_or_hint_is_not_served():
    leaky = {"a": {"mistake": "Wrong sum", "whyWrong": "It should be 3."}}
    fb = await explain_wrong_answer(style="multiple_choice", prompt=PROMPT, learner_answer="a", correct_answer="c",
                                    choices=CHOICES, choice_notes=leaky, retry_hint="The answer is 3.",
                                    model_call=lambda p: (_ for _ in ()).throw(RuntimeError("down")))
    assert not fb.aiGenerated and "3" not in fb.whyWrong + fb.nextStep


class FakePriv:
    def __init__(self):
        self.explanation = "2 + 1 = 3 beats Infinity."
        self.choice_notes = NOTES
        self.retry_hint = "Add U's distance and the edge cost."


@pytest.mark.asyncio
async def test_answer_endpoint_uses_planner_notes():
    register_question(question_id="pq-relax-1", revision="r-relax-1", title="Relax", style="multiple_choice",
                      prompt=PROMPT, concepts=["graphs"], level="beginner-1", correct_answer="c", choices=CHOICES)

    async def must_not_call(prompt: str) -> str:
        raise AssertionError("model called")

    from app.main import app
    with patch("app.planner.find_question", return_value=FakePriv()), \
         patch("app.feedback.concepts.anthropic_model_call", lambda *a, **k: must_not_call):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post("/v2/answer", json={"questionId": "pq-relax-1", "revision": "r-relax-1", "answer": "d"})
    fb = resp.json()["feedback"]
    assert fb["outcome"] == "failed" and fb["summary"] == NOTES["d"]["whyWrong"]
    assert fb["diagnosis"]["misconception"]["name"] == "Skipped the update"
    assert fb["diagnosis"]["misconception"]["explanation"] == "Add U's distance and the edge cost."
