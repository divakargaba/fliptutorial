"""Lane A1 planner: coding pauses in languages graded by lane A2's runners (offline, stubbed)."""

from __future__ import annotations

import asyncio
import json
import sys
import types
from dataclasses import dataclass

import pytest

from app import planner as planner_api
from app.planner import service, vocab
from app.planner.generate import GenerationFailed, PlannedExercise, check_coding
from app.testme import GenOutput, _CheckFailed
from app.transcripts import Clip, Cue

from tests.test_planner import (
    GOOD_EXERCISE, StubModel, assert_no_secrets, coding_window, make_planner, make_transcript, run_to_ready,
)

ALL_CODING = ("python", "javascript", "java", "cpp")

JS_EXERCISE = {
    **GOOD_EXERCISE, "language": "javascript", "languageEvidence": "function",
    "statement": "Write sumTo(n) that returns 1 + 2 + ... + n using a loop.", "functionName": "sumTo",
    "starterCode": "function sumTo(n) {\n  return null;\n}\n",
    "referenceSolution": "function sumTo(n) {\n  let t = 0;\n  for (let i = 1; i <= n; i++) t += i;\n  return t;\n}\n",
    "knownWrongSolution": "function sumTo(n) {\n  let t = 0;\n  for (let i = 1; i < n; i++) t += i;\n  return t;\n}\n",
}
JAVA_EXERCISE = {
    **JS_EXERCISE, "language": "java",
    "starterCode": "class Solution {\n    public static int sumTo(int n) {\n        return 0;\n    }\n}\n",
    "referenceSolution": "import java.util.*;\nclass Solution {\n    public static int sumTo(int n) {\n        int t = 0;\n"
                         "        for (int i = 1; i <= n; i++) t += i;\n        return t;\n    }\n}\n",
    "knownWrongSolution": "class Solution {\n    public static int sumTo(int n) {\n        int t = 0;\n"
                          "        for (int i = 1; i < n; i++) t += i;\n        return t;\n    }\n}\n",
}
CPP_EXERCISE = {
    **JS_EXERCISE, "language": "cpp",
    "starterCode": "int sumTo(int n) {\n    return 0;\n}\n",
    "referenceSolution": "#include <numeric>\nint sumTo(int n) {\n    int t = 0;\n    for (int i = 1; i <= n; i++) t += i;\n"
                         "    return t;\n}\n",
    "knownWrongSolution": "int sumTo(int n) {\n    int t = 0;\n    for (int i = 1; i < n; i++) t += i;\n    return t;\n}\n",
}


def clip_one() -> Clip:
    return Clip("vid", "manual", "t", 10.0, 0.0, (Cue("c00000000", 0.0, 5.0, "a for loop"),))


def gen(d: dict) -> GenOutput:
    return GenOutput.model_validate({**d, "conceptEvidenceCueIds": ["c00000000"]})


def js_window() -> dict:
    w = coding_window()
    w["sections"][1].update(title="JS loops", language="JavaScript", languageEvidence="function and let")
    return w


@pytest.fixture
def runners_present(monkeypatch):
    monkeypatch.setattr(service, "coding_languages", lambda: ALL_CODING)


# ---------------------------------------------------------------------------
# Plan flow
# ---------------------------------------------------------------------------


def test_javascript_section_gets_verified_coding_pause(tmp_path, runners_present):
    seen: list[PlannedExercise] = []

    async def verify(ex) -> bool:
        seen.append(ex)
        return True

    model = StubModel(window=js_window, exercise=JS_EXERCISE)
    p = make_planner(tmp_path, model=model)
    p.verify = verify
    _, plan = asyncio.run(run_to_ready(p))
    ex = plan["pauses"][0]["exercise"]
    assert ex["language"] == "javascript" and ex["starterCode"].startswith("function sumTo(")
    assert_no_secrets(plan)
    assert seen and all(e.language == "javascript" for e in seen)
    prompt = next(pr for n, pr in model.calls if n == "GenOutput")
    assert 'language is "javascript"' in prompt and "function name(a, b)" in prompt
    priv = p.find_exercise(ex["id"])
    assert priv.language == "javascript" and priv.exercise.knownWrongSolution

    # Restart: the cached private record keeps its language.
    p2 = make_planner(tmp_path, model=StubModel(window=js_window, exercise=JS_EXERCISE))
    assert p2.request("vidPlanner1", "beginner-1")["pauses"][0]["exercise"]["language"] == "javascript"
    assert p2.find_exercise(ex["id"]).exercise.language == "javascript"


def test_javascript_falls_back_to_concept_without_runners(tmp_path, monkeypatch):
    monkeypatch.setattr(service, "coding_languages", lambda: ("python",))
    model = StubModel(window=js_window, exercise=JS_EXERCISE)
    _, plan = asyncio.run(run_to_ready(make_planner(tmp_path, model=model)))
    assert plan["pauses"][0]["kind"] == "concept" and model.count("GenOutput") == 0


def test_failed_runner_verify_falls_back_to_concept(tmp_path, runners_present):
    model = StubModel(window=js_window, exercise=JS_EXERCISE)
    _, plan = asyncio.run(run_to_ready(make_planner(tmp_path, model=model, verify_ok=False)))
    assert plan["pauses"][0]["kind"] == "concept"


def test_coding_languages_needs_runners(monkeypatch):
    vocab.coding_languages.cache_clear()
    monkeypatch.setitem(sys.modules, "app.runners", None)  # import fails
    try:
        assert vocab.coding_languages() == ("python",)
        fake = types.ModuleType("app.runners")
        fake.SUPPORTED_LANGUAGES = ("python", "javascript", "java", "cpp", "sql")
        monkeypatch.setitem(sys.modules, "app.runners", fake)
        vocab.coding_languages.cache_clear()
        assert vocab.coding_languages() == ALL_CODING
    finally:
        vocab.coding_languages.cache_clear()


# ---------------------------------------------------------------------------
# Static checks
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("lang,d", [("javascript", JS_EXERCISE), ("java", JAVA_EXERCISE), ("cpp", CPP_EXERCISE)])
def test_check_coding_accepts_each_language(lang, d):
    ex, tags = check_coding(gen(d), clip_one(), "pe-x", lang)
    assert ex.language == lang and ex.functionName == "sumTo" and tags == ["loops"]
    assert [c.args for c in ex.hiddenTests] == [[1], [0], [5]]


@pytest.mark.parametrize("lang,d,field,code,why", [
    ("javascript", JS_EXERCISE, "referenceSolution", "function sumTo(n) { console.log(n); return n; }", "I/O"),
    ("javascript", JS_EXERCISE, "referenceSolution", "const fs = require('fs');\nfunction sumTo(n) { return n; }", "I/O"),
    ("javascript", JS_EXERCISE, "starterCode", "const sumTo = (n) => null;", "required shape"),
    ("java", JAVA_EXERCISE, "referenceSolution",
     "class Solution { public static int sumTo(int n) { System.out.println(n); return n; } }", "I/O"),
    ("java", JAVA_EXERCISE, "referenceSolution",
     "import java.io.*;\nclass Solution { public static int sumTo(int n) { return n; } }", "I/O"),
    ("java", JAVA_EXERCISE, "starterCode", "public class Solution { public static int sumTo(int n) { return 0; } }", "I/O"),
    ("java", JAVA_EXERCISE, "starterCode", "class Other { public static int sumTo(int n) { return 0; } }", "required shape"),
    ("cpp", CPP_EXERCISE, "referenceSolution", "#include <fstream>\nint sumTo(int n) { return n; }", "I/O"),
    ("cpp", CPP_EXERCISE, "referenceSolution", "int sumTo(int n) { system(\"ls\"); return n; }", "I/O"),
    ("cpp", CPP_EXERCISE, "referenceSolution", "int sumTo(int n) { return n; }\nint main() { return 0; }", "I/O"),
    ("cpp", CPP_EXERCISE, "starterCode", "int other(int n) { return 0; }", "required shape"),
])
def test_check_coding_rejects(lang, d, field, code, why):
    with pytest.raises(_CheckFailed, match=why):
        check_coding(gen({**d, field: code}), clip_one(), "pe-x", lang)


def test_check_coding_rejects_null_cases_for_typed_languages():
    bad = {**JAVA_EXERCISE, "hiddenTests": [*JAVA_EXERCISE["hiddenTests"][:2], {"argsJson": "[null]", "expectedJson": "0"}]}
    with pytest.raises(_CheckFailed, match="null"):
        check_coding(gen(bad), clip_one(), "pe-x", "java")
    js_null = {**JS_EXERCISE, "hiddenTests": [*JS_EXERCISE["hiddenTests"][:2], {"argsJson": "[null]", "expectedJson": "0"}]}
    check_coding(gen(js_null), clip_one(), "pe-x", "javascript")


def test_check_coding_language_and_status():
    with pytest.raises(_CheckFailed, match="language must be"):
        check_coding(gen({**JS_EXERCISE, "language": "python"}), clip_one(), "pe-x", "javascript")
    with pytest.raises(GenerationFailed):
        check_coding(gen({**JS_EXERCISE, "status": "noExercise"}), clip_one(), "pe-x", "javascript")
    with pytest.raises(_CheckFailed, match="all differ"):
        check_coding(gen({**JS_EXERCISE, "knownWrongSolution": JS_EXERCISE["referenceSolution"]}), clip_one(),
                     "pe-x", "javascript")


# ---------------------------------------------------------------------------
# Runner verify (fake app.runners)
# ---------------------------------------------------------------------------


@dataclass
class _Case:
    outcome: str


@dataclass
class _Result:
    passedCount: int
    totalCount: int
    results: list


class _Busy(Exception):
    pass


class _Unavailable(Exception):
    pass


class _Timeout(Exception):
    pass


class FakeRunner:
    def __init__(self, behaviour: dict[str, str], busy_first: int = 0):
        self.behaviour, self.busy_left = behaviour, busy_first
        self.calls: list[tuple[str, str, int]] = []

    async def grade(self, code, function_name, examples, hidden, mode):
        if self.busy_left:
            self.busy_left -= 1
            raise _Busy()
        n = len(examples) + (len(hidden) if mode == "submit" else 0)
        kind = next(k for k, marker in (("ref", "<= n"), ("wrong", "< n"), ("starter", "return null")) if marker in code)
        self.calls.append((kind, mode, n))
        b = self.behaviour.get(kind, "ok")
        if b == "syntax":
            return _Result(0, n, [_Case("syntax_error")] * n)
        if kind == "wrong" and b == "ok":
            return _Result(n - 1, n, [_Case("passed")] * (n - 1) + [_Case("wrong_answer")])
        if b == "fail":
            return _Result(n - 1, n, [_Case("passed")] * (n - 1) + [_Case("wrong_answer")])
        if b == "allpass":
            return _Result(n, n, [_Case("passed")] * n)
        return _Result(n, n, [_Case("passed")] * n)


def install_runner(monkeypatch, runner: FakeRunner):
    fake = types.ModuleType("app.runners")
    fake.RunnerBusy, fake.RunnerUnavailable, fake.RunnerTimeout = _Busy, _Unavailable, _Timeout
    fake.SUPPORTED_LANGUAGES = ("python", "javascript", "java", "cpp", "sql")
    fake.get_runner = lambda language: runner
    monkeypatch.setitem(sys.modules, "app.runners", fake)

    async def no_sleep(_s):
        return None

    monkeypatch.setattr(asyncio, "sleep", no_sleep)


def js_planned() -> PlannedExercise:
    return check_coding(gen(JS_EXERCISE), clip_one(), "pe-x", "javascript")[0]


@pytest.mark.parametrize("behaviour,ok", [
    ({}, True),
    ({"ref": "fail"}, False),
    ({"wrong": "allpass"}, False),
    ({"wrong": "syntax"}, False),
    ({"starter": "syntax"}, False),
])
def test_runner_verify_rule(monkeypatch, behaviour, ok):
    runner = FakeRunner(behaviour, busy_first=2)
    install_runner(monkeypatch, runner)
    assert asyncio.run(planner_api.judge0_verify(js_planned())) is ok
    assert runner.calls[0] == ("ref", "submit", 4)
    if ok:
        assert [c[:2] for c in runner.calls] == [("ref", "submit"), ("wrong", "submit"), ("starter", "run")]
        assert runner.calls[2][2] == 1  # starter only runs the visible example


def test_runner_verify_unavailable_is_false(monkeypatch):
    class Down(FakeRunner):
        async def grade(self, *a, **k):
            raise _Unavailable()

    install_runner(monkeypatch, Down({}))
    assert asyncio.run(planner_api.judge0_verify(js_planned())) is False
    install_runner(monkeypatch, FakeRunner({}, busy_first=10_000))
    assert asyncio.run(planner_api.judge0_verify(js_planned())) is False
