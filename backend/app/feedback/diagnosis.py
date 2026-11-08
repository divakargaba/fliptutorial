"""Failure diagnosis: identify the misconception, point at specific lines, and explain.

Given the learner's code and the grading result, Claude names the misconception,
marks the 1-based lines involved, and explains the failing case. Falls back to
a static diagnosis when the model is unavailable.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, Awaitable, Callable

from pydantic import BaseModel

logger = logging.getLogger("breakpoint.feedback.diagnosis")

BACKEND_DIR = __import__("pathlib").Path(__file__).resolve().parent.parent.parent
DEFAULT_MODEL = "claude-opus-5-5"
BUDGET_S = 12.0

ModelCall = Callable[[str], Awaitable[str]]


class Misconception(BaseModel):
    id: str
    name: str
    explanation: str


class LineNote(BaseModel):
    line: int
    note: str


class FailingCase(BaseModel):
    args: list[Any] | None = None
    expected: Any = None
    actual: Any = None
    error: str | None = None


class Diagnosis(BaseModel):
    misconception: Misconception
    lines: list[LineNote]
    failingCase: FailingCase | None


DIAGNOSIS_SCHEMA = {
    "type": "object",
    "properties": {
        "misconceptionId": {"type": "string", "description": "kebab-case id like 'off-by-one' or 'loop-no-progress'."},
        "misconceptionName": {"type": "string", "description": "Human name, 2-6 words."},
        "explanation": {"type": "string", "description": "1-2 sentences explaining what the learner misunderstands."},
        "lines": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "line": {"type": "integer", "description": "1-based line number in the learner's code."},
                    "note": {"type": "string", "description": "What this line does wrong, max 1 sentence."},
                },
                "required": ["line", "note"],
            },
            "description": "The 1-3 lines most responsible for the bug.",
        },
    },
    "required": ["misconceptionId", "misconceptionName", "explanation", "lines"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """You diagnose bugs in a learner's code submission for a coding exercise.
The code failed at least one test case. Your job:

1. Identify the root misconception (not just the symptom). Name it concisely.
2. Point to the exact 1-based line numbers in the learner's code that embody the error.
3. Explain in plain language what the learner misunderstands, referencing the failing case.

Rules:
- Never suggest a fix or write corrected code. You explain the bug, not the solution.
- Be specific to this code and this failing case.
- Keep explanation to 1-2 sentences, notes to 1 sentence each.
- The misconception id should be a reusable kebab-case tag like "off-by-one", "wrong-operator", "missing-base-case", "loop-no-progress", etc."""


def build_prompt(
    title: str,
    statement: str,
    language: str,
    code: str,
    function_name: str,
    failing_case: FailingCase | None,
    outcome: str,
    concepts: list[str],
) -> str:
    numbered = "\n".join(f"{i+1}: {line}" for i, line in enumerate(code.splitlines()))
    case_desc = "No specific failing case details available."
    if failing_case:
        case_desc = f"Outcome: {outcome}."
        if failing_case.args is not None:
            case_desc += f" Failing input: {function_name}({', '.join(map(repr, failing_case.args))})"
            if failing_case.expected is not None:
                case_desc += f" expected {failing_case.expected!r}"
            if failing_case.actual is not None:
                case_desc += f", got {failing_case.actual!r}"
        if failing_case.error:
            case_desc += f"\nError: {failing_case.error}"

    return (
        f"Exercise: {title}\n{statement}\n"
        f"Language: {language}\nConcepts: {', '.join(concepts) or 'general'}\n\n"
        f"Learner's code (line-numbered):\n{numbered}\n\n"
        f"{case_desc}"
    )


def anthropic_model_call(model: str | None = None) -> ModelCall:
    try:
        from dotenv import load_dotenv
        load_dotenv(BACKEND_DIR / ".env")
    except ImportError:
        pass
    model_name = model or os.environ.get("ANTHROPIC_FEEDBACK_MODEL") or DEFAULT_MODEL
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
            max_tokens=4000,
            system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": prompt}],
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": DIAGNOSIS_SCHEMA}},
            betas=["server-side-fallback-2026-07-01"],
            extra_body={"fallbacks": "default"},
        )
        if resp.stop_reason in ("refusal", "max_tokens"):
            raise RuntimeError(f"model stopped: {resp.stop_reason}")
        return "".join(b.text for b in resp.content if b.type == "text")

    return call


def static_diagnosis(
    outcome: str,
    failing_case: FailingCase | None,
    code: str,
) -> Diagnosis:
    """Deterministic fallback when Claude is unavailable."""
    misconception_map = {
        "wrong_answer": Misconception(
            id="wrong-answer",
            name="Incorrect result",
            explanation="The function returns a value that doesn't match the expected output for at least one test case.",
        ),
        "syntax_error": Misconception(
            id="syntax-error",
            name="Syntax error",
            explanation="The code has a syntax problem that prevents it from being parsed or compiled.",
        ),
        "runtime_error": Misconception(
            id="runtime-error",
            name="Runtime error",
            explanation="The code crashes while running, possibly due to a wrong type, missing variable, or invalid operation.",
        ),
        "time_limit": Misconception(
            id="infinite-loop",
            name="Loop never terminates",
            explanation="The code runs too long, likely because a loop condition never becomes false or recursion never reaches a base case.",
        ),
        "invalid_output": Misconception(
            id="bad-output",
            name="Invalid output format",
            explanation="The function didn't produce parseable output, possibly due to a print statement or missing return.",
        ),
    }
    misconception = misconception_map.get(
        outcome,
        Misconception(id="unknown", name="Unknown error", explanation="The submission did not pass."),
    )
    return Diagnosis(
        misconception=misconception,
        lines=[],
        failingCase=failing_case,
    )


async def diagnose(
    title: str,
    statement: str,
    language: str,
    code: str,
    function_name: str,
    outcome: str,
    failing_case: FailingCase | None,
    concepts: list[str],
    model_call: ModelCall | None = None,
) -> tuple[Diagnosis, bool]:
    """Returns (diagnosis, ai_generated)."""
    fallback = static_diagnosis(outcome, failing_case, code)
    try:
        call = model_call or anthropic_model_call()
        prompt = build_prompt(title, statement, language, code, function_name, failing_case, outcome, concepts)
        raw = await asyncio.wait_for(call(prompt), BUDGET_S + 1)
        v = json.loads(raw)
        diag = Diagnosis(
            misconception=Misconception(
                id=v["misconceptionId"],
                name=v["misconceptionName"],
                explanation=v["explanation"],
            ),
            lines=[LineNote(line=ln["line"], note=ln["note"]) for ln in v.get("lines", [])],
            failingCase=failing_case,
        )
        return diag, True
    except Exception as exc:
        logger.info("diagnosis model unavailable: %s", type(exc).__name__)
        return fallback, False
