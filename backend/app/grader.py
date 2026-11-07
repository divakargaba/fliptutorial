"""Judge0 adapter for grading Python submissions.

Sends one isolated Judge0 run per test case with a fixed wrapper that calls
the exercise function and emits a JSON result. Expected results and pass flags
never enter the sandbox. Comparison happens server-side.

Limits per PRD §4:
  - 16 KiB code, 8 KiB parsed output
  - 3 concurrent cases per request
  - 2 s CPU / 4 s wall per case
  - 12 s grading deadline (including queue time)
  - 2 active grades per backend
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import textwrap
from typing import Literal

import httpx

from .catalog import ApprovedExercise, SubmissionResponse, VisibleResult, HiddenResult

logger = logging.getLogger("breakpoint.grader")

MAX_CODE_BYTES = 16 * 1024
MAX_OUTPUT_BYTES = 8 * 1024
CPU_TIME_LIMIT = 2.0
WALL_TIME_LIMIT = 4.0
GRADE_DEADLINE = 12.0
MAX_CONCURRENT_CASES = 3
MAX_ACTIVE_GRADES = 2
POLL_INTERVAL = 0.5


def _build_wrapper(user_code: str, function_name: str, args: list) -> str:
    """Build the sandbox source: user code + a fixed JSON-emitting wrapper."""
    args_repr = json.dumps(args)
    return textwrap.dedent(f"""\
{user_code}

import json as __json
try:
    __result = {function_name}(*{args_repr})
    print(__json.dumps({{"ok": True, "value": __result}}))
except Exception as __e:
    print(__json.dumps({{"ok": False, "error": type(__e).__name__ + ": " + str(__e)}}))
""")


class Grader:
    """Grades code against an exercise's test cases using Judge0 CE."""

    class Unavailable(Exception):
        pass

    class Timeout(Exception):
        pass

    class Busy(Exception):
        pass

    def __init__(self) -> None:
        self._base_url = os.environ.get("JUDGE0_BASE_URL", "https://ce.judge0.com")
        self._language_id = int(os.environ.get("JUDGE0_PYTHON_LANGUAGE_ID", "71"))
        self._auth_token = os.environ.get("JUDGE0_AUTH_TOKEN", "")
        self._auth_header = os.environ.get("JUDGE0_AUTH_HEADER", "X-Auth-Token")
        self._active = asyncio.Semaphore(MAX_ACTIVE_GRADES)
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(15.0))

    async def close(self) -> None:
        await self._client.aclose()

    def _headers(self) -> dict[str, str]:
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self._auth_token:
            headers[self._auth_header] = self._auth_token
        return headers

    async def _submit_case(
        self, source: str
    ) -> str:
        """Submit source to Judge0 and return the submission token."""
        payload = {
            "source_code": source,
            "language_id": self._language_id,
            "cpu_time_limit": CPU_TIME_LIMIT,
            "wall_time_limit": WALL_TIME_LIMIT,
            "enable_network": False,
        }
        try:
            resp = await self._client.post(
                f"{self._base_url}/submissions?base64_encoded=false&wait=false",
                json=payload,
                headers=self._headers(),
            )
        except httpx.HTTPError as exc:
            raise self.Unavailable(f"Judge0 unreachable: {exc}") from exc

        if resp.status_code == 429:
            raise self.Busy("Judge0 queue full")
        if resp.status_code >= 400:
            raise self.Unavailable(f"Judge0 submission error: {resp.status_code}")

        data = resp.json()
        token = data.get("token")
        if not token:
            raise self.Unavailable("Judge0 returned no token")
        return token

    async def _poll_result(self, token: str, deadline: float) -> dict:
        """Poll Judge0 until the submission finishes or the deadline passes."""
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                raise self.Timeout("grading deadline exceeded")

            try:
                resp = await self._client.get(
                    f"{self._base_url}/submissions/{token}?base64_encoded=false&fields=status,stdout,stderr,compile_output,time",
                    headers=self._headers(),
                )
            except httpx.HTTPError as exc:
                raise self.Unavailable(f"Judge0 poll error: {exc}") from exc

            if resp.status_code >= 400:
                raise self.Unavailable(f"Judge0 poll status: {resp.status_code}")

            data = resp.json()
            status_id = data.get("status", {}).get("id", 0)

            # 1=In Queue, 2=Processing
            if status_id in (1, 2):
                await asyncio.sleep(min(POLL_INTERVAL, max(0, remaining)))
                continue

            return data

    def _parse_sandbox_output(
        self, data: dict, is_visible: bool
    ) -> tuple[str, object | None, str | None]:
        """Parse a Judge0 result into (outcome, actual_value, diagnostic).

        Returns one of: passed placeholder, wrong_answer, syntax_error,
        runtime_error, time_limit, invalid_output.
        """
        status_id = data.get("status", {}).get("id", 0)

        # Compilation error
        if status_id == 6:
            diag = ((data.get("compile_output") or "")[:1024] if is_visible else None)
            return "syntax_error", None, diag

        # Time limit
        if status_id == 5:
            return "time_limit", None, ("time limit exceeded" if is_visible else None)

        # Runtime error (NZEC, etc.)
        if status_id in (7, 8, 9, 10, 11, 12):
            diag = ((data.get("stderr") or "")[:1024] if is_visible else None)
            return "runtime_error", None, diag

        # Accepted (status 3) — parse stdout
        stdout = data.get("stdout") or ""
        if len(stdout) > MAX_OUTPUT_BYTES:
            return "invalid_output", None, ("output too large" if is_visible else None)

        # Take only the last non-empty line (ignore stray prints)
        lines = [l for l in stdout.strip().splitlines() if l.strip()]
        if not lines:
            return "invalid_output", None, ("no output" if is_visible else None)

        try:
            parsed = json.loads(lines[-1])
        except json.JSONDecodeError:
            return "invalid_output", None, ("malformed output" if is_visible else None)

        if not isinstance(parsed, dict) or "ok" not in parsed:
            return "invalid_output", None, ("unexpected output format" if is_visible else None)

        if not parsed["ok"]:
            diag = parsed.get("error", "")[:512] if is_visible else None
            return "runtime_error", None, diag

        return "check", parsed.get("value"), None

    async def grade(
        self,
        exercise: ApprovedExercise,
        code: str,
        mode: Literal["run", "submit"],
        request_id: str,
    ) -> SubmissionResponse:
        if not self._active._value:
            raise self.Busy("too many concurrent grades")

        async with self._active:
            return await self._grade_inner(exercise, code, mode, request_id)

    async def _grade_inner(
        self,
        exercise: ApprovedExercise,
        code: str,
        mode: Literal["run", "submit"],
        request_id: str,
    ) -> SubmissionResponse:
        # Build the test cases to run
        cases: list[tuple[list, object, bool]] = []
        for ex in exercise.examples:
            cases.append((ex.args, ex.expected, True))
        if mode == "submit":
            for ht in exercise.hiddenTests:
                cases.append((ht.args, ht.expected, False))

        deadline = asyncio.get_event_loop().time() + GRADE_DEADLINE
        sem = asyncio.Semaphore(MAX_CONCURRENT_CASES)

        results: list[VisibleResult | HiddenResult] = [None] * len(cases)  # type: ignore[list-item]
        passed_count = 0
        worst_outcome = "passed"

        async def run_case(idx: int, args: list, expected: object, visible: bool) -> None:
            nonlocal passed_count, worst_outcome

            async with sem:
                source = _build_wrapper(code, exercise.functionName, args)
                token = await self._submit_case(source)
                data = await self._poll_result(token, deadline)

            outcome, actual, diag = self._parse_sandbox_output(data, visible)

            if outcome == "check":
                # Strict type comparison: True must not match 1
                case_passed = actual == expected and type(actual) is type(expected)
                if not case_passed:
                    outcome = "wrong_answer"
                else:
                    outcome = "passed"
                    passed_count += 1
            else:
                case_passed = False

            if not case_passed and worst_outcome == "passed":
                worst_outcome = outcome

            if visible:
                results[idx] = VisibleResult(
                    index=idx,
                    passed=case_passed,
                    args=args,
                    expected=expected,
                    actual=actual if outcome in ("passed", "wrong_answer") else None,
                    diagnostic=diag,
                )
            else:
                results[idx] = HiddenResult(index=idx, passed=case_passed)

        tasks = [
            asyncio.create_task(run_case(i, args, exp, vis))
            for i, (args, exp, vis) in enumerate(cases)
        ]

        try:
            await asyncio.gather(*tasks)
        except (self.Unavailable, self.Timeout, self.Busy):
            for t in tasks:
                t.cancel()
            raise

        logger.info(
            "grade request_id=%s exercise=%s mode=%s passed=%d/%d",
            request_id,
            exercise.id,
            mode,
            passed_count,
            len(cases),
        )

        return SubmissionResponse(
            outcome=worst_outcome if passed_count == len(cases) else worst_outcome if worst_outcome != "passed" else "wrong_answer",
            passedCount=passed_count,
            totalCount=len(cases),
            results=[r for r in results if r is not None],
        )
