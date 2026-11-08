"""H2: complexity feedback after a passing submission (offline)."""

from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app import analysis
from app.catalog import ApprovedExercise

CONTRACTS = Path(__file__).resolve().parent.parent.parent / "contracts"

QUAD = "def f(a):\n    for x in a:\n        for y in a:\n            if x + y == 0:\n                return True\n    return False\n"
LINEAR_SET = "def f(a):\n    seen = set()\n    for x in a:\n        if -x in seen:\n            return True\n        seen.add(x)\n    return False\n"


@pytest.mark.parametrize("code,time,space", [
    ("def f(n):\n    return n * n * n\n", "O(1)", "O(1)"),
    ("def f(n):\n    t = 0\n    for i in range(n):\n        t += i\n    return t\n", "O(n)", "O(1)"),
    (QUAD, "O(n^2)", "O(1)"),
    ("def f(a):\n    a = sorted(a)\n    return a[0]\n", "O(n log n)", "O(n)"),
    ("def f(n):\n    c = 0\n    while n > 1:\n        n //= 2\n        c += 1\n    return c\n", "O(log n)", "O(1)"),
    ("def f(n):\n    if n < 2:\n        return n\n    return f(n - 1) + f(n - 2)\n", "O(2^n)", "O(n)"),
    ("def f(a):\n    return [x * 2 for x in a]\n", "O(n)", "O(n)"),
    ("def f(a):\n    out = 0\n    for x in a:\n        out += a.count(x)\n    return out\n", "O(n^2)", "O(1)"),
])
def test_static_estimate(code: str, time: str, space: str) -> None:
    e = analysis.estimate(code, "f")
    assert e is not None and (e.time, e.space) == (time, space)


def test_estimate_handles_bad_code() -> None:
    assert analysis.estimate("def f(:", "f") is None
    assert analysis.estimate("def g(): pass", "f") is None


def ex(reference: str = LINEAR_SET) -> ApprovedExercise:
    rec = json.loads((CONTRACTS / "approved-record.fixture.json").read_text(encoding="utf-8"))
    data = rec["breakpoints"][0]["exercise"] | {"functionName": "f", "referenceSolution": reference}
    return ApprovedExercise.model_validate(data)


async def ok_verify(_ex, _code) -> bool:
    return True


async def bad_verify(_ex, _code) -> bool:
    return False


async def failing_model(_prompt: str) -> str:
    raise RuntimeError("no key")


def test_static_fallback_flags_slower_solution_and_shows_reference() -> None:
    r = asyncio.run(analysis.analyze(ex(), QUAD, ok_verify, model_call=failing_model))
    assert not r.optimal and not r.aiGenerated
    assert r.learner.time == "O(n^2)" and r.best.time == "O(n)"
    assert r.betterSolution == LINEAR_SET and "O(n)" in r.summary


def test_static_fallback_optimal() -> None:
    r = asyncio.run(analysis.analyze(ex(), LINEAR_SET, ok_verify, model_call=failing_model))
    assert r.optimal and r.betterSolution is None and r.tip is None


def model(payload: dict):
    async def call(_prompt: str) -> str:
        return json.dumps(payload)
    return call


VERDICT = {"learnerTime": "O(n^2)", "learnerSpace": "O(1)", "bestTime": "O(n)", "bestSpace": "O(n)",
           "optimal": False, "summary": "You passed, but the nested loop is quadratic.",
           "tip": "Remember what you've seen in a set.", "betterSolution": LINEAR_SET.replace("seen", "s")}


def test_model_verdict_with_verified_solution() -> None:
    r = asyncio.run(analysis.analyze(ex(), QUAD, ok_verify, model_call=model(VERDICT)))
    assert r.aiGenerated and not r.optimal and r.tip and r.betterSolution


def test_unverified_model_solution_is_dropped() -> None:
    r = asyncio.run(analysis.analyze(ex(), QUAD, bad_verify, model_call=model(VERDICT)))
    assert not r.optimal and r.betterSolution is None and r.tip


def test_inconsistent_model_claim_is_corrected() -> None:
    claim = VERDICT | {"learnerTime": "O(n)", "learnerSpace": "O(1)", "bestTime": "O(n)", "bestSpace": "O(1)"}
    r = asyncio.run(analysis.analyze(ex(), LINEAR_SET, ok_verify, model_call=model(claim)))
    assert r.optimal and r.betterSolution is None


@pytest.fixture()
def client(tmp_path: Path):
    d = tmp_path / "approved"
    d.mkdir()
    shutil.copy(CONTRACTS / "approved-record.fixture.json", d / "samplevid01.json")
    with patch("app.catalog.APPROVED_DIR", d), patch("app.analysis.anthropic_model_call", lambda: failing_model):
        from app.main import app

        with TestClient(app) as c:
            yield c


def test_analysis_requires_a_passing_submit(client: TestClient) -> None:
    code = "def raise_to_power(base, exponent):\n    return base ** exponent\n"
    body = {"exerciseId": "samplevid01-exponent", "revision": "demo-1", "code": code}
    r = client.post("/v1/analysis", json=body)
    assert r.status_code == 403 and r.json()["error"]["code"] == "NOT_SOLVED"
    assert "result *= base" not in r.text

    values = iter([8, 1, 0, -8])

    async def submit_case(self, source):
        return "t"

    async def poll(self, token, deadline):
        return {"status": {"id": 3, "description": "Accepted"}, "stdout": json.dumps({"ok": True, "value": next(values)}) + "\n",
                "stderr": None, "compile_output": None, "time": "0.01"}

    with patch("app.grader.Grader._submit_case", submit_case), patch("app.grader.Grader._poll_result", poll):
        assert client.post("/v1/submissions", json={**body, "mode": "submit"}).json()["outcome"] == "passed"
    r = client.post("/v1/analysis", json=body)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["optimal"] is True and data["learner"]["time"] == "O(1)" and data["betterSolution"] is None
