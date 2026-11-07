"""Breakpoint FastAPI application.

Routes:
  GET  /health
  GET  /v1/videos/{video_id}/practice
  POST /v1/submissions
"""

from __future__ import annotations

import logging
import re
import uuid
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .catalog import VIDEO_ID_RE, Catalog, PracticeResponse
from .grader import Grader

logger = logging.getLogger("breakpoint")

# ---------------------------------------------------------------------------
# Lifespan: load catalog and init grader
# ---------------------------------------------------------------------------

catalog: Catalog
grader: Grader


@asynccontextmanager
async def lifespan(app: FastAPI):
    global catalog, grader
    catalog = Catalog()
    grader = Grader()
    logger.info("catalog loaded: %s", catalog.video_ids)
    yield
    await grader.close()


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

    found = catalog.find_exercise(body.exerciseId)
    if found is None:
        return error_response(404, "EXERCISE_NOT_FOUND", "unknown exercise", request_id=request_id)

    record, exercise = found
    if record.revision != body.revision:
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

    return JSONResponse(
        content=result.model_dump(),
        headers={"X-Request-Id": request_id},
    )
