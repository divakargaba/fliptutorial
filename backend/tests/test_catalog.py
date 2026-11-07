"""Tests for catalog models and public response construction."""

from __future__ import annotations

from app.catalog import (
    ApprovedRecord,
    PracticeResponse,
    SubmissionResponse,
    build_public_response,
)


def test_approved_fixture_validates(approved_fixture: dict) -> None:
    record = ApprovedRecord.model_validate(approved_fixture)
    assert record.videoId == "samplevid01"
    assert len(record.breakpoints) == 1
    bp = record.breakpoints[0]
    assert bp.exercise.functionName == "raise_to_power"
    assert len(bp.exercise.hiddenTests) == 3


def test_practice_fixture_validates(practice_fixture: dict) -> None:
    resp = PracticeResponse.model_validate(practice_fixture)
    assert resp.status == "ready"
    assert resp.breakpoints[0].exercise.id == "samplevid01-exponent"


def test_submission_fixture_validates(submission_fixture: dict) -> None:
    resp = SubmissionResponse.model_validate(submission_fixture)
    assert resp.outcome == "wrong_answer"
    assert resp.passedCount == 0


def test_public_response_strips_hidden_data(approved_fixture: dict) -> None:
    record = ApprovedRecord.model_validate(approved_fixture)
    public = build_public_response(record)

    dumped = public.model_dump()
    flat = str(dumped)

    # Must not contain hidden tests, reference code, or functionName
    assert "hiddenTests" not in flat
    assert "referenceSolution" not in flat
    assert "knownWrongSolution" not in flat
    assert "functionName" not in flat
    assert "conceptTags" not in flat

    # Must contain public fields
    assert dumped["status"] == "ready"
    bp = dumped["breakpoints"][0]
    assert "pauseAtS" in bp
    assert "revealAtS" in bp
    assert bp["exercise"]["starterCode"].startswith("def raise_to_power")


def test_invalid_video_id_rejected() -> None:
    import pytest

    with pytest.raises(Exception):
        ApprovedRecord.model_validate(
            {
                "schemaVersion": 1,
                "videoId": "bad id!",
                "revision": "r1",
                "approvedDigest": "abc",
                "breakpoints": [],
            }
        )
