"""Generic stdin/stdout runner for every Judge0 language without a function-style wrapper.

A stdio exercise is a whole program: each case feeds ``args[0]`` (one string) to the program's
standard input and compares what it prints with ``expected`` (one string). Both sides are
normalised the same way: line endings unified, trailing spaces on each line and trailing blank
lines dropped. Expected values never enter the sandbox; comparison happens server-side, as in
the function-style runners. ``function_name`` is ignored (the program is run as-is).

Languages and Judge0 CE ids (each overridable with ``JUDGE0_<LANG>_LANGUAGE_ID``):
typescript 101 (TS 5.6), c 103 (GCC 14), csharp 51 (Mono 6.6), go 107 (Go 1.23), rust 108 (Rust 1.85).
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Literal

from .base import (
    MAX_CONCURRENT_CASES, MAX_OUTPUT_BYTES, CPU_TIME_LIMIT, GRADE_DEADLINE, WALL_TIME_LIMIT,
    CaseOutcome, CaseResult, Runner, RunnerBusy, RunnerResult, RunnerTimeout, RunnerUnavailable, register,
)

logger = logging.getLogger("breakpoint.runners")

STDIO_LANGUAGE_IDS: dict[str, int] = {
    "typescript": 101,
    "c": 103,
    "csharp": 51,
    "go": 107,
    "rust": 108,
}
STDIO_LANGUAGES = tuple(STDIO_LANGUAGE_IDS)
MAX_STDIN_BYTES = 8 * 1024
# Compiled languages (Rust, C#) need longer than the function-style defaults to build.
STDIO_CPU_TIME_LIMIT = max(CPU_TIME_LIMIT, 5.0)
STDIO_WALL_TIME_LIMIT = max(WALL_TIME_LIMIT, 10.0)
STDIO_GRADE_DEADLINE = max(GRADE_DEADLINE, 30.0)


def normalize_output(text: Any) -> str:
    """Same rule for program output and expected text: unify newlines, drop trailing spaces and blank tail lines."""
    s = str(text).replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.rstrip() for line in s.split("\n")).rstrip("\n")


class StdioRunner(Runner):
    """Runs a complete program per case with the case's stdin; compares normalised stdout."""

    language: str = ""

    @property
    def language_id(self) -> int:
        env = f"JUDGE0_{self.language.upper()}_LANGUAGE_ID"
        return int(os.environ.get(env, str(STDIO_LANGUAGE_IDS[self.language])))

    def build_wrapper(self, code: str, function_name: str, args: list[Any]) -> str:
        return code  # the learner writes the whole program

    async def _submit_stdin(self, source: str, stdin: str) -> str:
        client = self._get_client()
        payload = {
            "source_code": source,
            "language_id": self.language_id,
            "stdin": stdin,
            "cpu_time_limit": STDIO_CPU_TIME_LIMIT,
            "wall_time_limit": STDIO_WALL_TIME_LIMIT,
            "enable_network": False,
        }
        try:
            resp = await client.post(f"{self._base_url}/submissions?base64_encoded=false&wait=false",
                                     json=payload, headers=self._headers())
        except Exception as exc:  # httpx errors
            raise RunnerUnavailable(f"Judge0 unreachable: {exc}") from exc
        if resp.status_code == 429:
            raise RunnerBusy("Judge0 queue full")
        if resp.status_code >= 400:
            raise RunnerUnavailable(f"Judge0 submission error: {resp.status_code}")
        token = resp.json().get("token")
        if not token:
            raise RunnerUnavailable("Judge0 returned no token")
        return token

    @staticmethod
    def _stdin_of(args: Any) -> str | None:
        if isinstance(args, list) and len(args) == 1 and isinstance(args[0], str):
            return args[0]
        return None

    def _outcome(self, data: dict, visible: bool) -> tuple[str, str | None, str | None]:
        status_id = data.get("status", {}).get("id", 0)
        if status_id == 6:
            return "syntax_error", None, (data.get("compile_output") or "")[:1024] if visible else None
        if status_id == 5:
            return "time_limit", None, "time limit exceeded" if visible else None
        if status_id in (7, 8, 9, 10, 11, 12):
            return "runtime_error", None, (data.get("stderr") or "")[:1024] if visible else None
        stdout = data.get("stdout") or ""
        if len(stdout) > MAX_OUTPUT_BYTES:
            return "invalid_output", None, "output too large" if visible else None
        return "check", normalize_output(stdout), None

    async def _grade_inner(
        self,
        code: str,
        function_name: str,
        examples: list[dict[str, Any]],
        hidden_tests: list[dict[str, Any]] | None,
        mode: Literal["run", "submit"],
    ) -> RunnerResult:
        cases: list[tuple[list, Any, bool]] = [(ex["args"], ex["expected"], True) for ex in examples]
        if mode == "submit" and hidden_tests:
            cases += [(ht["args"], ht["expected"], False) for ht in hidden_tests]

        deadline = asyncio.get_event_loop().time() + STDIO_GRADE_DEADLINE
        sem = asyncio.Semaphore(MAX_CONCURRENT_CASES)
        results: list[CaseResult | None] = [None] * len(cases)

        async def run_case(idx: int, args: list, expected: Any, visible: bool) -> None:
            stdin = self._stdin_of(args)
            if stdin is None or len(stdin.encode()) > MAX_STDIN_BYTES or not isinstance(expected, str):
                results[idx] = CaseResult(idx, False, visible, "invalid_output", args if visible else None,
                                          expected if visible else None, None,
                                          "case must be one stdin string and one expected string" if visible else None)
                return
            async with sem:
                token = await self._submit_stdin(code, stdin)
                data = await self._poll_result(token, deadline)
            outcome, actual, diag = self._outcome(data, visible)
            passed = outcome == "check" and actual == normalize_output(expected)
            if outcome == "check":
                outcome = "passed" if passed else "wrong_answer"
            results[idx] = CaseResult(
                index=idx, passed=passed, visible=visible, outcome=outcome,
                args=args if visible else None,
                expected=expected if visible else None,
                actual=actual if visible and outcome in ("passed", "wrong_answer") else None,
                diagnostic=diag,
            )

        tasks = [asyncio.create_task(run_case(i, a, e, v)) for i, (a, e, v) in enumerate(cases)]
        try:
            await asyncio.gather(*tasks)
        except (RunnerUnavailable, RunnerTimeout, RunnerBusy):
            for t in tasks:
                t.cancel()
            raise

        done = [r for r in results if r is not None]
        passed_count = sum(r.passed for r in done)
        failures = [r.outcome for r in done if not r.passed]
        final: CaseOutcome = "passed" if not failures else failures[0]  # type: ignore[assignment]
        logger.info("grade lang=%s (stdio) mode=%s passed=%d/%d", self.language, mode, passed_count, len(cases))
        return RunnerResult(outcome=final, passedCount=passed_count, totalCount=len(cases), results=done)


def _make(language: str) -> type[StdioRunner]:
    cls = type(f"{language.title()}StdioRunner", (StdioRunner,), {"language": language})
    return register(language)(cls)


for _lang in STDIO_LANGUAGES:
    _make(_lang)
