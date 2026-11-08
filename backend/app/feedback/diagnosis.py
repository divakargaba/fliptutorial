"""Failure diagnosis: what went wrong, why (the thinking behind the mistake), and how to fix it.

Given the learner's code and the grading result, Claude names the misconception, says what
went wrong in one sentence, explains the reasoning that leads to it, says what to change in
words (never the full solution) and marks the 1-based lines involved with a note each. Falls
back to a deterministic diagnosis built from the real error message when the model is unavailable.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
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
    summary: str = ""  # one sentence: what went wrong (FeedbackResult.summary)


DIAGNOSIS_SCHEMA = {
    "type": "object",
    "properties": {
        "misconceptionId": {"type": "string", "description": "kebab-case id like 'off-by-one' or 'missing-base-case'."},
        "misconceptionName": {"type": "string", "description": "Human name, 2-6 words."},
        "whatWentWrong": {"type": "string", "description": "1 sentence: what the code does wrong, tied to the failing case or error."},
        "why": {"type": "string", "description": "1-2 sentences: the thinking that leads to this mistake and why it is wrong."},
        "howToFix": {"type": "string", "description": "1-2 sentences: what to change, in words; never the corrected code."},
        "lines": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "line": {"type": "integer", "description": "1-based line number in the learner's code."},
                    "note": {"type": "string", "description": "What is wrong on this line and what to change there, in words; max 1 sentence."},
                },
                "required": ["line", "note"],
                "additionalProperties": False,
            },
            "description": "The 1-3 lines most responsible for the bug.",
        },
    },
    "required": ["misconceptionId", "misconceptionName", "whatWentWrong", "why", "howToFix", "lines"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """You are a patient programming tutor. A learner's code for a coding exercise failed.
Help them understand the mistake well enough to fix it themselves.

1. whatWentWrong: one sentence on what the code does wrong, tied to the failing case or the error.
2. why: the thinking that typically leads to this mistake and why it does not work
   (e.g. "Python ends an if header with a colon; semicolons end statements in C-style languages").
3. howToFix: what to change, described in words (e.g. "add a colon after the condition and indent
   the body under it"). Never write the corrected code or the full solution.
4. lines: the 1-3 lines most responsible, each with what is wrong there and what to change.
5. Name the root misconception concisely with a reusable kebab-case id ("off-by-one",
   "missing-base-case", "python-block-syntax", "wrong-operator", "loop-no-progress").

Rules:
- Be specific to this code and this failing case or error message; no generic advice.
- For syntax errors, point at the exact line and symbol from the error message.
- Match the learner's level: plain words for beginners, more precise terms for advanced learners.
- Keep each field short: 1-2 sentences, line notes 1 sentence."""


def build_prompt(
    title: str,
    statement: str,
    language: str,
    code: str,
    function_name: str,
    failing_case: FailingCase | None,
    outcome: str,
    concepts: list[str],
    learner_level: str = "beginner-1",
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
        f"Language: {language}\nConcepts: {', '.join(concepts) or 'general'}\nLearner level: {learner_level}\n\n"
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


# Wrappers that put the learner's code first (or run it as-is), so error line numbers match their code.
_LINES_MATCH = {"python", "javascript", "typescript", "c", "csharp", "go", "rust"}


def _error_parts(error: str | None, language: str, code: str) -> tuple[str, int | None]:
    """(last meaningful error line, learner-code line number or None) from a sandbox error text."""
    text = (error or "").strip()
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    message = next((ln for ln in reversed(lines) if re.search(r"(Error|error|Exception|panic)\b", ln)), lines[-1] if lines else "")
    line_no = None
    if language in _LINES_MATCH:
        nums = re.findall(r"line (\d+)", text) or re.findall(r":(\d+):\d+", text)
        if nums:
            n = int(nums[-1] if "line " in text else nums[0])
            if 1 <= n <= max(1, len(code.splitlines())):
                line_no = n
    return message[:300], line_no


def _compose(why: str, how: str) -> str:
    return f"{why.strip()} How to fix it: {how.strip()}"


def static_diagnosis(
    outcome: str,
    failing_case: FailingCase | None,
    code: str,
    language: str = "python",
    function_name: str = "",
) -> Diagnosis:
    """Deterministic fallback when Claude is unavailable, built from the real error or failing case."""
    error = failing_case.error if failing_case else None
    message, line_no = _error_parts(error, language, code)
    at = f" on line {line_no}" if line_no else ""
    notes: list[LineNote] = []
    if outcome == "syntax_error":
        summary = f"Your code can't be read{at}: {message}" if message else "Your code has a syntax error, so it never ran."
        why = "Code must follow the language's grammar before any of it can run, so one missing or extra symbol stops the whole program."
        how = (f"Look at line {line_no} and the line just above it; check colons, brackets, quotes and indentation."
               if line_no else "Check colons, brackets, quotes and indentation around where the error points.")
        mid, name = "syntax-error", "Syntax error"
        if line_no:
            notes.append(LineNote(line=line_no, note=f"The error points here: {message}" if message else "The error points here."))
    elif outcome == "runtime_error":
        summary = f"Your code crashed while running{at}: {message}" if message else "Your code crashed while running."
        why = "The code is valid, but at that point it does something impossible with the values it has (a wrong type, a missing name, an index out of range)."
        how = "Run through that line by hand with the example input and check what each variable holds right before it."
        mid, name = "runtime-error", "Crash while running"
        if line_no:
            notes.append(LineNote(line=line_no, note=f"It crashed here: {message}" if message else "It crashed here."))
    elif outcome == "time_limit":
        summary = "Your code ran for too long and was stopped."
        why = "A loop condition never becomes false, or the recursion never reaches its base case, so the program never finishes."
        how = "Check what changes on every loop pass or recursive call, and make sure it moves toward the stopping condition."
        mid, name = "infinite-loop", "Never finishes"
    elif outcome == "wrong_answer" and failing_case and failing_case.args is not None:
        call = f"{function_name or 'your code'}({', '.join(map(repr, failing_case.args))})"
        summary = f"For {call} your code gave {failing_case.actual!r}, but {failing_case.expected!r} was expected."
        why = "The code runs, but its logic produces a different value for this input than the exercise asks for."
        how = "Trace your code by hand with that input, line by line, and find the first step where a value differs from what you expect."
        mid, name = "wrong-answer", "Incorrect result"
    elif outcome == "invalid_output":
        summary = "Your code didn't produce an answer the grader could read."
        why = "The function has to return its result; printing it or returning nothing leaves the grader with no value."
        how = "Make sure every path through the function ends with a return of the answer."
        mid, name = "bad-output", "No usable result"
    else:
        summary = "Your code doesn't pass the tests yet."
        why = "At least one test case gets a different result than expected."
        how = "Compare your output with the expected value for the first failing example and trace why they differ."
        mid, name = "wrong-answer", "Incorrect result"
    return Diagnosis(
        misconception=Misconception(id=mid, name=name, explanation=_compose(why, how)),
        lines=notes,
        failingCase=failing_case,
        summary=summary,
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
    learner_level: str = "beginner-1",
) -> tuple[Diagnosis, bool]:
    """Returns (diagnosis, ai_generated). Diagnosis.summary is what went wrong; misconception.explanation
    is why it happens followed by how to fix it (in words); lines are capped at the learner's code length."""
    fallback = static_diagnosis(outcome, failing_case, code, language, function_name)
    try:
        call = model_call or anthropic_model_call()
        prompt = build_prompt(title, statement, language, code, function_name, failing_case, outcome, concepts,
                              learner_level)
        raw = await asyncio.wait_for(call(prompt), BUDGET_S + 1)
        v = json.loads(raw)
        n_lines = max(1, len(code.splitlines()))
        what = str(v.get("whatWentWrong", "")).strip()
        why, how = str(v.get("why", "")).strip(), str(v.get("howToFix", "")).strip()
        if not (v.get("misconceptionName") and what and why and how):
            raise ValueError("diagnosis fields missing")
        diag = Diagnosis(
            misconception=Misconception(
                id=str(v.get("misconceptionId") or "misconception"),
                name=str(v["misconceptionName"]),
                explanation=_compose(why, how),
            ),
            lines=[LineNote(line=int(ln["line"]), note=str(ln["note"])) for ln in v.get("lines", [])
                   if 1 <= int(ln.get("line", 0)) <= n_lines and str(ln.get("note", "")).strip()][:3],
            failingCase=failing_case,
            summary=what,
        )
        return diag, True
    except Exception as exc:
        logger.info("diagnosis model unavailable: %s: %s", type(exc).__name__, str(exc)[:200])
        return fallback, False
