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
import re
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
    """Grade a multiple-choice answer deterministically.

    A wrong answer never names the correct choice; explain_wrong_answer() says what went wrong.
    """
    is_correct = answer.strip().lower() == correct_id.strip().lower()
    return ConceptResult(
        correct=is_correct,
        explanation="Correct!" if is_correct else "That choice isn't right yet.",
        aiGenerated=False,
    )


def grade_predict_output(answer: str, expected_output: str) -> ConceptResult:
    """Grade a predict-output question by comparing the output string (never revealed on a miss)."""
    # Normalize whitespace
    norm_answer = " ".join(answer.strip().split())
    norm_expected = " ".join(expected_output.strip().split())
    is_correct = norm_answer == norm_expected
    return ConceptResult(
        correct=is_correct,
        explanation="Correct!" if is_correct else "That isn't what this code prints.",
        aiGenerated=False,
    )


# ---------------------------------------------------------------------------
# Wrong-answer coaching: name the misconception without giving the answer away
# ---------------------------------------------------------------------------


class WrongAnswerFeedback(BaseModel):
    misconception: str  # short name of the mistake, e.g. "Used the edge cost alone"
    whyWrong: str       # why the learner's answer doesn't hold
    nextStep: str       # what to re-check so they can find the answer themselves
    aiGenerated: bool


WRONG_ANSWER_SCHEMA = {
    "type": "object",
    "properties": {
        "misconception": {"type": "string", "description": "3-7 word name of the specific mistake."},
        "whyWrong": {"type": "string", "description": "1-2 sentences: why the learner's answer does not hold."},
        "nextStep": {"type": "string", "description": "1 sentence: what to re-check to find the answer themselves."},
    },
    "required": ["misconception", "whyWrong", "nextStep"],
    "additionalProperties": False,
}

WRONG_ANSWER_SYSTEM_PROMPT = """You coach a learner who answered a concept question from a coding tutorial incorrectly.
You see the question, the learner's answer, and (privately) the correct answer and why it is correct.
Work out the specific misconception that leads to the learner's answer and explain it.
Rules:
- Never state, quote, or hint at the correct answer, the correct choice, its letter, or the expected output.
- Talk about the learner's answer and the reasoning step they got wrong.
- misconception: 3-7 words naming the mistake (e.g. "Used the edge cost alone").
- whyWrong: 1-2 sentences on why their answer does not hold.
- nextStep: 1 sentence telling them what to re-check so they can work it out themselves.
- Match the learner's level: plain words and no jargon for beginners."""

WRONG_BUDGET_S = 6.0
_LEN = {"misconception": 80, "whyWrong": 400, "nextStep": 300}


def _norm(text: str) -> str:
    return " ".join(text.lower().split())


def _choice_text(choices: list[dict] | None, choice_id: str) -> str | None:
    for c in choices or []:
        if str(c.get("id", "")).strip().lower() == choice_id.strip().lower():
            return str(c.get("text", ""))
    return None


def _reveals(feedback: str, *, style: str, prompt: str, learner_answer: str,
             correct_answer: str, correct_text: str | None) -> bool:
    """True when the coaching text gives the answer away.

    A value counts as revealed only if it appears in the feedback but not already in the question
    or in the learner's own answer (mentioning those is fair game).
    """
    fb = _norm(feedback)
    if re.search(r"\b(?:correct|right) (?:answer|choice|option|output) (?:is|was|would be)\b", fb):
        return True
    secrets = []
    if style == "multiple_choice":
        if correct_text:
            secrets.append(correct_text)
        letter = correct_answer.strip().lower()
        if re.fullmatch(r"[a-e]", letter) and re.search(rf"\b(?:option|choice|answer)\s*\(?{letter}\)?(?![\w])", fb):
            return True
    elif style == "predict_output":
        secrets.append(correct_answer)
    elif len(correct_answer) <= 40:
        secrets.append(correct_answer)
    context = _norm(prompt) + " || " + _norm(learner_answer)
    for secret in secrets:
        s = _norm(secret).strip(" .")
        if not s:
            continue
        pattern = rf"(?<![\w]){re.escape(s)}(?![\w])"
        if re.search(pattern, fb) and not re.search(pattern, context):
            return True
    return False


def fallback_wrong_answer(style: str, learner_answer: str, choices: list[dict] | None,
                          concept_name: str) -> WrongAnswerFeedback:
    """Deterministic coaching when the model is unavailable; still never reveals the answer."""
    if style == "multiple_choice":
        picked = _choice_text(choices, learner_answer) or learner_answer.strip()
        return WrongAnswerFeedback(
            misconception=f"Rethink {concept_name}",
            whyWrong=f'"{picked}" isn\'t the answer.',
            nextStep=f"Go back to the exact rule the video used for {concept_name}, apply it step by step "
                     f"to the numbers in the question, then try again.",
            aiGenerated=False,
        )
    if style == "predict_output":
        return WrongAnswerFeedback(
            misconception="Output traced incorrectly",
            whyWrong="Your predicted output doesn't match what this code prints.",
            nextStep="Trace the code one line at a time, writing down every variable's value, then try again.",
            aiGenerated=False,
        )
    return WrongAnswerFeedback(
        misconception=f"Key idea of {concept_name} missing",
        whyWrong="Your answer doesn't capture the key idea yet.",
        nextStep=f"Think about what {concept_name} actually does in the example from the video, then try again.",
        aiGenerated=False,
    )


async def explain_wrong_answer(
    *,
    style: str,
    prompt: str,
    learner_answer: str,
    correct_answer: str,
    explanation: str = "",
    choices: list[dict] | None = None,
    concept_name: str = "this concept",
    learner_level: str = "beginner-1",
    model_call: ModelCall | None = None,
) -> WrongAnswerFeedback:
    """Name the misconception behind a wrong concept answer without revealing the answer.

    Uses Claude with a short budget; any failure, malformed output or answer leak falls back
    to deterministic coaching.
    """
    correct_text = _choice_text(choices, correct_answer) if style == "multiple_choice" else None
    picked = (_choice_text(choices, learner_answer) or learner_answer) if style == "multiple_choice" else learner_answer
    try:
        call = model_call or anthropic_model_call(system=WRONG_ANSWER_SYSTEM_PROMPT, schema=WRONG_ANSWER_SCHEMA)
        lines = [f"Concept: {concept_name}", f"Learner level: {learner_level}", f"Question style: {style}",
                 f"Question: {prompt}"]
        if style == "multiple_choice" and choices:
            lines.append("Choices: " + "; ".join(str(c.get("text", "")) for c in choices))
        lines += [f"Learner's answer: {picked}",
                  f"PRIVATE correct answer (never reveal): {correct_text or correct_answer}"]
        if explanation:
            lines.append(f"PRIVATE why it is correct (never reveal): {explanation}")
        raw = await asyncio.wait_for(call("\n".join(lines)), WRONG_BUDGET_S + 1)
        v = json.loads(raw)
        out = {k: str(v.get(k, "")).strip() for k in _LEN}
        if any(not out[k] or len(out[k]) > limit for k, limit in _LEN.items()):
            raise ValueError("coaching fields missing or too long")
        if _reveals(" ".join(out.values()), style=style, prompt=prompt, learner_answer=picked,
                    correct_answer=correct_answer, correct_text=correct_text):
            raise ValueError("coaching revealed the answer")
        return WrongAnswerFeedback(**out, aiGenerated=True)
    except Exception as exc:
        logger.info("wrong-answer coaching unavailable: %s: %s", type(exc).__name__, exc)
        return fallback_wrong_answer(style, learner_answer, choices, concept_name)


def anthropic_model_call(model: str | None = None, *, system: str | None = None,
                         schema: dict | None = None) -> ModelCall:
    try:
        from dotenv import load_dotenv
        load_dotenv(BACKEND_DIR / ".env")
    except ImportError:
        pass
    model_name = model or os.environ.get("ANTHROPIC_CONCEPT_MODEL") or DEFAULT_MODEL
    system_text = system or SYSTEM_PROMPT
    out_schema = schema or SHORT_ANSWER_SCHEMA
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
            system=[{"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": prompt}],
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": out_schema}},
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
