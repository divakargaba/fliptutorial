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


# ---------------------------------------------------------------------------
# T4: POST /v1/test-me endpoint tests
# ---------------------------------------------------------------------------


@pytest.fixture()
def testme_client(approved_dir: Path) -> TestClient:
    """Test client with BREAKPOINT_TESTME enabled."""
    with patch("app.catalog.APPROVED_DIR", approved_dir), \
         patch.dict("os.environ", {"BREAKPOINT_TESTME": "1"}):
        # Force re-evaluation of the module-level flag
        import app.main as main_mod
        original = main_mod.TESTME_ENABLED
        main_mod.TESTME_ENABLED = True
        try:
            with TestClient(main_mod.app) as c:
                yield c
        finally:
            main_mod.TESTME_ENABLED = original


class TestTestMeDisabled:
    def test_testme_off_by_default(self, client: TestClient) -> None:
        """When BREAKPOINT_TESTME is not set, endpoint returns 404."""
        resp = client.post("/v1/test-me", json={"videoId": "rfscVS0vtbw", "timestampS": 500})
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "NOT_FOUND"


class TestTestMeValidation:
    def test_invalid_video_id(self, testme_client: TestClient) -> None:
        resp = testme_client.post("/v1/test-me", json={"videoId": "bad!id", "timestampS": 500})
        assert resp.status_code == 422
        assert resp.json()["error"]["code"] == "INVALID_VIDEO_ID"

    def test_negative_timestamp(self, testme_client: TestClient) -> None:
        resp = testme_client.post("/v1/test-me", json={"videoId": "rfscVS0vtbw", "timestampS": -1})
        assert resp.status_code == 422


class TestTestMeTranscriptErrors:
    def test_no_captions(self, testme_client: TestClient) -> None:
        from app.transcripts import TranscriptError
        with patch("app.main.fetcher") as mock_fetcher:
            mock_fetcher.get = AsyncMock(
                side_effect=TranscriptError("NO_CAPTIONS", "no English captions")
            )
            resp = testme_client.post(
                "/v1/test-me", json={"videoId": "rfscVS0vtbw", "timestampS": 500}
            )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "NO_CAPTIONS"
        assert resp.json()["error"]["retryable"] is False

    def test_too_early(self, testme_client: TestClient) -> None:
        from app.transcripts import TranscriptError
        with patch("app.main.fetcher") as mock_fetcher:
            mock_fetcher.get = AsyncMock(
                side_effect=TranscriptError("TOO_EARLY", "needs at least 180 s")
            )
            resp = testme_client.post(
                "/v1/test-me", json={"videoId": "rfscVS0vtbw", "timestampS": 60}
            )
        assert resp.status_code == 422
        assert resp.json()["error"]["code"] == "TOO_EARLY"

    def test_captions_unavailable(self, testme_client: TestClient) -> None:
        from app.transcripts import TranscriptError
        with patch("app.main.fetcher") as mock_fetcher:
            mock_fetcher.get = AsyncMock(
                side_effect=TranscriptError("CAPTIONS_UNAVAILABLE", "YouTube unreachable", True)
            )
            resp = testme_client.post(
                "/v1/test-me", json={"videoId": "rfscVS0vtbw", "timestampS": 500}
            )
        assert resp.status_code == 503
        assert resp.json()["error"]["code"] == "GENERATOR_UNAVAILABLE"
        assert resp.json()["error"]["retryable"] is True


class TestTestMeGeneratorMissing:
    def test_testme_module_not_available(self, testme_client: TestClient) -> None:
        """When testme.py is not yet pushed, endpoint returns 503."""
        from app.transcripts import Transcript, Cue
        mock_transcript = Transcript(
            video_id="rfscVS0vtbw", kind="asr", language="en", title="Test",
            cues=tuple(
                Cue(f"c{i:08d}", float(i), float(i + 1), f"word {i}")
                for i in range(0, 300)
            ),
        )
        with patch("app.main.fetcher") as mock_fetcher, \
             patch("app.main.clip") as mock_clip:
            mock_fetcher.get = AsyncMock(return_value=mock_transcript)
            from app.transcripts import Clip
            mock_clip.return_value = Clip(
                video_id="rfscVS0vtbw", kind="asr", title="Test",
                timestamp_s=500.0, start_s=0.0,
                cues=mock_transcript.cues,
            )
            # Ensure the testme import fails
            with patch.dict("sys.modules", {"app.testme": None}):
                resp = testme_client.post(
                    "/v1/test-me", json={"videoId": "rfscVS0vtbw", "timestampS": 500}
                )
        assert resp.status_code == 503
        assert resp.json()["error"]["code"] == "GENERATOR_UNAVAILABLE"


class TestSetExpired:
    def test_submission_against_expired_set(self, testme_client: TestClient) -> None:
        """Submitting code against an expired generated set returns SET_EXPIRED."""
        import time
        import app.main as main_mod
        from app.catalog import ApprovedExercise, Example, HiddenTest

        exercise = ApprovedExercise(
            id="tm-test-exercise",
            title="Test",
            statement="Test statement",
            language="python",
            functionName="test_fn",
            starterCode="def test_fn(x):\n    pass\n",
            examples=[Example(args=[1], expected=1)],
            hiddenTests=[HiddenTest(args=[2], expected=2)],
            referenceSolution="def test_fn(x):\n    return x\n",
            knownWrongSolution="def test_fn(x):\n    return 0\n",
        )
        # Store with an already-expired timestamp
        main_mod._set_cache["tm-expired-set"] = (time.monotonic() - 1, exercise)

        resp = testme_client.post("/v1/submissions", json={
            "exerciseId": "tm-test-exercise",
            "revision": "tm-expired-set",
            "mode": "run",
            "code": "def test_fn(x):\n    return x\n",
        })
        assert resp.status_code == 410
        assert resp.json()["error"]["code"] == "SET_EXPIRED"

    def test_submission_against_valid_set(self, testme_client: TestClient) -> None:
        """Submitting code against a valid generated set grades through Judge0."""
        import time
        import app.main as main_mod
        from app.catalog import ApprovedExercise, Example, HiddenTest

        exercise = ApprovedExercise(
            id="tm-test-exercise",
            title="Test",
            statement="Test statement",
            language="python",
            functionName="test_fn",
            starterCode="def test_fn(x):\n    pass\n",
            examples=[Example(args=[1], expected=1)],
            hiddenTests=[HiddenTest(args=[2], expected=2)],
            referenceSolution="def test_fn(x):\n    return x\n",
            knownWrongSolution="def test_fn(x):\n    return 0\n",
        )
        # Store with a future expiry
        main_mod._set_cache["tm-valid-set"] = (time.monotonic() + 3600, exercise)

        mock_submit = AsyncMock(return_value="token-1")
        mock_poll = AsyncMock(return_value=_judge0_success(1))

        with patch("app.grader.Grader._submit_case", mock_submit), \
             patch("app.grader.Grader._poll_result", mock_poll):
            resp = testme_client.post("/v1/submissions", json={
                "exerciseId": "tm-test-exercise",
                "revision": "tm-valid-set",
                "mode": "run",
                "code": "def test_fn(x):\n    return x\n",
            })

        assert resp.status_code == 200
        data = resp.json()
        assert data["outcome"] == "passed"
        assert data["passedCount"] == 1
