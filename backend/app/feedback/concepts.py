"""Concept question grader: multiple choice, short answer, predict-output.

Multiple-choice and predict-output are graded deterministically against the
answer key stored server-side in the exercise plan. Short-answer questions use
Claude with a rubric for partial credit.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, Awaitable, Callable

from pydantic import BaseModel

logger = logging.getLogger("breakpoint.feedback.concepts")

BACKEND_DIR = __import__("pathlib").Path(__file__).resolve().parent.parent.parent
DEFAULT_MODEL = "claude-haiku-5-5"
BUDGET_S = 8.0

ModelCall = Callable[[str], Awaitable[str]]


class ConceptResult(BaseModel):
    correct: bool
    explanation: str
    aiGenerated: bool


SHORT_ANSWER_SCHEMA = {
    "type": "object",
    "properties": {
        "correct": {"type": "boolean", "description": "True if the answer is substantially correct."},
        "explanation": {"type": "string", "description": "1-2 sentences: why the answer is correct/incorrect."},
    },
    "required": ["correct", "explanation"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """You grade a learner's short answer to a concept question from a coding tutorial.
The correct answer is provided. Be lenient with phrasing and typos but strict on correctness.
If the answer captures the key idea, mark it correct even if the wording differs.
Explain briefly why it is right or wrong."""


def grade_multiple_choice(answer: str, correct_id: str) -> ConceptResult:
    """Grade a multiple-choice answer deterministically."""
    is_correct = answer.strip().lower() == correct_id.strip().lower()
    return ConceptResult(
        correct=is_correct,
        explanation=f"The correct answer is {correct_id}." if not is_correct else "Correct!",
        aiGenerated=False,
    )


def grade_predict_output(answer: str, expected_output: str) -> ConceptResult:
    """Grade a predict-output question by comparing the output string."""
    # Normalize whitespace
    norm_answer = " ".join(answer.strip().split())
    norm_expected = " ".join(expected_output.strip().split())
    is_correct = norm_answer == norm_expected
    return ConceptResult(
        correct=is_correct,
        explanation=f"Expected output: {expected_output}" if not is_correct else "Correct!",
        aiGenerated=False,
    )


def anthropic_model_call(model: str | None = None) -> ModelCall:
    try:
        from dotenv import load_dotenv
        load_dotenv(BACKEND_DIR / ".env")
    except ImportError:
        pass
    model_name = model or os.environ.get("ANTHROPIC_CONCEPT_MODEL") or DEFAULT_MODEL
    client = None

    async def call(prompt: str) -> str:
        nonlocal client
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY is not set")
        import anthropic
        if client is None:
            client = anthropic.AsyncAnthropic(api_key=api_key, max_retries=1, timeout=BUDGET_S)
        resp = await client.beta.messages.create(
            model=model_name,
            max_tokens=1000,
            system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": prompt}],
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": SHORT_ANSWER_SCHEMA}},
            betas=["server-side-fallback-2026-07-01"],
            extra_body={"fallbacks": "default"},
        )
        if resp.stop_reason in ("refusal", "max_tokens"):
            raise RuntimeError(f"model stopped: {resp.stop_reason}")
        return "".join(b.text for b in resp.content if b.type == "text")

    return call


async def grade_short_answer(
    question_prompt: str,
    correct_answer: str,
    learner_answer: str,
    model_call: ModelCall | None = None,
) -> ConceptResult:
    """Grade a short-answer question using Claude."""
    try:
        call = model_call or anthropic_model_call()
        prompt = (
            f"Question: {question_prompt}\n\n"
            f"Correct answer: {correct_answer}\n\n"
            f"Learner's answer: {learner_answer}"
        )
        raw = await asyncio.wait_for(call(prompt), BUDGET_S + 1)
        v = json.loads(raw)
        return ConceptResult(
            correct=bool(v["correct"]),
            explanation=v.get("explanation", "").strip() or ("Correct!" if v["correct"] else "Incorrect."),
            aiGenerated=True,
        )
    except Exception as exc:
        logger.info("concept grading model unavailable: %s", type(exc).__name__)
        # Fallback: simple string containment check
        norm_answer = learner_answer.strip().lower()
        norm_correct = correct_answer.strip().lower()
        is_correct = norm_correct in norm_answer or norm_answer in norm_correct
        return ConceptResult(
            correct=is_correct,
            explanation="Answer evaluated with basic matching (AI unavailable).",
            aiGenerated=False,
        )
