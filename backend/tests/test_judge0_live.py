"""Live Judge0 smoke test. Skipped unless JUDGE0_BASE_URL is set.

Runs a real correct, syntax-error, and infinite-loop sample against
the configured Judge0 host. Confirms the Python 3 language ID.
"""

from __future__ import annotations

import json
import os
import time

import pytest

JUDGE0_BASE_URL = os.environ.get("JUDGE0_BASE_URL")

pytestmark = pytest.mark.skipif(
    not JUDGE0_BASE_URL,
    reason="JUDGE0_BASE_URL not set; skipping live Judge0 tests",
)


@pytest.fixture()
def judge0():
    import httpx

    base = JUDGE0_BASE_URL
    token = os.environ.get("JUDGE0_AUTH_TOKEN", "")
    header = os.environ.get("JUDGE0_AUTH_HEADER", "X-Auth-Token")
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if token:
        headers[header] = token
    return base, headers


def _submit_and_wait(judge0, source: str, lang_id: int = 71, timeout: float = 15.0) -> dict:
    import httpx

    base, headers = judge0
    with httpx.Client(timeout=15.0) as client:
        resp = client.post(
            f"{base}/submissions?base64_encoded=false&wait=false",
            json={
                "source_code": source,
                "language_id": lang_id,
                "cpu_time_limit": 2.0,
                "wall_time_limit": 4.0,
            },
            headers=headers,
        )
        assert resp.status_code in (200, 201), f"submit failed: {resp.status_code} {resp.text}"
        token = resp.json()["token"]

        deadline = time.time() + timeout
        while time.time() < deadline:
            r = client.get(
                f"{base}/submissions/{token}?base64_encoded=false&fields=status,stdout,stderr,compile_output",
                headers=headers,
            )
            data = r.json()
            sid = data.get("status", {}).get("id", 0)
            if sid not in (1, 2):
                return data
            time.sleep(0.5)

        pytest.fail("Judge0 polling timed out")


def test_correct_code(judge0) -> None:
    source = 'print(2 ** 10)'
    data = _submit_and_wait(judge0, source)
    assert data["status"]["id"] == 3, f"expected Accepted, got {data['status']}"
    assert data["stdout"].strip() == "1024"


def test_syntax_error(judge0) -> None:
    source = 'def foo(\n'
    data = _submit_and_wait(judge0, source)
    assert data["status"]["id"] == 6, f"expected Compilation Error, got {data['status']}"


def test_infinite_loop(judge0) -> None:
    source = 'while True: pass'
    data = _submit_and_wait(judge0, source)
    assert data["status"]["id"] == 5, f"expected TLE, got {data['status']}"


def test_python_language_id(judge0) -> None:
    """Confirm the configured Python 3 language ID works."""
    import httpx

    base, headers = judge0
    lang_id = int(os.environ.get("JUDGE0_PYTHON_LANGUAGE_ID", "71"))
    with httpx.Client(timeout=10.0) as client:
        resp = client.get(f"{base}/languages", headers=headers)
        assert resp.status_code == 200
        langs = resp.json()
        ids = [l["id"] for l in langs]
        assert lang_id in ids, f"language id {lang_id} not found in {ids}"
