"""Lane A2 (@divakargaba's agent): level-aware feedback, diagnosis, concept answers, multi-language grading.
See contracts/v2/README.md §2. Language runners live in app/runners/."""
from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter(prefix="/v2", tags=["feedback"])


def _todo() -> JSONResponse:
    return JSONResponse(status_code=501, content={"error": {"code": "NOT_IMPLEMENTED", "message": "lane A2 in progress", "retryable": False}, "requestId": "stub"})


@router.post("/submit")
async def submit() -> JSONResponse:
    return _todo()


@router.post("/answer")
async def answer() -> JSONResponse:
    return _todo()


@router.post("/hint")
async def hint() -> JSONResponse:
    return _todo()
