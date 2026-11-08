"""Success feedback: concept explanation and optimization analysis.

For passing submissions, identifies the concept tested, assesses level, and
optionally suggests a more efficient solution (only for Intermediate+ tiers).
Reuses the v1 analysis.estimate() for static complexity and adds Claude for
richer explanation.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, Awaitable, Callable

from pydantic import BaseModel

from ..analysis import estimate as static_estimate, Estimate, TIME_CLASSES, SPACE_CLASSES

logger = logging.getLogger("breakpoint.feedback.optimization")

BACKEND_DIR = __import__("pathlib").Path(__file__).resolve().parent.parent.parent
DEFAULT_MODEL = "claude-opus-5-5"
BUDGET_S = 12.0

# Optimization is shown only from intermediate tier upward
INTERMEDIATE_TIERS = {"intermediate", "advanced", "expert"}

ModelCall = Callable[[str], Awaitable[str]]


class Complexity(BaseModel):
    time: str
    space: str


class Optimization(BaseModel):
    show: bool
    learner: Complexity
    best: Complexity
    tip: str | None
    betterSolution: str | None


class SuccessFeedback(BaseModel):
    explanation: str
    optimization: Optimization


SUCCESS_SCHEMA = {
    "type": "object",
    "properties": {
        "explanation": {"type": "string", "description": "1-2 sentences, addressed to the learner as you: what concept the exercise tested and what you demonstrated."},
        "summary": {"type": "string", "description": "One friendly sentence, addressed as you, about your solution's efficiency."},
        "learnerTime": {"type": "string"},
        "learnerSpace": {"type": "string"},
        "bestTime": {"type": "string"},
        "bestSpace": {"type": "string"},
        "optimal": {"type": "boolean"},
        "tip": {"type": "string", "description": "If not optimal: one sentence idea to make it faster. Else empty."},
        "betterSolution": {"type": "string", "description": "If not optimal: a complete faster solution defining the same function. Else empty."},
    },
    "required": ["explanation", "summary", "learnerTime", "learnerSpace", "bestTime", "bestSpace", "optimal", "tip", "betterSolution"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """You review a learner's code that passed every test for a coding exercise.
Write every text field directly to the learner in the second person ("you"), never "the learner".

1. Explain in 1-2 sentences what concept this exercise tested and what you (the learner) demonstrated.
2. Judge the solution's time and extra-space complexity in Big-O.
3. Compare with the best practical approach for this problem.
4. If the learner is not optimal, suggest a faster solution defining the same function.

Keep explanations encouraging and short. Respect constraints stated in the exercise."""


def _rank(label: str, classes: list[str]) -> int | None:
    norm = label.replace(" ", "").replace("²", "^2").replace("³", "^3").lower()
    for i, c in enumerate(classes):
        if c.replace(" ", "").lower() == norm:
            return i
    return None


def _tier_from_level(level_id: str) -> str:
    """Extract tier from level id like 'beginner-3' -> 'beginner'."""
    return level_id.rsplit("-", 1)[0] if "-" in level_id else level_id


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
            max_tokens=6000,
            system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": prompt}],
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SUCCESS_SCHEMA}},
            betas=["server-side-fallback-2026-07-01"],
            extra_body={"fallbacks": "default"},
        )
        if resp.stop_reason in ("refusal", "max_tokens"):
            raise RuntimeError(f"model stopped: {resp.stop_reason}")
        return "".join(b.text for b in resp.content if b.type == "text")

    return call


def build_prompt(
    title: str,
    statement: str,
    language: str,
    code: str,
    function_name: str,
    reference_solution: str | None,
    learner_est: Estimate | None,
    ref_est: Estimate | None,
) -> str:
    def fmt(e: Estimate | None) -> str:
        return f"time {e.time}, space {e.space}" if e else "unknown"

    ref_section = ""
    if reference_solution:
        ref_section = (
            f"\nInstructor's reference solution (for comparison):\n<code>\n{reference_solution}\n</code>\n"
            f"Static estimate for the reference: {fmt(ref_est)}\n"
        )

    return (
        f"Exercise: {title}\n{statement}\nLanguage: {language}\n\n"
        f"Learner's passing solution:\n<code>\n{code[:8000]}\n</code>\n"
        f"Static estimate for the learner: {fmt(learner_est)}\n"
        f"{ref_section}"
    )


async def analyze_success(
    title: str,
    statement: str,
    language: str,
    code: str,
    function_name: str,
    reference_solution: str | None,
    learner_level: str,
    concepts: list[str],
    verify: Callable[[str], Awaitable[bool]] | None = None,
    model_call: ModelCall | None = None,
) -> tuple[SuccessFeedback, bool]:
    """Returns (success_feedback, ai_generated).

    ``verify`` is an async function that grades a candidate solution and returns True
    if it passes all tests; used to check AI-suggested better solutions.
    """
    tier = _tier_from_level(learner_level)
    show_optimization = tier in INTERMEDIATE_TIERS

    learner_est = static_estimate(code, function_name) if language == "python" else None
    ref_est = static_estimate(reference_solution, function_name) if reference_solution and language == "python" else None

    # Static fallback
    def _static_feedback() -> SuccessFeedback:
        if learner_est:
            lc = Complexity(time=learner_est.time, space=learner_est.space)
        else:
            lc = Complexity(time="O(n)", space="O(1)")
        bc = Complexity(time=ref_est.time, space=ref_est.space) if ref_est else lc
        return SuccessFeedback(
            explanation=f"This exercise tested {', '.join(concepts) or 'programming'}.",
            optimization=Optimization(
                show=show_optimization,
                learner=lc,
                best=bc,
                tip=None,
                betterSolution=None,
            ),
        )

    try:
        call = model_call or anthropic_model_call()
        prompt = build_prompt(title, statement, language, code, function_name, reference_solution, learner_est, ref_est)
        raw = await asyncio.wait_for(call(prompt), BUDGET_S + 1)
        v = json.loads(raw)

        optimal = bool(v["optimal"])
        better = (v.get("betterSolution") or "").strip() or None

        # Validate: model can only claim "slower" if the ranks support it
        lr = _rank(v["learnerTime"], TIME_CLASSES)
        br = _rank(v["bestTime"], TIME_CLASSES)
        if not optimal and lr is not None and br is not None and lr <= br:
            ls = _rank(v["learnerSpace"], SPACE_CLASSES)
            bs = _rank(v["bestSpace"], SPACE_CLASSES)
            if ls is None or bs is None or ls <= bs:
                optimal = True
                better = None

        # Verify suggested solution if provided
        if better and verify and not optimal:
            try:
                ok = await verify(better)
            except Exception:
                ok = False
            if not ok:
                logger.info("suggested solution failed verification; dropped")
                better = None

        tip = None if optimal else ((v.get("tip") or "").strip() or None)

        return SuccessFeedback(
            explanation=v.get("explanation", "").strip() or f"This exercise tested {', '.join(concepts) or 'programming'}.",
            optimization=Optimization(
                show=show_optimization,
                learner=Complexity(time=v["learnerTime"], space=v["learnerSpace"]),
                best=Complexity(time=v["bestTime"], space=v["bestSpace"]),
                tip=tip,
                betterSolution=better if show_optimization else None,
            ),
        ), True
    except Exception as exc:
        logger.info("optimization model unavailable: %s", type(exc).__name__)
        return _static_feedback(), False
