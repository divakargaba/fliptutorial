"""Lane A1 (@abdullahwarraichh): video/section classifier and exercise plans. See contracts/v2/README.md §1.

Endpoints:
  POST /v2/plan { videoId, learnerLevel?, learnerLevels? } -> ExercisePlan (may be ``planning``; poll GET).
       Each pause is planned at ``learnerLevels[pause concept]``, else at ``learnerLevel`` (default beginner-1).
  GET  /v2/plan/{videoId}?learnerLevel=   -> latest ExercisePlan with the levels of the latest POST
       (``learnerLevel`` overrides its default level); 404 PLAN_NOT_FOUND if never requested

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
from .screen import ScreenCheck, StoryboardFetcher, image_block
from .service import Planner, PlannerUnavailable
from .vocab import DEFAULT_LEVEL, concept_ids, is_level

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

    async def call(prompt: str, model: type[BaseModel], jpeg: bytes | None = None) -> str:
        nonlocal client
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise PlannerUnavailable("Planner unavailable: ANTHROPIC_API_KEY is not set.")
        import anthropic

        if client is None:
            client = anthropic.AsyncAnthropic(api_key=api_key, max_retries=2, timeout=CALL_TIMEOUT_S)
        schema = schemas.setdefault(model, strict_schema(model))
        content: str | list = prompt if jpeg is None else [image_block(jpeg),{"type": "text", "text": prompt}]
        try:
            resp = await client.messages.create(
                model=resolve_model(),
                max_tokens=MAX_OUTPUT_TOKENS,
                messages=[{"role": "user", "content": content}],
                output_config={"format": {"type": "json_schema", "schema": schema}},
            )
        except Exception as exc:
            raise PlannerUnavailable(f"Planner unavailable: model call failed ({type(exc).__name__}).") from exc
        return "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text")

    return call


def screen_check(model_call) -> ScreenCheck | None:
    """Answer-on-screen check (Goal 6); ``PLANNER_SCREEN_CHECK=0`` turns it off."""
    if os.environ.get("PLANNER_SCREEN_CHECK", "1") == "0":
        return None

    async def vision(prompt: str, jpeg: bytes, model: type[BaseModel]) -> str:
        return await model_call(prompt, model, jpeg)

    return ScreenCheck(StoryboardFetcher(), vision)


async def runner_verify(ex: ApprovedExercise) -> bool:
    """Non-Python exercises, via lane A2's runner for ``ex.language``: the reference passes every case,
    the known-wrong solution compiles and fails at least one, and the starter compiles."""
    import asyncio

    from ..runners import RunnerBusy, RunnerTimeout, RunnerUnavailable, get_runner

    runner = get_runner(ex.language)
    examples = [{"args": c.args, "expected": c.expected} for c in ex.examples]
    hidden = [{"args": c.args, "expected": c.expected} for c in ex.hiddenTests]

    async def grade(code: str, mode: str):
        for _ in range(30):
            try:
                return await runner.grade(code, ex.functionName, examples, hidden, mode)
            except RunnerBusy:
                await asyncio.sleep(1.0)
        raise RunnerUnavailable("runner stayed busy")

    try:
        ref = await grade(ex.referenceSolution, "submit")
        if ref.passedCount != ref.totalCount:
            return False
        wrong = await grade(ex.knownWrongSolution, "submit")
        if wrong.passedCount >= wrong.totalCount or any(r.outcome == "syntax_error" for r in wrong.results):
            return False
        starter = await grade(ex.starterCode, "run")
        return not any(r.outcome == "syntax_error" for r in starter.results)
    except (RunnerUnavailable, RunnerTimeout):
        return False


async def judge0_verify(ex: ApprovedExercise) -> bool:
    """Reference passes every case and known-wrong fails one, via the app's shared grader."""
    import asyncio

    if ex.language != "python":
        return await runner_verify(ex)

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
        call = anthropic_model_call()
        _planner = Planner(fetch_transcript=fetch_transcript, model_call=call, verify=judge0_verify,
                           screen_check=screen_check(call))
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


MAX_LEARNER_LEVELS = 500


class PlanRequest(BaseModel):
    videoId: str
    learnerLevel: str | None = None
    learnerLevels: dict[str, str] | None = None  # {conceptId: levelId}, applied per pause concept


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
    levels = body.learnerLevels or {}
    if len(levels) > MAX_LEARNER_LEVELS or not all(is_level(v) for v in levels.values()):
        return _error(422, "INVALID_LEVEL", "learnerLevels must map concept ids to level ids from contracts/v2/levels.json")
    known = set(concept_ids())  # concepts outside the vocabulary never match a pause: drop them
    levels = {c: v for c, v in levels.items() if c in known}
    return JSONResponse(content=get_planner().request(body.videoId, level, levels))


@router.get("/plan/{video_id}")
async def get_plan(video_id: str, learnerLevel: str | None = None) -> JSONResponse:
    level = _check(video_id, learnerLevel)
    if isinstance(level, JSONResponse):
        return level
    plan = get_planner().peek(video_id, level if learnerLevel else None)
    if plan is None:
        return _error(404, "PLAN_NOT_FOUND", "no plan for this video yet; POST /v2/plan first")
    return JSONResponse(content=plan)
