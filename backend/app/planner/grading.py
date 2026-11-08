"""Hand planned items to lane A2's grading store (``app.feedback.register_exercise`` / ``register_question``).

A2's store is in memory with a TTL, while plans live on disk. So every ready item is registered when it is
generated and again whenever a plan containing it is served (POST/GET /v2/plan, which the runtime polls).
That covers restarts and TTL expiry. Until A2's functions exist (main still has the stub), this does nothing.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from .generate import PrivateExercise, PrivateQuestion

logger = logging.getLogger("breakpoint.planner")


def _registrar(name: str) -> Callable[..., Any] | None:
    try:
        from .. import feedback
    except Exception:  # pragma: no cover - feedback lane failing to import must not break planning
        return None
    fn = getattr(feedback, name, None)
    return fn if callable(fn) else None


def register_exercise(pe: PrivateExercise) -> None:
    fn = _registrar("register_exercise")
    if fn is None:
        return
    ex = pe.exercise
    try:
        fn(
            exercise_id=ex.id, revision=pe.revision, title=ex.title, language=pe.language, statement=ex.statement,
            function_name=ex.functionName, starter_code=ex.starterCode, concepts=list(pe.concepts), level=pe.level,
            examples=[{"args": e.args, "expected": e.expected} for e in ex.examples],
            hidden_tests=[{"args": h.args, "expected": h.expected} for h in ex.hiddenTests],
            reference_solution=ex.referenceSolution, ai_generated=True,
        )
    except Exception:
        logger.exception("planner: register_exercise failed for %s", ex.id)


def register_question(q: PrivateQuestion) -> None:
    fn = _registrar("register_question")
    if fn is None:
        return
    try:
        fn(
            question_id=q.id, revision=q.revision, title=q.title, style=q.style, prompt=q.prompt,
            concepts=list(q.concepts), level=q.level, correct_answer=q.answer,
            choices=list(q.choices) if q.style == "multiple_choice" else None, ai_generated=True,
        )
    except Exception:
        logger.exception("planner: register_question failed for %s", q.id)


def register_item(exercise: PrivateExercise | None, question: PrivateQuestion | None) -> None:
    if exercise is not None:
        register_exercise(exercise)
    if question is not None:
        register_question(question)
