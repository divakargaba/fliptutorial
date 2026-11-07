"""Pydantic models for approved exercises and the public practice response.

Private approved records live in content/approved/{videoId}.json.
The public response strips hidden tests, reference code, and internal fields.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator

# ---------------------------------------------------------------------------
# Approved record (private, written by app.prepare publish)
# ---------------------------------------------------------------------------

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

APPROVED_DIR = Path(__file__).resolve().parent.parent / "content" / "approved"


class Example(BaseModel):
    args: list[int | float | str | bool | None]
    expected: int | float | str | bool | None


class HiddenTest(BaseModel):
    args: list[int | float | str | bool | None]
    expected: int | float | str | bool | None


class ApprovedExercise(BaseModel):
    id: str
    title: str
    statement: str
    language: Literal["python"]
    functionName: str
    starterCode: str
    conceptTags: list[str] = Field(default_factory=list)
    examples: list[Example] = Field(min_length=1)
    hiddenTests: list[HiddenTest] = Field(min_length=1)
    referenceSolution: str
    knownWrongSolution: str


class ApprovedBreakpoint(BaseModel):
    id: str
    windowStartS: float
    setupEndS: float
    firstSpokenRevealS: float | None
    firstVisualRevealS: float | None
    revealAtS: float
    pauseAtS: float
    windowEndS: float
    exercise: ApprovedExercise


class ApprovedRecord(BaseModel):
    schemaVersion: Literal[1] = 1
    videoId: str
    revision: str
    approvedDigest: str
    breakpoints: list[ApprovedBreakpoint]

    @field_validator("videoId")
    @classmethod
    def check_video_id(cls, v: str) -> str:
        if not VIDEO_ID_RE.match(v):
            raise ValueError(f"invalid video id: {v!r}")
        return v


# ---------------------------------------------------------------------------
# Public response (sent to the extension, no hidden data)
# ---------------------------------------------------------------------------


class PublicExample(BaseModel):
    args: list[int | float | str | bool | None]
    expected: int | float | str | bool | None


class PublicExercise(BaseModel):
    id: str
    title: str
    statement: str
    language: str
    starterCode: str
    examples: list[PublicExample]


class PublicBreakpoint(BaseModel):
    id: str
    pauseAtS: float
    revealAtS: float
    exercise: PublicExercise


class PracticeResponse(BaseModel):
    schemaVersion: Literal[1] = 1
    videoId: str
    revision: str | None
    status: Literal["ready", "unsupported"]
    breakpoints: list[PublicBreakpoint]


# ---------------------------------------------------------------------------
# Submission response (grading result)
# ---------------------------------------------------------------------------


class VisibleResult(BaseModel):
    kind: Literal["visible"] = "visible"
    index: int
    passed: bool
    args: list[int | float | str | bool | None] | None = None
    expected: int | float | str | bool | None = None
    actual: int | float | str | bool | None = None
    diagnostic: str | None = None


class HiddenResult(BaseModel):
    kind: Literal["hidden"] = "hidden"
    index: int
    passed: bool


class SubmissionResponse(BaseModel):
    outcome: Literal[
        "passed",
        "wrong_answer",
        "syntax_error",
        "runtime_error",
        "time_limit",
        "invalid_output",
    ]
    passedCount: int
    totalCount: int
    results: list[VisibleResult | HiddenResult]


# ---------------------------------------------------------------------------
# Catalog: loads approved/*.json at startup
# ---------------------------------------------------------------------------


def build_public_response(record: ApprovedRecord) -> PracticeResponse:
    """Build the public practice response from an approved record.

    Explicitly maps fields so hidden tests, reference code, functionName,
    and conceptTags never reach the browser.
    """
    breakpoints = []
    for bp in record.breakpoints:
        ex = bp.exercise
        public_ex = PublicExercise(
            id=ex.id,
            title=ex.title,
            statement=ex.statement,
            language=ex.language,
            starterCode=ex.starterCode,
            examples=[
                PublicExample(args=e.args, expected=e.expected)
                for e in ex.examples
            ],
        )
        breakpoints.append(
            PublicBreakpoint(
                id=bp.id,
                pauseAtS=bp.pauseAtS,
                revealAtS=bp.revealAtS,
                exercise=public_ex,
            )
        )
    return PracticeResponse(
        schemaVersion=record.schemaVersion,
        videoId=record.videoId,
        revision=record.revision,
        status="ready",
        breakpoints=breakpoints,
    )


class Catalog:
    """Loads and indexes approved exercise files at startup."""

    def __init__(self, approved_dir: Path | None = None) -> None:
        self._dir = approved_dir or APPROVED_DIR
        self._records: dict[str, ApprovedRecord] = {}
        self._public: dict[str, PracticeResponse] = {}
        self._load()

    def _load(self) -> None:
        if not self._dir.is_dir():
            return
        for path in sorted(self._dir.glob("*.json")):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                record = ApprovedRecord.model_validate(raw)
            except Exception as exc:
                raise RuntimeError(
                    f"invalid approved file {path.name}: {exc}"
                ) from exc
            self._records[record.videoId] = record
            self._public[record.videoId] = build_public_response(record)

    def get_public(self, video_id: str) -> PracticeResponse | None:
        return self._public.get(video_id)

    def get_record(self, video_id: str) -> ApprovedRecord | None:
        return self._records.get(video_id)

    def find_exercise(
        self, exercise_id: str
    ) -> tuple[ApprovedRecord, ApprovedExercise] | None:
        for record in self._records.values():
            for bp in record.breakpoints:
                if bp.exercise.id == exercise_id:
                    return record, bp.exercise
        return None

    @property
    def video_ids(self) -> list[str]:
        return list(self._records.keys())
