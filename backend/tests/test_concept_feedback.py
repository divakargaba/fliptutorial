"""Concept-answer feedback: a wrong answer names the misconception without revealing the answer;
a correct answer explains why using the planner's stored explanation.

Offline: the model is always stubbed and the planner lookup is patched.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.feedback import register_question
from app.feedback.concepts import (
    explain_wrong_answer,
    grade_multiple_choice,
    grade_predict_output,
)

DIJKSTRA_PROMPT = (
    "In Dijkstra's algorithm, vertex U has a current distance of 2 and the edge from U to V costs 1. "
    "V's current distance is Infinity because it hasn't been reached yet. After relaxing the edge U to V, "
    "what is V's distance?"
)
DIJKSTRA_CHOICES = [{"id": "a", "text": "1"}, {"id": "b", "text": "2"}, {"id": "c", "text": "3"},
                    {"id": "d", "text": "Infinity"}]
DIJKSTRA_EXPLANATION = "Relaxation sets dist(V) to dist(U) + w(U, V) = 2 + 1 = 3 because that is less than Infinity."


def stub(payload: dict | str):
    async def call(prompt: str) -> str:
        return payload if isinstance(payload, str) else json.dumps(payload)
    return call


async def failing(prompt: str) -> str:
    raise RuntimeError("model down")


GOOD_COACHING = {
    "misconception": "Used the edge cost alone",
    "whyWrong": "You picked 1, which is only the cost of the edge from U to V.",
    "nextStep": "Relaxation looks at the whole path through U, so combine U's distance with the edge cost.",
}


def _dijkstra(**kw):
    return dict(style="multiple_choice", prompt=DIJKSTRA_PROMPT, learner_answer="a", correct_answer="c",
                explanation=DIJKSTRA_EXPLANATION, choices=DIJKSTRA_CHOICES, concept_name="Graphs", **kw)


# --- deterministic graders never reveal the answer --------------------------------------------


def test_mc_wrong_does_not_name_the_answer():
    r = grade_multiple_choice("a", "c")
    assert not r.correct
    assert "c" not in r.explanation.lower().split() and "correct answer" not in r.explanation.lower()


def test_predict_output_wrong_does_not_reveal_expected():
    r = grade_predict_output("1 2 3", "0 1 2")
    assert not r.correct and "0 1 2" not in r.explanation


# --- explain_wrong_answer ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_coaching_uses_model_output():
    fb = await explain_wrong_answer(**_dijkstra(model_call=stub(GOOD_COACHING)))
    assert fb.aiGenerated
    assert fb.misconception == "Used the edge cost alone"
    assert fb.whyWrong.startswith("You picked 1")


@pytest.mark.asyncio
async def test_model_prompt_marks_answer_private_and_names_pick():
    seen = {}

    async def capture(prompt: str) -> str:
        seen["prompt"] = prompt
        return json.dumps(GOOD_COACHING)

    await explain_wrong_answer(**_dijkstra(model_call=capture))
    assert "Learner's answer: 1" in seen["prompt"]
    assert "PRIVATE correct answer (never reveal): 3" in seen["prompt"]


@pytest.mark.parametrize("leak", [
    {**GOOD_COACHING, "whyWrong": "The correct answer is 3 because 2 + 1 = 3."},
    {**GOOD_COACHING, "nextStep": "Add them: you should get 3."},
    {**GOOD_COACHING, "nextStep": "Option c is what you want."},
])
@pytest.mark.asyncio
async def test_leaked_answer_falls_back(leak):
    fb = await explain_wrong_answer(**_dijkstra(model_call=stub(leak)))
    assert not fb.aiGenerated
    text = " ".join([fb.misconception, fb.whyWrong, fb.nextStep])
    assert " 3" not in text and "option c" not in text.lower()


@pytest.mark.asyncio
async def test_mentioning_question_values_is_not_a_leak():
    ok = {**GOOD_COACHING, "nextStep": "U is at distance 2 and the edge costs 1; what does the path through U cost?"}
    fb = await explain_wrong_answer(**_dijkstra(model_call=stub(ok)))
    assert fb.aiGenerated


@pytest.mark.parametrize("call", [failing, stub("not json"), stub({"misconception": "", "whyWrong": "x",
                                                                   "nextStep": "y"})])
@pytest.mark.asyncio
async def test_model_failure_falls_back_without_revealing(call):
    fb = await explain_wrong_answer(**_dijkstra(model_call=call))
    assert not fb.aiGenerated
    assert '"1"' in fb.whyWrong  # names the learner's pick by its text, not its id
    assert " 3" not in fb.whyWrong + fb.nextStep


@pytest.mark.asyncio
async def test_predict_output_leak_falls_back():
    fb = await explain_wrong_answer(
        style="predict_output", prompt="print(sum([1, 2]))", learner_answer="12", correct_answer="3",
        model_call=stub({**GOOD_COACHING, "whyWrong": "It prints 3, not 12."}),
    )
    assert not fb.aiGenerated and "3" not in fb.whyWrong


# --- /v2/answer end to end --------------------------------------------------------------------


@dataclass
class FakePlannerQuestion:
    explanation: str


@pytest.fixture
def dijkstra_question():
    register_question(
        question_id="q-dijkstra-relax", revision="r-dijkstra-1", title="Dijkstra relaxation",
        style="multiple_choice", prompt=DIJKSTRA_PROMPT, concepts=["graphs", "greedy"],
        level="beginner-1", correct_answer="c", choices=DIJKSTRA_CHOICES,
    )
    return {"questionId": "q-dijkstra-relax", "revision": "r-dijkstra-1"}


async def _post(body: dict) -> dict:
    from app.main import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/v2/answer", json=body)
    assert resp.status_code == 200
    return resp.json()


@pytest.mark.asyncio
async def test_wrong_answer_coaches_misconception(dijkstra_question):
    with patch("app.feedback.concepts.anthropic_model_call", lambda *a, **k: stub(GOOD_COACHING)), \
         patch("app.planner.find_question", return_value=FakePlannerQuestion(DIJKSTRA_EXPLANATION)):
        data = await _post({**dijkstra_question, "answer": "a"})
    fb = data["feedback"]
    assert data["correct"] is False and fb["outcome"] == "failed" and fb["success"] is None
    assert fb["summary"] == GOOD_COACHING["whyWrong"]
    assert fb["diagnosis"]["misconception"]["name"] == "Used the edge cost alone"
    assert fb["diagnosis"]["misconception"]["explanation"] == GOOD_COACHING["nextStep"]
    assert fb["diagnosis"]["misconception"]["explanation"] != fb["summary"]  # no duplicated text
    assert fb["aiGenerated"] is True
    blob = json.dumps(fb)
    assert "correct answer is" not in blob.lower() and DIJKSTRA_EXPLANATION not in blob


@pytest.mark.asyncio
async def test_wrong_answer_without_model_still_teaches(dijkstra_question):
    with patch("app.feedback.concepts.anthropic_model_call", lambda *a, **k: failing):
        data = await _post({**dijkstra_question, "answer": "a"})
    fb = data["feedback"]
    assert fb["outcome"] == "failed" and fb["aiGenerated"] is False
    assert fb["summary"] == '"1" isn\'t the answer.'
    assert "Graphs" in fb["diagnosis"]["misconception"]["explanation"]
    assert "correct answer is" not in json.dumps(fb).lower()


@pytest.mark.asyncio
async def test_correct_answer_uses_planner_explanation(dijkstra_question):
    with patch("app.planner.find_question", return_value=FakePlannerQuestion(DIJKSTRA_EXPLANATION)):
        data = await _post({**dijkstra_question, "answer": "c"})
    fb = data["feedback"]
    assert data["correct"] is True and fb["diagnosis"] is None
    assert fb["summary"] == DIJKSTRA_EXPLANATION
    assert fb["success"]["explanation"] == DIJKSTRA_EXPLANATION
    assert fb["success"]["optimization"]["show"] is False
