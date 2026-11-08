"""Lane A1 (@abdullahwarraichh): video/section classifier and exercise plans. See contracts/v2/README.md §1.

Endpoints:
  POST /v2/plan { videoId, learnerLevel? } -> ExercisePlan (may be ``planning``; poll GET)
  GET  /v2/plan/{videoId}?learnerLevel=   -> latest ExercisePlan, 404 PLAN_NOT_FOUND if never requested

For lane A2 (grading planned items; private data never leaves the backend):
  ``find_exercise(exercise_id)`` -> PrivateExercise | None   (.exercise is a v1 ``ApprovedExercise``
      with hidden tests, reference and known-wrong solution; .revision, .concepts, .level, .language)
  ``find_question(question_id)`` -> PrivateQuestion | None   (.answer, .explanation, .style, .choices, .revision)
"""

from __future__ import annotations

import os
import uuid

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..catalog import VIDEO_ID_RE, ApprovedExercise
from ..transcripts import Transcript, TranscriptFetcher
from .generate import PrivateExercise, PrivateQuestion
from .service import Planner, PlannerUnavailable
from .vocab import DEFAULT_LEVEL, is_level

router = APIRouter(prefix="/v2", tags=["planner"])

DEFAULT_MODEL = "claude-haiku-5-5"
CALL_TIMEOUT_S = 60.0
MAX_OUTPUT_TOKENS = 8192


def resolve_model() -> str:
    return os.environ.get("ANTHROPIC_PLANNER_MODEL") or DEFAULT_MODEL


def anthropic_model_call():
    """Structured-output Claude call; key read from env / backend/.env only, never logged."""
    from ..testme import BACKEND_DIR, strict_schema

    try:
        from dotenv import load_dotenv

        load_dotenv(BACKEND_DIR / ".env")
    except ImportError:  # pragma: no cover
        pass
    client = None
    schemas: dict[type, dict] = {}

    async def call(prompt: str, model: type[BaseModel]) -> str:
        nonlocal client
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise PlannerUnavailable("Planner unavailable: ANTHROPIC_API_KEY is not set.")
        import anthropic

        if client is None:
            client = anthropic.AsyncAnthropic(api_key=api_key, max_retries=2, timeout=CALL_TIMEOUT_S)
        schema = schemas.setdefault(model, strict_schema(model))
        try:
            resp = await client.messages.create(
                model=resolve_model(),
                max_tokens=MAX_OUTPUT_TOKENS,
                messages=[{"role": "user", "content": prompt}],
                output_config={"format": {"type": "json_schema", "schema": schema}},
            )
        except Exception as exc:
            raise PlannerUnavailable(f"Planner unavailable: model call failed ({type(exc).__name__}).") from exc
        return "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text")

    return call


async def judge0_verify(ex: ApprovedExercise) -> bool:
    """Reference passes every case and known-wrong fails one, via the app's shared grader."""
    import asyncio

    from .. import main
    from ..grader import VerificationCase

    cases = [VerificationCase(args=c.args, expected=c.expected) for c in [*ex.examples, *ex.hiddenTests]]
    for _ in range(30):
        try:
            result = await main.grader.verify_exercise(ex.functionName, ex.referenceSolution,
                                                       ex.knownWrongSolution, cases)
            return result.valid
        except main.grader.Busy:
            await asyncio.sleep(1.0)
        except (main.grader.Unavailable, main.grader.Timeout):
            return False
    return False


_fetcher: TranscriptFetcher | None = None


async def fetch_transcript(video_id: str) -> Transcript:
    global _fetcher
    if _fetcher is None:
        _fetcher = TranscriptFetcher()
    return await _fetcher.get(video_id)


_planner: Planner | None = None


def get_planner() -> Planner:
    global _planner
    if _planner is None:
        _planner = Planner(fetch_transcript=fetch_transcript, model_call=anthropic_model_call(), verify=judge0_verify)
    return _planner


def set_planner(planner: Planner | None) -> None:
    """Tests inject a planner with stubbed model/verify/captions."""
    global _planner
    _planner = planner


def find_exercise(exercise_id: str) -> PrivateExercise | None:
    return get_planner().find_exercise(exercise_id)


def find_question(question_id: str) -> PrivateQuestion | None:
    return get_planner().find_question(question_id)


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={
        "error": {"code": code, "message": message, "retryable": False}, "requestId": uuid.uuid4().hex[:12]})


class PlanRequest(BaseModel):
    videoId: str
    learnerLevel: str | None = None


def _check(video_id: str, level: str | None) -> JSONResponse | str:
    if not VIDEO_ID_RE.match(video_id or ""):
        return _error(422, "INVALID_VIDEO_ID", "malformed video id")
    level = level or DEFAULT_LEVEL
    if not is_level(level):
        return _error(422, "INVALID_LEVEL", "learnerLevel must be a level id from contracts/v2/levels.json")
    return level


@router.post("/plan")
async def create_plan(body: PlanRequest) -> JSONResponse:
    level = _check(body.videoId, body.learnerLevel)
    if isinstance(level, JSONResponse):
        return level
    return JSONResponse(content=get_planner().request(body.videoId, level))


@router.get("/plan/{video_id}")
async def get_plan(video_id: str, learnerLevel: str | None = None) -> JSONResponse:
    level = _check(video_id, learnerLevel)
    if isinstance(level, JSONResponse):
        return level
    plan = get_planner().peek(video_id, level)
    if plan is None:
        return _error(404, "PLAN_NOT_FOUND", "no plan for this video yet; POST /v2/plan first")
    return JSONResponse(content=plan)
