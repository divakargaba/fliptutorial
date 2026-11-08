"""Lane A1 (@abdullahwarraichh): video/section classifier and exercise plans. See contracts/v2/README.md §1."""
from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter(prefix="/v2", tags=["planner"])


def _todo() -> JSONResponse:
    return JSONResponse(status_code=501, content={"error": {"code": "NOT_IMPLEMENTED", "message": "lane A1 in progress", "retryable": False}, "requestId": "stub"})


@router.post("/plan")
async def create_plan() -> JSONResponse:
    return _todo()


@router.get("/plan/{video_id}")
async def get_plan(video_id: str) -> JSONResponse:
    return _todo()
