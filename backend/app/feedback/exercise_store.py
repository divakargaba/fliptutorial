"""Server-side exercise store for v2 generated exercises.

The planner (A1) generates exercises with hidden tests and reference solutions
that must never reach the client. This store caches them server-side so the
feedback lane can look up the full exercise data when grading a submission.

Also falls back to v1 approved exercises from the catalog.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("breakpoint.feedback.store")

EXERCISE_TTL_S = 7200  # 2 hours


@dataclass
class StoredExercise:
    """Full exercise data including hidden tests and reference solution."""
    id: str
    revision: str
    title: str
    language: str
    statement: str
    functionName: str
    starterCode: str
    concepts: list[str]
    level: str
    examples: list[dict[str, Any]]
    hiddenTests: list[dict[str, Any]]
    referenceSolution: str
    aiGenerated: bool = True
    stored_at: float = field(default_factory=time.monotonic)

    # For concept questions
    questionId: str | None = None
    style: str | None = None  # multiple_choice | short_answer | predict_output
    prompt: str | None = None
    choices: list[dict[str, str]] | None = None
    correctAnswer: str | None = None  # for MC: choice id, for predict: output, for SA: answer text


class ExerciseStore:
    """In-memory cache of full exercise data."""

    def __init__(self) -> None:
        self._exercises: dict[str, StoredExercise] = {}
        self._questions: dict[str, StoredExercise] = {}

    def store_exercise(self, exercise: StoredExercise) -> None:
        self._exercises[exercise.id] = exercise
        self._gc()

    def store_question(self, question: StoredExercise) -> None:
        self._questions[question.questionId or question.id] = question
        self._gc()

    def get_exercise(self, exercise_id: str) -> StoredExercise | None:
        ex = self._exercises.get(exercise_id)
        if ex and time.monotonic() - ex.stored_at > EXERCISE_TTL_S:
            del self._exercises[exercise_id]
            return None
        return ex

    def get_question(self, question_id: str) -> StoredExercise | None:
        q = self._questions.get(question_id)
        if q and time.monotonic() - q.stored_at > EXERCISE_TTL_S:
            del self._questions[question_id]
            return None
        return q

    def _gc(self) -> None:
        now = time.monotonic()
        for store in (self._exercises, self._questions):
            expired = [k for k, v in store.items() if now - v.stored_at > EXERCISE_TTL_S]
            for k in expired:
                del store[k]


# Singleton
_store: ExerciseStore | None = None


def get_store() -> ExerciseStore:
    global _store
    if _store is None:
        _store = ExerciseStore()
    return _store
