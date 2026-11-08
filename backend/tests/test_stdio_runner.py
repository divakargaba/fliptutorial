"""Tests for the generic stdin/stdout runner (TypeScript, C, C#, Go, Rust).

Offline: Judge0 is stubbed. No planner dependencies — runner-only tests.
"""

from __future__ import annotations

import asyncio

import pytest

from app.runners import SUPPORTED_LANGUAGES, get_runner
from app.runners.stdio_runner import STDIO_LANGUAGE_IDS, STDIO_LANGUAGES, StdioRunner, normalize_output


# --- registration ---------------------------------------------------------------


@pytest.mark.parametrize("lang", STDIO_LANGUAGES)
def test_registered_supported_and_get_runner(lang):
    r = get_runner(lang)
    assert isinstance(r, StdioRunner) and r.language == lang
    assert r.language_id == STDIO_LANGUAGE_IDS[lang]
    assert lang in SUPPORTED_LANGUAGES


def test_language_id_env_override(monkeypatch):
    monkeypatch.setenv("JUDGE0_GO_LANGUAGE_ID", "95")
    assert type(get_runner("go"))().language_id == 95


def test_function_style_runners_untouched():
    for lang in ("python", "javascript", "java", "cpp", "sql"):
        assert not isinstance(get_runner(lang), StdioRunner)


@pytest.mark.parametrize("raw,expected", [
    ("7\n", "7"),
    ("7", "7"),
    ("a  \r\nb \r\n\r\n", "a\nb"),
    ("  x", "  x"),
    ("", ""),
])
def test_normalize_output(raw, expected):
    assert normalize_output(raw) == expected


# --- grading with a stubbed Judge0 -----------------------------------------------


class FakeJudge:
    """Runs a tiny 'program' (a Python callable) on the submitted stdin; records payloads."""

    def __init__(self, program, status: int = 3, stderr: str = "", compile_output: str = ""):
        self.program, self.status, self.stderr, self.compile_output = program, status, stderr, compile_output
        self.payloads: list[dict] = []

    def install(self, runner: StdioRunner) -> StdioRunner:
        judge = self

        class Resp:
            def __init__(self, data, code=201):
                self._data, self.status_code = data, code

            def json(self):
                return self._data

        class Client:
            async def post(self, url, json, headers):
                judge.payloads.append(json)
                return Resp({"token": str(len(judge.payloads) - 1)})

            async def get(self, url, headers):
                p = judge.payloads[int(url.split("/submissions/")[1].split("?")[0])]
                out = judge.program(p["stdin"]) if judge.status == 3 else ""
                return Resp({"status": {"id": judge.status}, "stdout": out, "stderr": judge.stderr,
                             "compile_output": judge.compile_output}, 200)

        runner._client = Client()  # type: ignore[assignment]
        return runner


def go_runner(program, **kw) -> tuple[StdioRunner, FakeJudge]:
    judge = FakeJudge(program, **kw)
    return judge.install(type(get_runner("go"))()), judge


def add_program(stdin: str) -> str:
    a, b = map(int, stdin.split())
    return f"{a + b}\n"


EXAMPLES = [{"args": ["3 4\n"], "expected": "7"}]
HIDDEN = [{"args": ["0 0\n"], "expected": "0"}, {"args": ["-2 5\n"], "expected": "3\n"}]


def grade(runner, mode="submit", examples=EXAMPLES, hidden=HIDDEN):
    return asyncio.run(runner.grade("package main\nfunc main() {}\n", "main", examples, hidden, mode))


def test_correct_program_passes_and_sends_stdin():
    runner, judge = go_runner(add_program)
    res = grade(runner)
    assert res.outcome == "passed" and res.passedCount == res.totalCount == 3
    assert [p["stdin"] for p in judge.payloads] == ["3 4\n", "0 0\n", "-2 5\n"]
    p = judge.payloads[0]
    assert p["language_id"] == 107 and p["enable_network"] is False
    assert p["source_code"] == "package main\nfunc main() {}\n"  # run as-is, nothing injected


def test_wrong_program_fails_and_hides_hidden_cases():
    runner, _ = go_runner(lambda s: "42\n")
    res = grade(runner)
    assert res.outcome == "wrong_answer" and res.passedCount == 0
    visible, hidden = res.results[0], res.results[1]
    assert visible.args == ["3 4\n"] and visible.expected == "7" and visible.actual == "42"
    assert hidden.args is None and hidden.expected is None and hidden.actual is None


def test_run_mode_uses_examples_only():
    runner, judge = go_runner(add_program)
    res = grade(runner, mode="run")
    assert res.totalCount == 1 and len(judge.payloads) == 1


def test_compile_error_is_syntax_error_with_visible_diagnostic():
    runner, _ = go_runner(add_program, status=6, compile_output="./main.go:3: undefined: x")
    res = grade(runner)
    assert res.outcome == "syntax_error" and res.results[0].diagnostic.startswith("./main.go")
    assert res.results[1].diagnostic is None  # hidden case never leaks compiler output


def test_runtime_error():
    runner, _ = go_runner(add_program, status=11, stderr="panic: index out of range")
    assert grade(runner).outcome == "runtime_error"


def test_bad_case_shape_is_invalid_without_calling_judge0():
    runner, judge = go_runner(add_program)
    res = grade(runner, examples=[{"args": [3, 4], "expected": 7}], hidden=[])
    assert res.outcome == "invalid_output" and not judge.payloads


def test_build_wrapper_returns_code_as_is():
    """StdioRunner.build_wrapper is identity — no injected wrappers."""
    runner = get_runner("go")
    code = "package main\nfunc main() {}"
    assert runner.build_wrapper(code, "main", ["anything"]) == code


@pytest.mark.parametrize("lang", STDIO_LANGUAGES)
def test_each_stdio_language_has_correct_id(lang):
    runner = get_runner(lang)
    assert runner.language_id == STDIO_LANGUAGE_IDS[lang]
