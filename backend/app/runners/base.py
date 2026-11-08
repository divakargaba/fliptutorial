"""Base runner: shared Judge0 submission, polling, and comparison logic.

Each language subclass provides:
- ``language_id``: Judge0 language id
- ``build_wrapper(code, function_name, args)``: sandbox source
- ``parse_value(raw)``: convert the JSON-decoded value for strict comparison

The base class owns the HTTP client, semaphores, and server-side comparison
(expected values never enter the sandbox).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

logger = logging.getLogger("breakpoint.runners")

MAX_CODE_BYTES = 16 * 1024
MAX_OUTPUT_BYTES = 8 * 1024
CPU_TIME_LIMIT = 2.0
WALL_TIME_LIMIT = 4.0
GRADE_DEADLINE = 12.0
MAX_CONCURRENT_CASES = 3
MAX_ACTIVE_GRADES = 2
POLL_INTERVAL = 0.5

# Function-style runners, then the generic stdin/stdout runner (stdio_runner.py).
SUPPORTED_LANGUAGES = ("python", "javascript", "java", "cpp", "sql", "typescript", "c", "csharp", "go", "rust")


class RunnerUnavailable(Exception):
    pass


class RunnerTimeout(Exception):
    pass


class RunnerBusy(Exception):
    pass


CaseOutcome = Literal[
    "passed", "wrong_answer", "syntax_error", "runtime_error",
    "time_limit", "invalid_output",
]


@dataclass
class CaseResult:
    index: int
    passed: bool
    visible: bool
    outcome: CaseOutcome
    args: list[Any] | None = None
    expected: Any = None
    actual: Any = None
    diagnostic: str | None = None


@dataclass
class RunnerResult:
    outcome: CaseOutcome
    passedCount: int
    totalCount: int
    results: list[CaseResult]


class Runner(ABC):
    """Abstract base for per-language Judge0 runners."""

    def __init__(self) -> None:
        self._base_url = os.environ.get("JUDGE0_BASE_URL", "https://ce.judge0.com")
        self._auth_token = os.environ.get("JUDGE0_AUTH_TOKEN", "")
        self._auth_header = os.environ.get("JUDGE0_AUTH_HEADER", "X-Auth-Token")
        self._active = asyncio.Semaphore(MAX_ACTIVE_GRADES)
        self._client: httpx.AsyncClient | None = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(15.0), trust_env=False
            )
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    @property
    @abstractmethod
    def language_id(self) -> int:
        """Judge0 language id for this language."""

    @abstractmethod
    def build_wrapper(self, code: str, function_name: str, args: list[Any]) -> str:
        """Build sandbox source: user code + JSON-emitting call wrapper."""

    def normalize_value(self, raw: Any) -> Any:
        """Post-process the JSON-decoded sandbox output for comparison.

        Default: identity. Override for language-specific quirks (e.g. Java
        returns longs where Python returns ints).
        """
        return raw

    def _headers(self) -> dict[str, str]:
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self._auth_token:
            headers[self._auth_header] = self._auth_token
        return headers

    async def _submit_case(self, source: str) -> str:
        client = self._get_client()
        payload = {
            "source_code": source,
            "language_id": self.language_id,
            "cpu_time_limit": CPU_TIME_LIMIT,
            "wall_time_limit": WALL_TIME_LIMIT,
            "enable_network": False,
        }
        try:
            resp = await client.post(
                f"{self._base_url}/submissions?base64_encoded=false&wait=false",
                json=payload,
                headers=self._headers(),
            )
        except httpx.HTTPError as exc:
            raise RunnerUnavailable(f"Judge0 unreachable: {exc}") from exc

        if resp.status_code == 429:
            raise RunnerBusy("Judge0 queue full")
        if resp.status_code >= 400:
            raise RunnerUnavailable(f"Judge0 submission error: {resp.status_code}")

        data = resp.json()
        token = data.get("token")
        if not token:
            raise RunnerUnavailable("Judge0 returned no token")
        return token

    async def _poll_result(self, token: str, deadline: float) -> dict:
        client = self._get_client()
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                raise RunnerTimeout("grading deadline exceeded")
            try:
                resp = await client.get(
                    f"{self._base_url}/submissions/{token}"
                    "?base64_encoded=false&fields=status,stdout,stderr,compile_output,time",
                    headers=self._headers(),
                )
            except httpx.HTTPError as exc:
                raise RunnerUnavailable(f"Judge0 poll error: {exc}") from exc

            if resp.status_code >= 400:
                raise RunnerUnavailable(f"Judge0 poll status: {resp.status_code}")

            data = resp.json()
            status_id = data.get("status", {}).get("id", 0)
            if status_id in (1, 2):
                await asyncio.sleep(min(POLL_INTERVAL, max(0, remaining)))
                continue
            return data

    def _parse_sandbox_output(
        self, data: dict, visible: bool,
    ) -> tuple[str, Any | None, str | None]:
        status_id = data.get("status", {}).get("id", 0)

        if status_id == 6:
            diag = (data.get("compile_output") or "")[:1024] if visible else None
            return "syntax_error", None, diag

        if status_id == 5:
            return "time_limit", None, ("time limit exceeded" if visible else None)

        if status_id in (7, 8, 9, 10, 11, 12):
            diag = (data.get("stderr") or "")[:1024] if visible else None
            return "runtime_error", None, diag

        stdout = data.get("stdout") or ""
        if len(stdout) > MAX_OUTPUT_BYTES:
            return "invalid_output", None, ("output too large" if visible else None)

        lines = [ln for ln in stdout.strip().splitlines() if ln.strip()]
        if not lines:
            return "invalid_output", None, ("no output" if visible else None)

        try:
            parsed = json.loads(lines[-1])
        except json.JSONDecodeError:
            return "invalid_output", None, ("malformed output" if visible else None)

        if not isinstance(parsed, dict) or "ok" not in parsed:
            return "invalid_output", None, ("unexpected output format" if visible else None)

        if not parsed["ok"]:
            diag = parsed.get("error", "")[:512] if visible else None
            return "runtime_error", None, diag

        return "check", self.normalize_value(parsed.get("value")), None

    async def grade(
        self,
        code: str,
        function_name: str,
        examples: list[dict[str, Any]],
        hidden_tests: list[dict[str, Any]] | None,
        mode: Literal["run", "submit"],
    ) -> RunnerResult:
        if not self._active._value:
            raise RunnerBusy("too many concurrent grades")

        async with self._active:
            return await self._grade_inner(
                code, function_name, examples, hidden_tests, mode,
            )

    async def _grade_inner(
        self,
        code: str,
        function_name: str,
        examples: list[dict[str, Any]],
        hidden_tests: list[dict[str, Any]] | None,
        mode: Literal["run", "submit"],
    ) -> RunnerResult:
        cases: list[tuple[list, Any, bool]] = []
        for ex in examples:
            cases.append((ex["args"], ex["expected"], True))
        if mode == "submit" and hidden_tests:
            for ht in hidden_tests:
                cases.append((ht["args"], ht["expected"], False))

        deadline = asyncio.get_event_loop().time() + GRADE_DEADLINE
        sem = asyncio.Semaphore(MAX_CONCURRENT_CASES)

        results: list[CaseResult | None] = [None] * len(cases)
        passed_count = 0
        worst_outcome: CaseOutcome = "passed"

        async def run_case(idx: int, args: list, expected: Any, visible: bool) -> None:
            nonlocal passed_count, worst_outcome

            async with sem:
                source = self.build_wrapper(code, function_name, args)
                token = await self._submit_case(source)
                data = await self._poll_result(token, deadline)

            outcome, actual, diag = self._parse_sandbox_output(data, visible)

            if outcome == "check":
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

            results[idx] = CaseResult(
                index=idx,
                passed=case_passed,
                visible=visible,
                outcome=outcome,
                args=args if visible else None,
                expected=expected if visible else None,
                actual=actual if visible and outcome in ("passed", "wrong_answer") else None,
                diagnostic=diag,
            )

        tasks = [
            asyncio.create_task(run_case(i, args, exp, vis))
            for i, (args, exp, vis) in enumerate(cases)
        ]

        try:
            await asyncio.gather(*tasks)
        except (RunnerUnavailable, RunnerTimeout, RunnerBusy):
            for t in tasks:
                t.cancel()
            raise

        final_outcome = worst_outcome if passed_count == len(cases) else (
            worst_outcome if worst_outcome != "passed" else "wrong_answer"
        )

        logger.info(
            "grade lang=%s fn=%s mode=%s passed=%d/%d",
            type(self).__name__, function_name, mode, passed_count, len(cases),
        )

        return RunnerResult(
            outcome=final_outcome,
            passedCount=passed_count,
            totalCount=len(cases),
            results=[r for r in results if r is not None],
        )


# ---------------------------------------------------------------------------
# Runner registry
# ---------------------------------------------------------------------------

_registry: dict[str, type[Runner]] = {}


def register(language: str):
    """Decorator: register a Runner subclass for a language name."""
    def deco(cls: type[Runner]) -> type[Runner]:
        _registry[language] = cls
        return cls
    return deco


_instances: dict[str, Runner] = {}


def get_runner(language: str) -> Runner:
    """Return a (cached) runner instance for the given language."""
    if language in _instances:
        return _instances[language]
    cls = _registry.get(language)
    if cls is None:
        raise ValueError(f"unsupported language: {language}")
    inst = cls()
    _instances[language] = inst
    return inst


async def close_all() -> None:
    for inst in _instances.values():
        await inst.close()
    _instances.clear()
