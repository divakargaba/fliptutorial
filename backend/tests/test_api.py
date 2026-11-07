"""API and grading tests with stubbed Judge0.

Covers every PRD §8 API row:
  - Supported and unknown video IDs
  - Malformed request
  - Stale revision
  - Visible vs hidden output
  - Incorrect and correct code
  - Forged verdict text
  - Bool vs int type strictness
  - Malformed sandbox output
  - Sandbox timeout
  - Upstream Judge0 error
  - Concurrency saturation
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

CONTRACTS_DIR = Path(__file__).resolve().parent.parent.parent / "contracts"


@pytest.fixture()
def approved_dir(tmp_path: Path) -> Path:
    """Create a temp approved dir with the fixture record."""
    d = tmp_path / "approved"
    d.mkdir()
    src = CONTRACTS_DIR / "approved-record.fixture.json"
    shutil.copy(src, d / "samplevid01.json")
    return d


@pytest.fixture()
def client(approved_dir: Path) -> TestClient:
    """Create a test client with the catalog pointing to our temp dir."""
    with patch("app.catalog.APPROVED_DIR", approved_dir):
        from app.main import app

        with TestClient(app) as c:
            yield c


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


def test_health(client: TestClient) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


# ---------------------------------------------------------------------------
# GET /v1/videos/{video_id}/practice
# ---------------------------------------------------------------------------


def test_supported_video(client: TestClient) -> None:
    resp = client.get("/v1/videos/samplevid01/practice")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ready"
    assert data["videoId"] == "samplevid01"
    assert len(data["breakpoints"]) == 1
    ex = data["breakpoints"][0]["exercise"]
    assert "hiddenTests" not in str(data)
    assert "referenceSolution" not in str(data)
    assert "functionName" not in str(data)


def test_unknown_video(client: TestClient) -> None:
    resp = client.get("/v1/videos/xxxxxxxxxxx/practice")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "unsupported"
    assert data["breakpoints"] == []


def test_malformed_video_id(client: TestClient) -> None:
    resp = client.get("/v1/videos/bad!id/practice")
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Submission helpers
# ---------------------------------------------------------------------------


def _submit(
    client: TestClient,
    code: str = "def raise_to_power(base, exponent):\n    return base ** exponent\n",
    mode: str = "run",
    exercise_id: str = "samplevid01-exponent",
    revision: str = "demo-1",
) -> Any:
    return client.post(
        "/v1/submissions",
        json={
            "exerciseId": exercise_id,
            "revision": revision,
            "mode": mode,
            "code": code,
        },
    )


def _judge0_success(value: Any) -> dict:
    """Simulate a successful Judge0 response."""
    return {
        "status": {"id": 3, "description": "Accepted"},
        "stdout": json.dumps({"ok": True, "value": value}) + "\n",
        "stderr": None,
        "compile_output": None,
        "time": "0.01",
    }


def _judge0_runtime_error(msg: str = "ZeroDivisionError: ...") -> dict:
    return {
        "status": {"id": 11, "description": "Runtime Error (NZEC)"},
        "stdout": None,
        "stderr": msg,
        "compile_output": None,
        "time": "0.01",
    }


def _judge0_syntax_error() -> dict:
    return {
        "status": {"id": 6, "description": "Compilation Error"},
        "stdout": None,
        "stderr": None,
        "compile_output": "SyntaxError: invalid syntax",
        "time": "0.00",
    }


def _judge0_time_limit() -> dict:
    return {
        "status": {"id": 5, "description": "Time Limit Exceeded"},
        "stdout": None,
        "stderr": None,
        "compile_output": None,
        "time": "2.00",
    }


# ---------------------------------------------------------------------------
# POST /v1/submissions — grading tests
# ---------------------------------------------------------------------------


class TestCorrectCode:
    """Test correct submissions with stubbed Judge0."""

    def test_run_correct(self, client: TestClient) -> None:
        """Run mode checks only visible examples."""
        mock_submit = AsyncMock(return_value="token-1")
        mock_poll = AsyncMock(return_value=_judge0_success(8))

        with patch("app.grader.Grader._submit_case", mock_submit), patch(
            "app.grader.Grader._poll_result", mock_poll
        ):
            resp = _submit(client, mode="run")

        assert resp.status_code == 200
        data = resp.json()
        assert data["outcome"] == "passed"
        assert data["passedCount"] == 1
        assert data["totalCount"] == 1
        assert all(r["kind"] == "visible" for r in data["results"])

    def test_submit_correct_all_pass(self, client: TestClient) -> None:
        """Submit mode checks visible + hidden cases."""
        call_idx = {"n": 0}
        expected_values = [8, 1, 0, -8]

        async def mock_submit_fn(self, source):
            idx = call_idx["n"]
            call_idx["n"] += 1
            return f"token-{idx + 1}"

        async def mock_poll_fn(self, token, deadline):
            idx = int(token.split("-")[1]) - 1
            return _judge0_success(expected_values[idx])

        with patch("app.grader.Grader._submit_case", mock_submit_fn), patch(
            "app.grader.Grader._poll_result", mock_poll_fn
        ):
            resp = _submit(client, mode="submit")

        assert resp.status_code == 200
        data = resp.json()
        assert data["outcome"] == "passed"
        assert data["passedCount"] == 4
        assert data["totalCount"] == 4
        for r in data["results"]:
            if r["kind"] == "hidden":
                assert "args" not in r or r.get("args") is None
                assert "expected" not in r or r.get("expected") is None


class TestIncorrectCode:
    def test_wrong_answer(self, client: TestClient) -> None:
        mock_submit = AsyncMock(return_value="token-1")
        mock_poll = AsyncMock(return_value=_judge0_success(6))

        with patch("app.grader.Grader._submit_case", mock_submit), patch(
            "app.grader.Grader._poll_result", mock_poll
        ):
            resp = _submit(client, code="def raise_to_power(b, e):\n    return b * e\n")

        assert resp.status_code == 200
        data = resp.json()
        assert data["outcome"] == "wrong_answer"
        assert data["passedCount"] == 0
        assert data["results"][0]["actual"] == 6


class TestSyntaxError:
    def test_syntax_error(self, client: TestClient) -> None:
        mock_submit = AsyncMock(return_value="token-1")
        mock_poll = AsyncMock(return_value=_judge0_syntax_error())

        with patch("app.grader.Grader._submit_case", mock_submit), patch(
            "app.grader.Grader._poll_result", mock_poll
        ):
            resp = _submit(client, code="def raise_to_power(b, e)\n    return b ** e\n")

        assert resp.status_code == 200
        data = resp.json()
        assert data["outcome"] == "syntax_error"


class TestRuntimeError:
    def test_runtime_error(self, client: TestClient) -> None:
        mock_submit = AsyncMock(return_value="token-1")
        mock_poll = AsyncMock(return_value=_judge0_runtime_error())

        with patch("app.grader.Grader._submit_case", mock_submit), patch(
            "app.grader.Grader._poll_result", mock_poll
        ):
            resp = _submit(client, code="def raise_to_power(b, e):\n    return 1/0\n")

        assert resp.status_code == 200
        data = resp.json()
        assert data["outcome"] == "runtime_error"


class TestTimeLimit:
    def test_time_limit(self, client: TestClient) -> None:
        mock_submit = AsyncMock(return_value="token-1")
        mock_poll = AsyncMock(return_value=_judge0_time_limit())

        with patch("app.grader.Grader._submit_case", mock_submit), patch(
            "app.grader.Grader._poll_result", mock_poll
        ):
            resp = _submit(
                client,
                code="def raise_to_power(b, e):\n    while True: pass\n",
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data["outcome"] == "time_limit"


class TestForgedVerdict:
    def test_forged_pass_in_stdout(self, client: TestClient) -> None:
        """Printing a forged pass marker must not produce a pass."""
        forged_output = {
            "status": {"id": 3, "description": "Accepted"},
            "stdout": 'PASS\n{"ok": true, "value": 999}\n',
            "stderr": None,
            "compile_output": None,
            "time": "0.01",
        }
        mock_submit = AsyncMock(return_value="token-1")
        mock_poll = AsyncMock(return_value=forged_output)

        with patch("app.grader.Grader._submit_case", mock_submit), patch(
            "app.grader.Grader._poll_result", mock_poll
        ):
            resp = _submit(client)

        data = resp.json()
        assert data["outcome"] == "wrong_answer"


class TestBoolVsInt:
    def test_true_does_not_match_1(self, client: TestClient) -> None:
        """Strict type check: True must not match integer 1."""
        mock_submit = AsyncMock(return_value="token-1")
        mock_poll = AsyncMock(return_value=_judge0_success(True))

        with patch("app.grader.Grader._submit_case", mock_submit), patch(
            "app.grader.Grader._poll_result", mock_poll
        ):
            resp = _submit(client)

        data = resp.json()
        assert data["outcome"] == "wrong_answer"


class TestMalformedOutput:
    def test_no_json(self, client: TestClient) -> None:
        bad_output = {
            "status": {"id": 3, "description": "Accepted"},
            "stdout": "not json at all\n",
            "stderr": None,
            "compile_output": None,
            "time": "0.01",
        }
        mock_submit = AsyncMock(return_value="token-1")
        mock_poll = AsyncMock(return_value=bad_output)

        with patch("app.grader.Grader._submit_case", mock_submit), patch(
            "app.grader.Grader._poll_result", mock_poll
        ):
            resp = _submit(client)

        data = resp.json()
        assert data["outcome"] == "invalid_output"

    def test_oversized_output(self, client: TestClient) -> None:
        big_output = {
            "status": {"id": 3, "description": "Accepted"},
            "stdout": "x" * 9000 + "\n",
            "stderr": None,
            "compile_output": None,
            "time": "0.01",
        }
        mock_submit = AsyncMock(return_value="token-1")
        mock_poll = AsyncMock(return_value=big_output)

        with patch("app.grader.Grader._submit_case", mock_submit), patch(
            "app.grader.Grader._poll_result", mock_poll
        ):
            resp = _submit(client)

        data = resp.json()
        assert data["outcome"] == "invalid_output"


class TestEmptyCode:
    def test_empty_code_rejected(self, client: TestClient) -> None:
        resp = _submit(client, code="   ")
        assert resp.status_code == 422
        data = resp.json()
        assert data["error"]["code"] == "INVALID_CODE"


class TestUnknownExercise:
    def test_unknown_exercise_id(self, client: TestClient) -> None:
        resp = _submit(client, exercise_id="nonexistent-exercise")
        assert resp.status_code == 404
        data = resp.json()
        assert data["error"]["code"] == "EXERCISE_NOT_FOUND"


class TestStaleRevision:
    def test_stale_revision(self, client: TestClient) -> None:
        resp = _submit(client, revision="old-revision")
        assert resp.status_code == 409
        data = resp.json()
        assert data["error"]["code"] == "STALE_EXERCISE"


class TestUpstreamError:
    def test_judge0_unavailable(self, client: TestClient) -> None:
        from app.grader import Grader

        mock_submit = AsyncMock(side_effect=Grader.Unavailable("Judge0 unreachable"))

        with patch("app.grader.Grader._submit_case", mock_submit):
            resp = _submit(client)

        assert resp.status_code == 503
        data = resp.json()
        assert data["error"]["code"] == "GRADER_UNAVAILABLE"
        assert data["error"]["retryable"] is True

    def test_judge0_timeout(self, client: TestClient) -> None:
        from app.grader import Grader

        mock_submit = AsyncMock(return_value="token-1")
        mock_poll = AsyncMock(side_effect=Grader.Timeout("deadline exceeded"))

        with patch("app.grader.Grader._submit_case", mock_submit), patch(
            "app.grader.Grader._poll_result", mock_poll
        ):
            resp = _submit(client)

        assert resp.status_code == 504
        data = resp.json()
        assert data["error"]["code"] == "GRADER_TIMEOUT"
        assert data["error"]["retryable"] is True

    def test_judge0_busy(self, client: TestClient) -> None:
        from app.grader import Grader

        mock_submit = AsyncMock(side_effect=Grader.Busy("queue full"))

        with patch("app.grader.Grader._submit_case", mock_submit):
            resp = _submit(client)

        assert resp.status_code == 429
        data = resp.json()
        assert data["error"]["code"] == "BUSY"
        assert data["error"]["retryable"] is True


class TestHiddenDataNeverExposed:
    def test_visible_vs_hidden_results(self, client: TestClient) -> None:
        """In submit mode, hidden case results must not contain args/expected/actual."""
        call_idx = {"n": 0}
        expected_values = [8, 1, 0, -8]

        async def mock_submit_fn(self, source):
            idx = call_idx["n"]
            call_idx["n"] += 1
            return f"token-{idx + 1}"

        async def mock_poll_fn(self, token, deadline):
            idx = int(token.split("-")[1]) - 1
            return _judge0_success(expected_values[idx])

        with patch("app.grader.Grader._submit_case", mock_submit_fn), patch(
            "app.grader.Grader._poll_result", mock_poll_fn
        ):
            resp = _submit(client, mode="submit")

        data = resp.json()
        for r in data["results"]:
            if r["kind"] == "hidden":
                assert set(r.keys()) <= {"kind", "index", "passed"}


class TestErrorShape:
    def test_error_has_request_id(self, client: TestClient) -> None:
        resp = _submit(client, exercise_id="nonexistent")
        data = resp.json()
        assert "requestId" in data
        assert "error" in data
        assert "code" in data["error"]
        assert "message" in data["error"]
        assert "retryable" in data["error"]


# ---------------------------------------------------------------------------
# T3: verify_exercise tests (test-me feature)
# ---------------------------------------------------------------------------


class TestVerifyExercise:
    """Tests for Grader.verify_exercise — reference and wrong-solution checks."""

    @pytest.fixture()
    def grader(self) -> "Grader":
        from app.grader import Grader
        return Grader()

    def test_valid_exercise(self, grader: "Grader") -> None:
        """Reference passes all, wrong fails at least one → valid=True."""
        from app.grader import VerificationCase

        cases = [
            VerificationCase(args=[2, 3], expected=8),
            VerificationCase(args=[5, 0], expected=1),
            VerificationCase(args=[0, 4], expected=0),
        ]

        call_idx = {"n": 0}

        # Reference: raise_to_power returns correct values
        # Wrong: base * exponent returns wrong values for most cases
        ref_values = [8, 1, 0]
        wrong_values = [6, 0, 0]  # 2*3=6, 5*0=0, 0*4=0

        async def mock_submit(self, source):
            idx = call_idx["n"]
            call_idx["n"] += 1
            return f"token-{idx}"

        async def mock_poll(self, token, deadline):
            idx = int(token.split("-")[1])
            # First 3 calls are reference, next 3 are wrong
            if idx < 3:
                return _judge0_success(ref_values[idx])
            else:
                return _judge0_success(wrong_values[idx - 3])

        import asyncio
        with patch("app.grader.Grader._submit_case", mock_submit), \
             patch("app.grader.Grader._poll_result", mock_poll):
            result = asyncio.run(
                grader.verify_exercise(
                    function_name="raise_to_power",
                    reference_solution="def raise_to_power(b, e):\n    return b ** e\n",
                    known_wrong_solution="def raise_to_power(b, e):\n    return b * e\n",
                    test_cases=cases,
                )
            )

        assert result.valid is True
        assert result.reference_passed is True
        assert result.reference_passed_count == 3
        assert result.reference_total_count == 3
        assert result.wrong_failed is True
        assert result.wrong_failed_count >= 1

    def test_reference_fails(self, grader: "Grader") -> None:
        """Reference fails a case → valid=False."""
        from app.grader import VerificationCase

        cases = [
            VerificationCase(args=[2, 3], expected=8),
            VerificationCase(args=[5, 0], expected=1),
        ]

        call_idx = {"n": 0}

        async def mock_submit(self, source):
            idx = call_idx["n"]
            call_idx["n"] += 1
            return f"token-{idx}"

        async def mock_poll(self, token, deadline):
            idx = int(token.split("-")[1])
            if idx < 2:
                # Reference: first case correct, second wrong
                return _judge0_success(8 if idx == 0 else 999)
            else:
                # Wrong solution
                return _judge0_success(6 if idx == 2 else 0)

        import asyncio
        with patch("app.grader.Grader._submit_case", mock_submit), \
             patch("app.grader.Grader._poll_result", mock_poll):
            result = asyncio.run(
                grader.verify_exercise(
                    function_name="raise_to_power",
                    reference_solution="def raise_to_power(b, e):\n    return 999\n",
                    known_wrong_solution="def raise_to_power(b, e):\n    return b * e\n",
                    test_cases=cases,
                )
            )

        assert result.valid is False
        assert result.reference_passed is False
        assert result.reference_passed_count < 2

    def test_wrong_passes_all(self, grader: "Grader") -> None:
        """Wrong solution passes all cases → valid=False (needs at least one failure)."""
        from app.grader import VerificationCase

        cases = [
            VerificationCase(args=[2, 3], expected=8),
        ]

        call_idx = {"n": 0}

        async def mock_submit(self, source):
            idx = call_idx["n"]
            call_idx["n"] += 1
            return f"token-{idx}"

        async def mock_poll(self, token, deadline):
            # Both reference and wrong return correct answer
            return _judge0_success(8)

        import asyncio
        with patch("app.grader.Grader._submit_case", mock_submit), \
             patch("app.grader.Grader._poll_result", mock_poll):
            result = asyncio.run(
                grader.verify_exercise(
                    function_name="raise_to_power",
                    reference_solution="def raise_to_power(b, e):\n    return b ** e\n",
                    known_wrong_solution="def raise_to_power(b, e):\n    return b ** e\n",
                    test_cases=cases,
                )
            )

        assert result.valid is False
        assert result.reference_passed is True
        assert result.wrong_failed is False
        assert result.wrong_failed_count == 0

    def test_reference_runtime_error(self, grader: "Grader") -> None:
        """Reference hits a runtime error → valid=False."""
        from app.grader import VerificationCase

        cases = [VerificationCase(args=[2, 3], expected=8)]
        call_idx = {"n": 0}

        async def mock_submit(self, source):
            idx = call_idx["n"]
            call_idx["n"] += 1
            return f"token-{idx}"

        async def mock_poll(self, token, deadline):
            idx = int(token.split("-")[1])
            if idx == 0:
                return _judge0_runtime_error()
            return _judge0_success(6)

        import asyncio
        with patch("app.grader.Grader._submit_case", mock_submit), \
             patch("app.grader.Grader._poll_result", mock_poll):
            result = asyncio.run(
                grader.verify_exercise(
                    function_name="raise_to_power",
                    reference_solution="def raise_to_power(b, e):\n    return 1/0\n",
                    known_wrong_solution="def raise_to_power(b, e):\n    return b * e\n",
                    test_cases=cases,
                )
            )

        assert result.valid is False
        assert result.reference_passed is False

    def test_judge0_unavailable_propagates(self, grader: "Grader") -> None:
        """Judge0 unavailable during verification raises Grader.Unavailable."""
        from app.grader import Grader, VerificationCase

        cases = [VerificationCase(args=[2, 3], expected=8)]

        async def mock_submit(self, source):
            raise Grader.Unavailable("Judge0 unreachable")

        import asyncio
        with patch("app.grader.Grader._submit_case", mock_submit):
            with pytest.raises(Grader.Unavailable):
                asyncio.run(
                    grader.verify_exercise(
                        function_name="f",
                        reference_solution="def f(a, b): return a ** b",
                        known_wrong_solution="def f(a, b): return a * b",
                        test_cases=cases,
                    )
                )
