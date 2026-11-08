"""/v1/submissions grades non-Python Test me exercises with lane A2's runner for their language.

Judge0 is stubbed at the runner's submit/poll layer, so the real wrapper, server-side
comparison and SubmissionResponse mapping run offline.
"""

from __future__ import annotations

import json
import time
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

import app.main as main
from app.catalog import Example, HiddenTest
from app.planner.generate import PlannedExercise
from app.runners import RunnerTimeout, RunnerUnavailable
from app.testme import GeneratedSet, default_generator

FN = {"javascript": "add3", "java": "add3", "cpp": "add3"}


def _seed(language: str, set_id: str) -> str:
    ex = PlannedExercise(
        id=f"{set_id}-1", title="Add three", statement="Return a + b + c.", language=language,
        functionName="add3", starterCode="// write add3", conceptTags=["functions"],
        examples=[Example(args=[1, 2, 3], expected=6)],
        hiddenTests=[HiddenTest(args=[0, 0, 0], expected=0), HiddenTest(args=[-1, 1, 5], expected=5)],
        referenceSolution="ref", knownWrongSolution="wrong",
    )
    now = time.monotonic()
    default_generator()._sets[set_id] = GeneratedSet(
        set_id=set_id, video_id="test12345ab", timestamp_s=100.0, exercise=ex,
        concept_tags=("functions",), model="stub", created_at=now, expires_at=now + 3600,
    )
    return ex.id


def _ok(value) -> dict:
    return {"status": {"id": 3}, "stdout": json.dumps({"ok": True, "value": value}) + "\n"}


def _sandbox(values: list):
    """submit stub records the source; poll returns the next queued Judge0 result."""
    sources: list[str] = []

    async def submit(self, source: str) -> str:
        sources.append(source)
        return f"t{len(sources) - 1}"

    async def poll(self, token: str, deadline: float) -> dict:
        v = values[int(token[1:])]
        return v if isinstance(v, dict) and "status" in v else _ok(v)

    return sources, submit, poll


@pytest.fixture()
def client():
    with TestClient(main.app) as c:
        yield c


def _post(client, ex_id, set_id, mode, code="function add3(a,b,c){return a+b+c}"):
    return client.post("/v1/submissions", json={"exerciseId": ex_id, "revision": set_id, "mode": mode, "code": code})


@pytest.mark.parametrize("language", ["javascript", "java", "cpp"])
def test_submit_passes_with_language_runner(client, language):
    set_id = f"tm-lang{language[:4]}pass1"
    ex_id = _seed(language, set_id)
    sources, submit, poll = _sandbox([6, 0, 5])
    with patch("app.runners.base.Runner._submit_case", submit), \
         patch("app.runners.base.Runner._poll_result", poll), \
         patch("app.grader.Grader.grade", AsyncMock(side_effect=AssertionError("python grader used"))):
        resp = _post(client, ex_id, set_id, "submit")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["outcome"] == "passed" and body["passedCount"] == 3 and body["totalCount"] == 3
    assert [r["kind"] for r in body["results"]] == ["visible", "hidden", "hidden"]
    assert body["results"][0] == {"kind": "visible", "index": 0, "passed": True, "args": [1, 2, 3],
                                  "expected": 6, "actual": 6, "diagnostic": None}
    assert set(body["results"][1]) == {"kind", "index", "passed"}
    assert len(sources) == 3 and all("add3" in s for s in sources)
    # Hidden expected values never enter the sandbox.
    assert not any('"expected"' in s for s in sources)
    # A passing submit unlocks /v1/analysis like Python does.
    assert main._pass_key(ex_id, set_id, "function add3(a,b,c){return a+b+c}") in main._PASSED


def test_run_mode_grades_visible_examples_only(client):
    set_id = "tm-langjsrunonly"
    ex_id = _seed("javascript", set_id)
    sources, submit, poll = _sandbox([7])
    with patch("app.runners.base.Runner._submit_case", submit), \
         patch("app.runners.base.Runner._poll_result", poll):
        body = _post(client, ex_id, set_id, "run").json()
    assert body["outcome"] == "wrong_answer" and body["passedCount"] == 0 and body["totalCount"] == 1
    assert body["results"][0]["actual"] == 7 and len(sources) == 1


def test_compile_error_is_syntax_error_with_diagnostic(client):
    set_id = "tm-langjavacompile"
    ex_id = _seed("java", set_id)
    err = {"status": {"id": 6}, "compile_output": "Main.java:3: error: ';' expected"}
    _, submit, poll = _sandbox([err])
    with patch("app.runners.base.Runner._submit_case", submit), \
         patch("app.runners.base.Runner._poll_result", poll):
        body = _post(client, ex_id, set_id, "run", code="class Solution {").json()
    assert body["outcome"] == "syntax_error"
    assert "expected" in body["results"][0]["diagnostic"]


@pytest.mark.parametrize("exc,status,code", [(RunnerUnavailable("down"), 503, "GRADER_UNAVAILABLE"),
                                             (RunnerTimeout("slow"), 504, "GRADER_TIMEOUT")])
def test_runner_failures_map_to_retryable_errors(client, exc, status, code):
    set_id = f"tm-langerr{status}"
    ex_id = _seed("cpp", set_id)
    with patch("app.runners.base.Runner.grade", AsyncMock(side_effect=exc)):
        resp = _post(client, ex_id, set_id, "submit")
    assert resp.status_code == status
    assert resp.json()["error"]["code"] == code and resp.json()["error"]["retryable"] is True


def test_stale_revision_and_unsupported_language(client):
    set_id = "tm-langstalecheck"
    ex_id = _seed("javascript", set_id)
    assert _post(client, ex_id, "tm-other", "run").status_code == 409
    set_id2 = "tm-langrubynorun"  # rust is graded since the stdio runner; ruby has no runner
    ex_id2 = _seed("ruby", set_id2)
    resp = _post(client, ex_id2, set_id2, "run")
    assert resp.status_code == 422 and resp.json()["error"]["code"] == "UNSUPPORTED_LANGUAGE"
