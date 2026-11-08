"""Breakpoint FastAPI application.

Routes:
  GET  /health
  GET  /v1/videos/{video_id}/practice
  POST /v1/submissions
  POST /v1/test-me
  POST /v1/hints
  POST /v1/analysis
"""

from __future__ import annotations

import logging
import os
import uuid
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .catalog import VIDEO_ID_RE, ApprovedExercise, Catalog, PracticeResponse
from .grader import Grader, VerificationCase
from .transcripts import TranscriptFetcher, TranscriptError, clip

logger = logging.getLogger("breakpoint")

# ---------------------------------------------------------------------------
# Lifespan: load catalog and init grader
# ---------------------------------------------------------------------------

catalog: Catalog
grader: Grader
fetcher: TranscriptFetcher


@asynccontextmanager
async def lifespan(app: FastAPI):
    global catalog, grader, fetcher
    catalog = Catalog()
    grader = Grader()
    fetcher = TranscriptFetcher()
    logger.info("catalog loaded: %s", catalog.video_ids)
    yield
    await grader.close()
    await fetcher.close()


app = FastAPI(title="Breakpoint", lifespan=lifespan)

# CORS for the Chrome extension
app.add_middleware(
    CORSMiddleware,
    allow_origins=["chrome-extension://*"],
    allow_origin_regex=r"^chrome-extension://.*$",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Error helpers
# ---------------------------------------------------------------------------


class APIError(BaseModel):
    code: str
    message: str
    retryable: bool


class ErrorResponse(BaseModel):
    error: APIError
    requestId: str


def error_response(
    status: int,
    code: str,
    message: str,
    retryable: bool = False,
    request_id: str | None = None,
) -> JSONResponse:
    rid = request_id or uuid.uuid4().hex[:12]
    body = ErrorResponse(
        error=APIError(code=code, message=message, retryable=retryable),
        requestId=rid,
    )
    return JSONResponse(status_code=status, content=body.model_dump())


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    rid = uuid.uuid4().hex[:12]
    return error_response(exc.status_code, "HTTP_ERROR", str(exc.detail), request_id=rid)


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    rid = uuid.uuid4().hex[:12]
    logger.exception("unhandled error request_id=%s", rid)
    return error_response(500, "INTERNAL", "internal server error", request_id=rid)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health")
async def health():
    return {"status": "ok"}


UNSUPPORTED_TEMPLATE = {
    "schemaVersion": 1,
    "revision": None,
    "status": "unsupported",
    "breakpoints": [],
}


@app.get("/v1/videos/{video_id}/practice")
async def get_practice(video_id: str):
    if not VIDEO_ID_RE.match(video_id):
        return error_response(422, "INVALID_VIDEO_ID", f"malformed video id: {video_id!r}")

    response = catalog.get_public(video_id)
    if response is None:
        return JSONResponse(
            content={**UNSUPPORTED_TEMPLATE, "videoId": video_id}
        )
    return response.model_dump()


# ---------------------------------------------------------------------------
# Submission
# ---------------------------------------------------------------------------


class SubmissionRequest(BaseModel):
    exerciseId: str
    revision: str
    mode: Literal["run", "submit"]
    code: str = Field(max_length=16384)


@app.post("/v1/submissions")
async def submit(body: SubmissionRequest, request: Request):
    request_id = uuid.uuid4().hex[:12]

    if not body.code.strip():
        return error_response(422, "INVALID_CODE", "code is empty", request_id=request_id)

    # Try the approved catalog first
    found = catalog.find_exercise(body.exerciseId)
    exercise: ApprovedExercise | None = None
    revision: str | None = None

    if found is not None:
        record, exercise = found
        revision = record.revision
    else:
        # Fall back to the generated-set cache in testme
        try:
            from .testme import find_exercise as find_generated
        except ImportError:
            find_generated = None
        if find_generated is not None:
            gen_set = find_generated(body.exerciseId)
            if gen_set is None and body.exerciseId.startswith("tm-"):
                return error_response(
                    410, "SET_EXPIRED",
                    "this generated exercise has expired; press Test me again",
                    request_id=request_id,
                )
            if gen_set is not None and gen_set.exercise.id == body.exerciseId:
                exercise = gen_set.exercise
                revision = gen_set.set_id

    if exercise is None:
        return error_response(404, "EXERCISE_NOT_FOUND", "unknown exercise", request_id=request_id)

    if revision != body.revision:
        return error_response(
            409,
            "STALE_EXERCISE",
            "exercise was updated; reload and resubmit",
            retryable=False,
            request_id=request_id,
        )

    try:
        result = await grader.grade(
            exercise=exercise,
            code=body.code,
            mode=body.mode,
            request_id=request_id,
        )
    except grader.Unavailable as exc:
        return error_response(503, "GRADER_UNAVAILABLE", str(exc), retryable=True, request_id=request_id)
    except grader.Timeout as exc:
        return error_response(504, "GRADER_TIMEOUT", str(exc), retryable=True, request_id=request_id)
    except grader.Busy as exc:
        return error_response(429, "BUSY", str(exc), retryable=True, request_id=request_id)

    if body.mode == "submit" and result.outcome == "passed":
        _remember_pass(exercise.id, revision, body.code)

    return JSONResponse(
        content=result.model_dump(),
        headers={"X-Request-Id": request_id},
    )


# ---------------------------------------------------------------------------
# Hints (H1) and efficiency analysis (H2)
# ---------------------------------------------------------------------------

import hashlib
import time as _time

from . import analysis as analysis_mod
from . import hints as hints_mod

# Code that passed Submit, so /v1/analysis never reveals a better solution to
# someone who has not solved the exercise. Kept in memory for an hour.
_PASSED: dict[str, float] = {}
_PASS_TTL_S = 3600


def _pass_key(exercise_id: str, revision: str | None, code: str) -> str:
    return hashlib.sha256(f"{exercise_id}\0{revision}\0{code}".encode()).hexdigest()


def _remember_pass(exercise_id: str, revision: str | None, code: str) -> None:
    now = _time.monotonic()
    for k in [k for k, t in _PASSED.items() if now - t > _PASS_TTL_S]:
        del _PASSED[k]
    _PASSED[_pass_key(exercise_id, revision, code)] = now


def _resolve_exercise(exercise_id: str, revision: str, request_id: str):
    """(exercise, None) or (None, error JSONResponse) for approved or generated exercises."""
    found = catalog.find_exercise(exercise_id)
    if found is not None:
        record, exercise = found
        if record.revision != revision:
            return None, error_response(409, "STALE_EXERCISE", "exercise was updated; reload", retryable=False,
                                        request_id=request_id)
        return exercise, None
    try:
        from .testme import find_exercise as find_generated
    except ImportError:
        find_generated = None
    gen = find_generated(exercise_id) if find_generated else None
    if gen is not None and gen.exercise.id == exercise_id:
        if gen.set_id != revision:
            return None, error_response(409, "STALE_EXERCISE", "exercise was updated; reload", retryable=False,
                                        request_id=request_id)
        return gen.exercise, None
    if exercise_id.startswith("tm-"):
        return None, error_response(410, "SET_EXPIRED", "this generated exercise has expired; press Test me again",
                                    request_id=request_id)
    return None, error_response(404, "EXERCISE_NOT_FOUND", "unknown exercise", request_id=request_id)


class HintRequest(BaseModel):
    exerciseId: str
    revision: str
    code: str = Field(max_length=16384)
    level: int = Field(ge=0, le=hints_mod.MAX_LEVEL)
    lastResult: hints_mod.LastResult | None = None
    previousHints: list[str] = Field(default_factory=list, max_length=6)


@app.post("/v1/hints")
async def get_hint(body: HintRequest):
    request_id = uuid.uuid4().hex[:12]
    exercise, err = _resolve_exercise(body.exerciseId, body.revision, request_id)
    if err is not None:
        return err
    resp = await hints_mod.service().hint(exercise, body.code, body.level, body.lastResult,
                                          [h[:400] for h in body.previousHints])
    return JSONResponse(content=resp.model_dump(), headers={"X-Request-Id": request_id})


class AnalysisRequest(BaseModel):
    exerciseId: str
    revision: str
    code: str = Field(max_length=16384)


@app.post("/v1/analysis")
async def get_analysis(body: AnalysisRequest):
    request_id = uuid.uuid4().hex[:12]
    exercise, err = _resolve_exercise(body.exerciseId, body.revision, request_id)
    if err is not None:
        return err
    if _pass_key(exercise.id, body.revision, body.code) not in _PASSED:
        return error_response(403, "NOT_SOLVED", "submit a passing solution first", retryable=False,
                              request_id=request_id)

    async def verify(ex: ApprovedExercise, code: str) -> bool:
        try:
            graded = await grader.grade(exercise=ex, code=code, mode="submit", request_id=request_id)
        except Exception:  # noqa: BLE001
            return False
        return graded.outcome == "passed"

    resp = await analysis_mod.analyze(exercise, body.code, verify)
    return JSONResponse(content=resp.model_dump(), headers={"X-Request-Id": request_id})


# ---------------------------------------------------------------------------
# Test me (T4)
# ---------------------------------------------------------------------------

TESTME_ENABLED = os.environ.get("BREAKPOINT_TESTME", "").lower() in ("1", "true", "yes")


class TestMeRequest(BaseModel):
    videoId: str
    timestampS: float = Field(ge=0)


# Error code → (HTTP status, retryable)
_TRANSCRIPT_ERROR_MAP: dict[str, tuple[int, bool]] = {
    "NO_CAPTIONS": (404, False),
    "TOO_EARLY": (422, False),
    "INVALID_REQUEST": (422, False),
    "CAPTIONS_UNAVAILABLE": (503, True),
}


@app.post("/v1/test-me")
async def test_me(body: TestMeRequest, request: Request):
    request_id = uuid.uuid4().hex[:12]

    if not TESTME_ENABLED:
        return error_response(
            404, "NOT_FOUND", "test-me is not enabled on this server",
            request_id=request_id,
        )

    if not VIDEO_ID_RE.match(body.videoId):
        return error_response(
            422, "INVALID_VIDEO_ID", f"malformed video id: {body.videoId!r}",
            request_id=request_id,
        )

    # Step 1: Fetch and clip transcript (T1)
    try:
        transcript = await fetcher.get(body.videoId)
    except TranscriptError as exc:
        status, retryable = _TRANSCRIPT_ERROR_MAP.get(
            exc.code, (503, True)
        )
        code = "GENERATOR_UNAVAILABLE" if exc.code == "CAPTIONS_UNAVAILABLE" else exc.code
        return error_response(status, code, exc.message, retryable=retryable, request_id=request_id)

    try:
        clipped = clip(transcript, body.timestampS)
    except TranscriptError as exc:
        status, retryable = _TRANSCRIPT_ERROR_MAP.get(exc.code, (422, False))
        return error_response(status, exc.code, exc.message, retryable=retryable, request_id=request_id)

    # Step 2: Generate exercise (T2 — requires testme.py)
    try:
        from .testme import generate, get_set, TestMeError
    except ImportError:
        return error_response(
            503, "GENERATOR_UNAVAILABLE",
            "exercise generator not available yet",
            retryable=True, request_id=request_id,
        )

    async def verify_fn(
        function_name: str,
        reference_solution: str,
        known_wrong_solution: str,
        test_cases: list[dict],
    ) -> bool:
        cases = [VerificationCase(**tc) for tc in test_cases]
        result = await grader.verify_exercise(
            function_name, reference_solution, known_wrong_solution, cases,
        )
        return result.valid

    try:
        gen_set = await generate(clipped, verify_fn)
    except TestMeError as exc:
        code_map: dict[str, tuple[int, bool]] = {
            "NOT_PYTHON": (422, False),
            "GENERATOR_UNAVAILABLE": (503, True),
            "GENERATOR_TIMEOUT": (504, True),
            "BUSY": (429, True),
        }
        status, retryable = code_map.get(exc.code, (503, True))
        return error_response(status, exc.code, exc.message, retryable=retryable, request_id=request_id)
    except grader.Unavailable as exc:
        return error_response(503, "GENERATOR_UNAVAILABLE", str(exc), retryable=True, request_id=request_id)
    except grader.Timeout as exc:
        return error_response(504, "GENERATOR_TIMEOUT", str(exc), retryable=True, request_id=request_id)
    except grader.Busy as exc:
        return error_response(429, "BUSY", str(exc), retryable=True, request_id=request_id)

    # Build public response (no hidden tests, reference, or wrong solution)
    response = {
        "setId": gen_set.set_id,
        "generated": True,
        "aiGenerated": True,
        "exercise": {
            "id": gen_set.exercise.id,
            "title": gen_set.exercise.title,
            "statement": gen_set.exercise.statement,
            "language": gen_set.exercise.language,
            "starterCode": gen_set.exercise.starterCode,
            "examples": [
                {"args": ex.args, "expected": ex.expected}
                for ex in gen_set.exercise.examples
            ],
        },
    }

    logger.info(
        "test-me request_id=%s video=%s ts=%.1f set=%s",
        request_id, body.videoId, body.timestampS, gen_set.set_id,
    )

    return JSONResponse(
        content=response,
        headers={"X-Request-Id": request_id},
    )
