"""Lane A2 (@divakargaba's agent): level-aware feedback, diagnosis, concept answers, multi-language grading.

Endpoints:
  POST /v2/submit  — grade code and return FeedbackResult
  POST /v2/answer  — grade a concept question
  POST /v2/hint    — level-aware graduated hints

See contracts/v2/README.md §2. Language runners live in app/runners/.
"""

from __future__ import annotations

import json
import logging
import uuid
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ..runners import (
    get_runner, RunnerUnavailable, RunnerTimeout, RunnerBusy,
    SUPPORTED_LANGUAGES,
)
from .diagnosis import diagnose, FailingCase
from .optimization import analyze_success
from .concepts import explain_wrong_answer, grade_multiple_choice, grade_predict_output, grade_short_answer
from .exercise_store import get_store, StoredExercise

logger = logging.getLogger("breakpoint.feedback")

router = APIRouter(prefix="/v2", tags=["feedback"])

_REPO_ROOT = Path(__file__).resolve().parents[3]
LEVELS_PATH = _REPO_ROOT / "contracts" / "v2" / "levels.json"
CONCEPTS_PATH = _REPO_ROOT / "contracts" / "v2" / "concepts.json"

_levels: list[dict] | None = None
_concepts: dict[str, str] | None = None


def _load_levels() -> list[dict]:
    global _levels
    if _levels is None:
        data = json.loads(LEVELS_PATH.read_text(encoding="utf-8"))
        _levels = data["levels"]
    return _levels


def _load_concepts() -> dict[str, str]:
    """Returns {concept_id: concept_name}."""
    global _concepts
    if _concepts is None:
        data = json.loads(CONCEPTS_PATH.read_text(encoding="utf-8"))
        _concepts = {c["id"]: c["name"] for c in data["concepts"]}
    return _concepts


def _tier_from_level(level_id: str) -> str:
    return level_id.rsplit("-", 1)[0] if "-" in level_id else level_id


def _error(status: int, code: str, message: str, retryable: bool = False, request_id: str = "") -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={
            "error": {"code": code, "message": message, "retryable": retryable},
            "requestId": request_id or uuid.uuid4().hex[:12],
        },
    )


# ---------------------------------------------------------------------------
# POST /v2/submit
# ---------------------------------------------------------------------------


class SubmitRequest(BaseModel):
    exerciseId: str
    revision: str
    language: str
    code: str = Field(max_length=16384)
    mode: Literal["run", "submit"]
    learnerLevel: str = "beginner-1"


@router.post("/submit")
async def submit(body: SubmitRequest) -> JSONResponse:
    request_id = uuid.uuid4().hex[:12]

    if not body.code.strip():
        return _error(422, "INVALID_CODE", "code is empty", request_id=request_id)

    # Resolve exercise
    store = get_store()
    exercise = store.get_exercise(body.exerciseId)

    # Also check v1 catalog
    if exercise is None:
        try:
            from ..main import catalog as v1_catalog
            found = v1_catalog.find_exercise(body.exerciseId)
            if found:
                record, ex = found
                if record.revision != body.revision:
                    return _error(409, "STALE_EXERCISE", "exercise was updated; reload", request_id=request_id)
                exercise = StoredExercise(
                    id=ex.id, revision=record.revision, title=ex.title,
                    language=ex.language, statement=ex.statement,
                    functionName=ex.functionName, starterCode=ex.starterCode,
                    concepts=ex.conceptTags, level=body.learnerLevel,
                    examples=[{"args": e.args, "expected": e.expected} for e in ex.examples],
                    hiddenTests=[{"args": h.args, "expected": h.expected} for h in ex.hiddenTests],
                    referenceSolution=ex.referenceSolution,
                    aiGenerated=False,
                )
        except Exception:
            pass

    # Check the A1 planner's generated exercises
    if exercise is None:
        try:
            from ..planner import find_exercise as planner_find_exercise
            priv = planner_find_exercise(body.exerciseId)
            if priv is not None:
                ex = priv.exercise
                if priv.revision != body.revision:
                    return _error(409, "STALE_EXERCISE", "exercise was updated; reload", request_id=request_id)
                exercise = StoredExercise(
                    id=ex.id, revision=priv.revision, title=ex.title,
                    language=priv.language, statement=ex.statement,
                    functionName=ex.functionName, starterCode=ex.starterCode,
                    concepts=priv.concepts, level=priv.level,
                    examples=[{"args": e.args, "expected": e.expected} for e in ex.examples],
                    hiddenTests=[{"args": h.args, "expected": h.expected} for h in ex.hiddenTests],
                    referenceSolution=ex.referenceSolution,
                    aiGenerated=True,
                )
        except Exception:
            pass

    if exercise is None:
        return _error(404, "EXERCISE_NOT_FOUND", "unknown exercise", request_id=request_id)

    if exercise.revision != body.revision:
        return _error(409, "STALE_EXERCISE", "exercise was updated; reload", request_id=request_id)

    # Resolve runner
    lang = body.language if body.language in SUPPORTED_LANGUAGES else exercise.language
    if lang not in SUPPORTED_LANGUAGES:
        return _error(422, "UNSUPPORTED_LANGUAGE", f"language not supported: {lang}", request_id=request_id)

    try:
        runner = get_runner(lang)
    except ValueError:
        return _error(422, "UNSUPPORTED_LANGUAGE", f"no runner for {lang}", request_id=request_id)

    # Grade
    try:
        grade_result = await runner.grade(
            code=body.code,
            function_name=exercise.functionName,
            examples=exercise.examples,
            hidden_tests=exercise.hiddenTests if body.mode == "submit" else None,
            mode=body.mode,
        )
    except RunnerUnavailable as exc:
        return _error(503, "GRADER_UNAVAILABLE", str(exc), retryable=True, request_id=request_id)
    except RunnerTimeout as exc:
        return _error(504, "GRADER_TIMEOUT", str(exc), retryable=True, request_id=request_id)
    except RunnerBusy as exc:
        return _error(429, "BUSY", str(exc), retryable=True, request_id=request_id)

    # Build grade response (v1-compatible)
    grade_response = {
        "outcome": grade_result.outcome,
        "passedCount": grade_result.passedCount,
        "totalCount": grade_result.totalCount,
        "results": [
            {
                "kind": "visible" if r.visible else "hidden",
                "index": r.index,
                "passed": r.passed,
                **({"args": r.args, "expected": r.expected, "actual": r.actual, "diagnostic": r.diagnostic} if r.visible else {}),
            }
            for r in grade_result.results
        ],
    }

    # Build FeedbackResult
    concepts_map = _load_concepts()
    concept_id = exercise.concepts[0] if exercise.concepts else "functions"
    concept_name = concepts_map.get(concept_id, concept_id.replace("-", " ").title())

    if grade_result.outcome == "passed" and body.mode == "submit":
        # Success path: explanation + optimization
        async def verify(code: str) -> bool:
            try:
                r = await runner.grade(
                    code=code, function_name=exercise.functionName,
                    examples=exercise.examples, hidden_tests=exercise.hiddenTests,
                    mode="submit",
                )
                return r.outcome == "passed"
            except Exception:
                return False

        success, ai = await analyze_success(
            title=exercise.title,
            statement=exercise.statement,
            language=lang,
            code=body.code,
            function_name=exercise.functionName,
            reference_solution=exercise.referenceSolution,
            learner_level=body.learnerLevel,
            concepts=exercise.concepts,
            verify=verify,
        )

        feedback = {
            "schemaVersion": 2,
            "exerciseId": exercise.id,
            "outcome": "passed",
            "concept": {"id": concept_id, "name": concept_name},
            "assessedLevel": body.learnerLevel,
            "summary": success.explanation,
            "success": {
                "explanation": success.explanation,
                "optimization": success.optimization.model_dump(),
            },
            "diagnosis": None,
            "aiGenerated": ai,
        }
    elif grade_result.outcome != "passed":
        # Failure path: diagnosis
        first_fail = next(
            (r for r in grade_result.results if not r.passed and r.visible),
            None,
        )
        failing_case = None
        if first_fail:
            failing_case = FailingCase(
                args=first_fail.args,
                expected=first_fail.expected,
                actual=first_fail.actual,
                error=first_fail.diagnostic if first_fail.outcome in ("runtime_error", "syntax_error", "time_limit") else None,
            )

        diag, ai = await diagnose(
            title=exercise.title,
            statement=exercise.statement,
            language=lang,
            code=body.code,
            function_name=exercise.functionName,
            outcome=grade_result.outcome,
            failing_case=failing_case,
            concepts=exercise.concepts,
        )

        feedback = {
            "schemaVersion": 2,
            "exerciseId": exercise.id,
            "outcome": "failed",
            "concept": {"id": concept_id, "name": concept_name},
            "assessedLevel": body.learnerLevel,
            "summary": diag.misconception.explanation,
            "success": None,
            "diagnosis": {
                "misconception": diag.misconception.model_dump(),
                "lines": [ln.model_dump() for ln in diag.lines],
                "failingCase": diag.failingCase.model_dump() if diag.failingCase else None,
            },
            "aiGenerated": ai,
        }
    else:
        # mode == "run" and passed: simple feedback, no deep analysis
        feedback = {
            "schemaVersion": 2,
            "exerciseId": exercise.id,
            "outcome": grade_result.outcome,
            "concept": {"id": concept_id, "name": concept_name},
            "assessedLevel": body.learnerLevel,
            "summary": f"Passed {grade_result.passedCount}/{grade_result.totalCount} visible examples.",
            "success": None,
            "diagnosis": None,
            "aiGenerated": False,
        }

    return JSONResponse(
        content={"grade": grade_response, "feedback": feedback},
        headers={"X-Request-Id": request_id},
    )


# ---------------------------------------------------------------------------
# POST /v2/answer
# ---------------------------------------------------------------------------


class AnswerRequest(BaseModel):
    questionId: str
    revision: str
    answer: str = Field(max_length=4000)
    learnerLevel: str = "beginner-1"


def _planner_explanation(question_id: str) -> str | None:
    """The planner's stored "why this is right" text for one of its questions, if any."""
    try:
        from ..planner import find_question as planner_find_question
        priv = planner_find_question(question_id)
        text = (getattr(priv, "explanation", "") or "").strip() if priv is not None else ""
        return text or None
    except Exception:
        return None


@router.post("/answer")
async def answer(body: AnswerRequest) -> JSONResponse:
    request_id = uuid.uuid4().hex[:12]

    store = get_store()
    question = store.get_question(body.questionId)

    # Check A1 planner's generated questions
    if question is None:
        try:
            from ..planner import find_question as planner_find_question
            priv = planner_find_question(body.questionId)
            if priv is not None:
                question = StoredExercise(
                    id=priv.id, revision=priv.revision, title=priv.title,
                    language="pseudocode", statement=priv.prompt, functionName="",
                    starterCode="", concepts=priv.concepts, level=priv.level,
                    examples=[], hiddenTests=[], referenceSolution="",
                    questionId=priv.id, style=priv.style, prompt=priv.prompt,
                    choices=priv.choices, correctAnswer=priv.answer,
                    aiGenerated=True,
                )
        except Exception:
            pass

    # Check B1 profile's refresher questions
    refresher_explanation: str | None = None
    if question is None:
        try:
            from ..profile.skills import lookup_refresher
            ref = lookup_refresher(body.questionId)
            if ref is not None:
                q = ref["question"]
                question = StoredExercise(
                    id=q["id"], revision=q["revision"], title=q["title"],
                    language="pseudocode", statement=q["prompt"], functionName="",
                    starterCode="", concepts=q.get("concepts", []), level=q.get("level", "beginner-1"),
                    examples=[], hiddenTests=[], referenceSolution="",
                    questionId=q["id"], style=q["style"], prompt=q["prompt"],
                    choices=q.get("choices"), correctAnswer=ref["answer"],
                    aiGenerated=q.get("aiGenerated", False),
                )
                refresher_explanation = ref.get("explanation")
        except Exception:
            pass

    if question is None:
        return _error(404, "QUESTION_NOT_FOUND", "unknown question", request_id=request_id)

    if question.revision != body.revision:
        return _error(409, "STALE_EXERCISE", "question was updated; reload", request_id=request_id)

    concepts_map = _load_concepts()
    concept_id = question.concepts[0] if question.concepts else "functions"
    concept_name = concepts_map.get(concept_id, concept_id.replace("-", " ").title())

    if question.style == "multiple_choice":
        result = grade_multiple_choice(body.answer, question.correctAnswer or "")
    elif question.style == "predict_output":
        result = grade_predict_output(body.answer, question.correctAnswer or "")
    elif question.style == "short_answer":
        result = await grade_short_answer(
            question_prompt=question.prompt or "",
            correct_answer=question.correctAnswer or "",
            learner_answer=body.answer,
        )
    else:
        return _error(422, "UNKNOWN_STYLE", f"unsupported question style: {question.style}", request_id=request_id)

    # The curated "why it's right" text: refresher explanation, else the planner's stored one
    # (planner questions reach the store via register_question, which carries no explanation).
    stored_explanation = refresher_explanation or _planner_explanation(body.questionId)

    wrong = None
    if result.correct:
        explanation_text = stored_explanation or result.explanation
    else:
        # Coach the specific mistake; never reveal the answer so the learner can retry.
        wrong = await explain_wrong_answer(
            style=question.style or "",
            prompt=question.prompt or question.statement,
            learner_answer=body.answer,
            correct_answer=question.correctAnswer or "",
            explanation=stored_explanation or "",
            choices=question.choices,
            concept_name=concept_name,
            learner_level=body.learnerLevel,
        )
        explanation_text = wrong.whyWrong

    feedback = {
        "schemaVersion": 2,
        "exerciseId": body.questionId,
        "outcome": "passed" if result.correct else "failed",
        "concept": {"id": concept_id, "name": concept_name},
        "assessedLevel": body.learnerLevel,
        "summary": explanation_text,
        # Concept answers have no code, so complexity is explicitly not applicable (frozen contract: never null).
        "success": {
            "explanation": explanation_text,
            "optimization": {
                "show": False,
                "learner": {"time": "n/a", "space": "n/a"},
                "best": {"time": "n/a", "space": "n/a"},
                "tip": None,
                "betterSolution": None,
            },
        } if result.correct else None,
        "diagnosis": None if wrong is None else {
            "misconception": {
                "id": f"{concept_id}-concept-misread",
                "name": wrong.misconception,
                "explanation": wrong.nextStep,
            },
            "lines": [],
            "failingCase": None,
        },
        "aiGenerated": result.aiGenerated or bool(wrong and wrong.aiGenerated),
    }

    return JSONResponse(
        content={"correct": result.correct, "feedback": feedback},
        headers={"X-Request-Id": request_id},
    )


# ---------------------------------------------------------------------------
# POST /v2/hint
# ---------------------------------------------------------------------------


class V2HintRequest(BaseModel):
    exerciseId: str
    revision: str
    code: str = Field(max_length=16384)
    hintLevel: int = Field(ge=0, le=3)
    learnerLevel: str = "beginner-1"
    lastResult: dict | None = None
    previousHints: list[str] = Field(default_factory=list, max_length=5)


@router.post("/hint")
async def hint(body: V2HintRequest) -> JSONResponse:
    request_id = uuid.uuid4().hex[:12]

    # Resolve exercise
    store = get_store()
    exercise = store.get_exercise(body.exerciseId)

    # Fallback to v1 catalog
    if exercise is None:
        try:
            from ..main import catalog as v1_catalog
            found = v1_catalog.find_exercise(body.exerciseId)
            if found:
                record, ex = found
                exercise = StoredExercise(
                    id=ex.id, revision=record.revision, title=ex.title,
                    language=ex.language, statement=ex.statement,
                    functionName=ex.functionName, starterCode=ex.starterCode,
                    concepts=ex.conceptTags, level=body.learnerLevel,
                    examples=[{"args": e.args, "expected": e.expected} for e in ex.examples],
                    hiddenTests=[{"args": h.args, "expected": h.expected} for h in ex.hiddenTests],
                    referenceSolution=ex.referenceSolution,
                    aiGenerated=False,
                )
        except Exception:
            pass

    # Check A1 planner's generated exercises
    if exercise is None:
        try:
            from ..planner import find_exercise as planner_find_exercise
            priv = planner_find_exercise(body.exerciseId)
            if priv is not None:
                ex = priv.exercise
                exercise = StoredExercise(
                    id=ex.id, revision=priv.revision, title=ex.title,
                    language=priv.language, statement=ex.statement,
                    functionName=ex.functionName, starterCode=ex.starterCode,
                    concepts=priv.concepts, level=priv.level,
                    examples=[{"args": e.args, "expected": e.expected} for e in ex.examples],
                    hiddenTests=[{"args": h.args, "expected": h.expected} for h in ex.hiddenTests],
                    referenceSolution=ex.referenceSolution,
                    aiGenerated=True,
                )
        except Exception:
            pass

    if exercise is None:
        return _error(404, "EXERCISE_NOT_FOUND", "unknown exercise", request_id=request_id)

    # Level-aware hint depth: stronger skill -> fewer, vaguer hints
    tier = _tier_from_level(body.learnerLevel)
    level_penalty = {"beginner": 0, "intermediate": 0, "advanced": 1, "expert": 2}.get(tier, 0)
    effective_level = max(0, min(3, body.hintLevel - level_penalty))

    # Use v1 hint service under the hood
    from ..catalog import ApprovedExercise, Example, HiddenTest
    from .. import hints as hints_mod
    from ..hints import LastResult

    hint_lang = exercise.language if exercise.language in ("python", "javascript", "java", "cpp", "sql") else "python"
    # Use model_construct to bypass Literal["python"] validation on the frozen v1
    # ApprovedExercise model.  The hint service never inspects the language field
    # on the object — it receives the language separately.
    approved = ApprovedExercise.model_construct(
        id=exercise.id,
        title=exercise.title,
        statement=exercise.statement,
        language=hint_lang,
        functionName=exercise.functionName,
        starterCode=exercise.starterCode,
        conceptTags=exercise.concepts,
        examples=[Example(args=e["args"], expected=e["expected"]) for e in exercise.examples],
        hiddenTests=[HiddenTest(args=h["args"], expected=h["expected"]) for h in (exercise.hiddenTests or exercise.examples)],
        referenceSolution=exercise.referenceSolution,
        knownWrongSolution="pass",
    )

    last = None
    if body.lastResult:
        try:
            last = LastResult.model_validate(body.lastResult)
        except Exception:
            pass

    resp = await hints_mod.service().hint(approved, body.code, effective_level, last, body.previousHints, language=hint_lang)

    return JSONResponse(
        content=resp.model_dump(),
        headers={"X-Request-Id": request_id},
    )


# ---------------------------------------------------------------------------
# Internal: register exercise/question from planner
# ---------------------------------------------------------------------------


def register_exercise(
    exercise_id: str,
    revision: str,
    title: str,
    language: str,
    statement: str,
    function_name: str,
    starter_code: str,
    concepts: list[str],
    level: str,
    examples: list[dict],
    hidden_tests: list[dict],
    reference_solution: str,
    ai_generated: bool = True,
) -> None:
    """Called by the planner to register a full exercise for grading."""
    store = get_store()
    store.store_exercise(StoredExercise(
        id=exercise_id, revision=revision, title=title,
        language=language, statement=statement, functionName=function_name,
        starterCode=starter_code, concepts=concepts, level=level,
        examples=examples, hiddenTests=hidden_tests,
        referenceSolution=reference_solution, aiGenerated=ai_generated,
    ))


def register_question(
    question_id: str,
    revision: str,
    title: str,
    style: str,
    prompt: str,
    concepts: list[str],
    level: str,
    correct_answer: str,
    choices: list[dict[str, str]] | None = None,
    ai_generated: bool = True,
) -> None:
    """Called by the planner to register a concept question for grading."""
    store = get_store()
    store.store_question(StoredExercise(
        id=question_id, revision=revision, title=title,
        language="pseudocode", statement=prompt, functionName="",
        starterCode="", concepts=concepts, level=level,
        examples=[], hiddenTests=[], referenceSolution="",
        questionId=question_id, style=style, prompt=prompt,
        choices=choices, correctAnswer=correct_answer,
        aiGenerated=ai_generated,
    ))
