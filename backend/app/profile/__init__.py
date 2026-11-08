"""Lane B1 (@spectaboy): local accounts, per-concept levels, decay/refreshers, in-demand skills, matching.
See contracts/v2/README.md §3-4. Local storage only (SQLite file under backend/data/, gitignored)."""
from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter(prefix="/v2", tags=["profile"])


def _todo() -> JSONResponse:
    return JSONResponse(status_code=501, content={"error": {"code": "NOT_IMPLEMENTED", "message": "lane B1 in progress", "retryable": False}, "requestId": "stub"})


@router.post("/events")
async def ingest_events() -> JSONResponse:
    return _todo()


@router.get("/accounts")
async def accounts() -> JSONResponse:
    return _todo()


@router.get("/profile/{account_id}")
async def profile(account_id: str) -> JSONResponse:
    return _todo()


@router.get("/refresher/{account_id}")
async def refresher(account_id: str) -> JSONResponse:
    return _todo()


@router.get("/skills/in-demand")
async def in_demand() -> JSONResponse:
    return _todo()


@router.get("/matches/{account_id}")
async def matches(account_id: str) -> JSONResponse:
    return _todo()
