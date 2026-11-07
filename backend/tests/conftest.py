"""Shared fixtures for backend tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

CONTRACTS_DIR = Path(__file__).resolve().parent.parent.parent / "contracts"


@pytest.fixture()
def practice_fixture() -> dict:
    return json.loads(
        (CONTRACTS_DIR / "practice-response.fixture.json").read_text(encoding="utf-8")
    )


@pytest.fixture()
def approved_fixture() -> dict:
    return json.loads(
        (CONTRACTS_DIR / "approved-record.fixture.json").read_text(encoding="utf-8")
    )


@pytest.fixture()
def submission_fixture() -> dict:
    return json.loads(
        (CONTRACTS_DIR / "submission-response.fixture.json").read_text(encoding="utf-8")
    )
