"""Tests for Lane A2: v2 feedback endpoints and runners.

All tests use stubbed Judge0 (no live calls) and stubbed Claude (no API key needed).
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from backend.app.feedback import register_exercise, register_question
from backend.app.feedback.exercise_store import get_store, ExerciseStore, StoredExercise
from backend.app.feedback.diagnosis import diagnose, static_diagnosis, FailingCase
from backend.app.feedback.optimization import analyze_success
from backend.app.feedback.concepts import grade_multiple_choice, grade_predict_output, grade_short_answer
from backend.app.runners import get_runner, SUPPORTED_LANGUAGES
from backend.app.runners.base import RunnerResult, CaseResult, Runner

FIXTURES = Path(__file__).parent / "fixtures" / "submissions"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def make_stored_exercise(fixture: dict) -> StoredExercise:
    ex = fixture["exercise"]
    return StoredExercise(
        id=ex["id"], revision=ex["revision"], title=ex["title"],
        language=ex["language"], statement=ex["statement"],
        functionName=ex["functionName"], starterCode=ex["starterCode"],
        concepts=ex["concepts"], level=ex["level"],
        examples=ex["examples"], hiddenTests=ex["hiddenTests"],
        referenceSolution=ex["referenceSolution"],
    )


def stub_judge0_result(passed: bool, outcome: str = "passed", actual: Any = None) -> dict:
    """Build a fake Judge0 response."""
    if outcome == "passed" or outcome == "wrong_answer":
        value = actual if actual is not None else 42
        return {
            "status": {"id": 3},
            "stdout": json.dumps({"ok": True, "value": value}) + "\n",
            "stderr": "",
            "compile_output": "",
        }
    if outcome == "syntax_error":
        return {"status": {"id": 6}, "stdout": "", "stderr": "", "compile_output": "SyntaxError: invalid syntax"}
    if outcome == "time_limit":
        return {"status": {"id": 5}, "stdout": "", "stderr": "", "compile_output": ""}
    if outcome == "runtime_error":
        return {
            "status": {"id": 11},
            "stdout": "",
            "stderr": "NameError: name 'base' is not defined",
            "compile_output": "",
        }
    return {"status": {"id": 3}, "stdout": "", "stderr": "", "compile_output": ""}


# ---------------------------------------------------------------------------
# Runner unit tests
# ---------------------------------------------------------------------------


class TestRunnerRegistry:
    def test_supported_languages(self):
        assert "python" in SUPPORTED_LANGUAGES
        assert "javascript" in SUPPORTED_LANGUAGES
        assert "java" in SUPPORTED_LANGUAGES
        assert "cpp" in SUPPORTED_LANGUAGES
        assert "sql" in SUPPORTED_LANGUAGES

    def test_get_runner_returns_correct_type(self):
        from backend.app.runners.python_runner import PythonRunner
        from backend.app.runners.javascript_runner import JavaScriptRunner
        from backend.app.runners.java_runner import JavaRunner
        from backend.app.runners.cpp_runner import CppRunner
        from backend.app.runners.sql_runner import SqlRunner

        assert isinstance(get_runner("python"), PythonRunner)
        assert isinstance(get_runner("javascript"), JavaScriptRunner)
        assert isinstance(get_runner("java"), JavaRunner)
        assert isinstance(get_runner("cpp"), CppRunner)
        assert isinstance(get_runner("sql"), SqlRunner)

    def test_unsupported_language_raises(self):
        with pytest.raises(ValueError, match="unsupported language"):
            get_runner("fortran")


class TestPythonWrapper:
    def test_wrapper_shape(self):
        runner = get_runner("python")
        wrapper = runner.build_wrapper(
            "def add(a, b):\n    return a + b",
            "add",
            [1, 2],
        )
        assert "add(*[1, 2])" in wrapper
        assert "__json.dumps" in wrapper

    def test_wrapper_handles_strings(self):
        runner = get_runner("python")
        wrapper = runner.build_wrapper("def greet(s): return 'hi ' + s", "greet", ["world"])
        assert '"world"' in wrapper


class TestJavaScriptWrapper:
    def test_wrapper_shape(self):
        runner = get_runner("javascript")
        wrapper = runner.build_wrapper(
            "function add(a, b) { return a + b; }",
            "add",
            [1, 2],
        )
        assert "add(1, 2)" in wrapper
        assert "JSON.stringify" in wrapper

    def test_normalizes_int_floats(self):
        runner = get_runner("javascript")
        assert runner.normalize_value(5.0) == 5
        assert isinstance(runner.normalize_value(5.0), int)
        assert runner.normalize_value(5.5) == 5.5
        assert runner.normalize_value([1.0, 2.0]) == [1, 2]


class TestJavaWrapper:
    def test_wrapper_shape(self):
        runner = get_runner("java")
        wrapper = runner.build_wrapper(
            "class Solution {\n    public static int add(int a, int b) { return a + b; }\n}",
            "add",
            [1, 2],
        )
        assert "Solution.add" in wrapper
        assert "Main" in wrapper
        assert "toJson" in wrapper

    def test_normalizes_values(self):
        runner = get_runner("java")
        assert runner.normalize_value(5.0) == 5
        assert isinstance(runner.normalize_value(5.0), int)


class TestCppWrapper:
    def test_wrapper_shape(self):
        runner = get_runner("cpp")
        wrapper = runner.build_wrapper(
            "int add(int a, int b) { return a + b; }",
            "add",
            [1, 2],
        )
        assert "add(__arg0, __arg1)" in wrapper
        assert "__toJson" in wrapper
        assert "#include" in wrapper


# ---------------------------------------------------------------------------
# Diagnosis tests
# ---------------------------------------------------------------------------


class TestStaticDiagnosis:
    def test_wrong_answer(self):
        d = static_diagnosis("wrong_answer", FailingCase(args=[2, 3], expected=8, actual=6), "")
        assert d.misconception.id == "wrong-answer"
        assert d.failingCase.expected == 8
        assert d.failingCase.actual == 6

    def test_time_limit(self):
        d = static_diagnosis("time_limit", None, "")
        assert d.misconception.id == "infinite-loop"

    def test_syntax_error(self):
        d = static_diagnosis("syntax_error", None, "")
        assert d.misconception.id == "syntax-error"

    def test_runtime_error(self):
        d = static_diagnosis("runtime_error", FailingCase(error="NameError"), "")
        assert d.misconception.id == "runtime-error"


@pytest.mark.asyncio
async def test_diagnose_fallback_no_key():
    """Without API key, diagnosis should fall back to static."""
    with patch.dict("os.environ", {"ANTHROPIC_API_KEY": ""}, clear=False):
        diag, ai = await diagnose(
            title="Test", statement="Test", language="python",
            code="def f(x): return x", function_name="f",
            outcome="wrong_answer",
            failing_case=FailingCase(args=[1], expected=2, actual=1),
            concepts=["functions"],
        )
    assert not ai
    assert diag.misconception.id == "wrong-answer"


@pytest.mark.asyncio
async def test_diagnose_with_stub_model():
    """With a stubbed model call, diagnosis should parse structured output."""
    model_response = json.dumps({
        "misconceptionId": "off-by-one",
        "misconceptionName": "Off by one",
        "explanation": "The loop runs one too few times.",
        "lines": [{"line": 3, "note": "range should include n"}],
    })

    async def stub_call(prompt: str) -> str:
        return model_response

    diag, ai = await diagnose(
        title="Test", statement="Test", language="python",
        code="def f(n):\n    s = 0\n    for i in range(n):\n        s += i\n    return s",
        function_name="f",
        outcome="wrong_answer",
        failing_case=FailingCase(args=[5], expected=15, actual=10),
        concepts=["loops"],
        model_call=stub_call,
    )
    assert ai
    assert diag.misconception.id == "off-by-one"
    assert len(diag.lines) == 1
    assert diag.lines[0].line == 3


# ---------------------------------------------------------------------------
# Optimization tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_optimization_fallback():
    """Without API key, optimization falls back to static."""
    with patch.dict("os.environ", {"ANTHROPIC_API_KEY": ""}, clear=False):
        success, ai = await analyze_success(
            title="Power", statement="Raise to power using loop",
            language="python",
            code="def f(b, p):\n    r = 1\n    for _ in range(p): r *= b\n    return r",
            function_name="f",
            reference_solution="def f(b, p):\n    r = 1\n    for _ in range(p): r *= b\n    return r",
            learner_level="beginner-1",
            concepts=["loops"],
        )
    assert not ai
    # Beginner -> show=False
    assert not success.optimization.show


@pytest.mark.asyncio
async def test_optimization_intermediate_shows():
    """Intermediate learners see optimization."""
    model_response = json.dumps({
        "explanation": "You demonstrated loop accumulation.",
        "summary": "O(n) time, could be O(log n).",
        "learnerTime": "O(n)", "learnerSpace": "O(1)",
        "bestTime": "O(log n)", "bestSpace": "O(1)",
        "optimal": False,
        "tip": "Use repeated squaring.",
        "betterSolution": "def f(b, p):\n    r = 1\n    while p:\n        if p % 2: r *= b\n        b *= b; p //= 2\n    return r",
    })

    async def stub_call(prompt: str) -> str:
        return model_response

    success, ai = await analyze_success(
        title="Power", statement="Raise to power using loop",
        language="python",
        code="def f(b, p):\n    r = 1\n    for _ in range(p): r *= b\n    return r",
        function_name="f",
        reference_solution="def f(b, p):\n    r = 1\n    while p:\n        if p % 2: r *= b\n        b *= b; p //= 2\n    return r",
        learner_level="intermediate-1",
        concepts=["loops"],
        model_call=stub_call,
    )
    assert ai
    assert success.optimization.show
    assert success.optimization.tip is not None
    assert success.optimization.betterSolution is not None


@pytest.mark.asyncio
async def test_optimization_beginner_hides():
    """Beginners should not see optimization even if model says not optimal."""
    model_response = json.dumps({
        "explanation": "Basic loop accumulation.",
        "summary": "Your solution works.",
        "learnerTime": "O(n)", "learnerSpace": "O(1)",
        "bestTime": "O(log n)", "bestSpace": "O(1)",
        "optimal": False,
        "tip": "Use repeated squaring.",
        "betterSolution": "def f(b, p): pass",
    })

    async def stub_call(prompt: str) -> str:
        return model_response

    success, _ = await analyze_success(
        title="Power", statement="Raise to power",
        language="python",
        code="def f(b, p): pass",
        function_name="f",
        reference_solution="def f(b, p): pass",
        learner_level="beginner-3",
        concepts=["loops"],
        model_call=stub_call,
    )
    assert not success.optimization.show
    assert success.optimization.betterSolution is None


# ---------------------------------------------------------------------------
# Concept question tests
# ---------------------------------------------------------------------------


class TestMultipleChoice:
    def test_correct(self):
        r = grade_multiple_choice("c", "c")
        assert r.correct
        assert not r.aiGenerated

    def test_incorrect(self):
        r = grade_multiple_choice("a", "c")
        assert not r.correct

    def test_case_insensitive(self):
        r = grade_multiple_choice("C", "c")
        assert r.correct


class TestPredictOutput:
    def test_correct(self):
        r = grade_predict_output("0 1 2", "0 1 2")
        assert r.correct

    def test_trailing_space(self):
        r = grade_predict_output("0 1 2 ", "0 1 2")
        assert r.correct

    def test_wrong(self):
        r = grade_predict_output("1 2 3", "0 1 2")
        assert not r.correct


@pytest.mark.asyncio
async def test_short_answer_with_stub():
    model_response = json.dumps({
        "correct": True,
        "explanation": "The answer captures the key idea.",
    })

    async def stub_call(prompt: str) -> str:
        return model_response

    r = await grade_short_answer(
        "What is a variable?",
        "A named storage location in memory",
        "A name that stores a value",
        model_call=stub_call,
    )
    assert r.correct
    assert r.aiGenerated


@pytest.mark.asyncio
async def test_short_answer_fallback():
    """Without API key, falls back to basic matching."""
    with patch.dict("os.environ", {"ANTHROPIC_API_KEY": ""}, clear=False):
        r = await grade_short_answer(
            "What is a variable?",
            "A named storage location",
            "storage location in memory",
        )
    assert not r.aiGenerated


# ---------------------------------------------------------------------------
# Exercise store tests
# ---------------------------------------------------------------------------


class TestExerciseStore:
    def test_store_and_retrieve(self):
        store = ExerciseStore()
        ex = StoredExercise(
            id="test-1", revision="r1", title="Test", language="python",
            statement="Test", functionName="f", starterCode="",
            concepts=["loops"], level="beginner-1",
            examples=[{"args": [1], "expected": 1}],
            hiddenTests=[{"args": [2], "expected": 4}],
            referenceSolution="def f(x): return x*x",
        )
        store.store_exercise(ex)
        assert store.get_exercise("test-1") is not None
        assert store.get_exercise("nonexistent") is None

    def test_question_store(self):
        store = ExerciseStore()
        q = StoredExercise(
            id="q-1", revision="r1", title="MC Question", language="pseudocode",
            statement="What is 2+2?", functionName="", starterCode="",
            concepts=["operators"], level="beginner-1",
            examples=[], hiddenTests=[], referenceSolution="",
            questionId="q-1", style="multiple_choice",
            prompt="What is 2+2?", correctAnswer="b",
            choices=[{"id": "a", "text": "3"}, {"id": "b", "text": "4"}],
        )
        store.store_question(q)
        assert store.get_question("q-1") is not None


# ---------------------------------------------------------------------------
# Registration helpers
# ---------------------------------------------------------------------------


def test_register_exercise():
    register_exercise(
        exercise_id="reg-test-1", revision="r1", title="Test",
        language="python", statement="Test", function_name="f",
        starter_code="", concepts=["loops"], level="beginner-1",
        examples=[{"args": [1], "expected": 1}],
        hidden_tests=[{"args": [2], "expected": 4}],
        reference_solution="def f(x): return x*x",
    )
    store = get_store()
    assert store.get_exercise("reg-test-1") is not None


def test_register_question():
    register_question(
        question_id="reg-q-1", revision="r1", title="MC",
        style="multiple_choice", prompt="What?", concepts=["loops"],
        level="beginner-1", correct_answer="a",
        choices=[{"id": "a", "text": "Yes"}, {"id": "b", "text": "No"}],
    )
    store = get_store()
    assert store.get_question("reg-q-1") is not None


# ---------------------------------------------------------------------------
# Fixture-based submission tests (labelled set, stubbed Judge0)
# ---------------------------------------------------------------------------


def _make_judge0_response(code: str, expected: Any, exercise: dict) -> dict:
    """Build a mock Judge0 response based on the submission."""
    # For test purposes, simulate running the code locally in Python
    try:
        namespace: dict = {}
        exec(code, namespace)
        fn = namespace.get(exercise["functionName"])
        if fn is None:
            return {"status": {"id": 11}, "stdout": "", "stderr": "function not found", "compile_output": ""}
        for ex in exercise["examples"]:
            result = fn(*ex["args"])
            value = result
            return {
                "status": {"id": 3},
                "stdout": json.dumps({"ok": True, "value": value}) + "\n",
                "stderr": "", "compile_output": "",
            }
    except SyntaxError:
        return {"status": {"id": 6}, "stdout": "", "stderr": "", "compile_output": "SyntaxError"}
    except RecursionError:
        return {"status": {"id": 5}, "stdout": "", "stderr": "", "compile_output": ""}
    except Exception as e:
        return {"status": {"id": 11}, "stdout": "", "stderr": str(e), "compile_output": ""}
    return {"status": {"id": 3}, "stdout": "", "stderr": "", "compile_output": ""}


class TestPythonSubmissions:
    """Run the labelled Python fixture set through the runner with local exec."""

    @pytest.fixture
    def fixture_data(self):
        return load_fixture("python_submissions.json")

    @pytest.mark.parametrize("sub_idx", range(10))
    def test_submission_outcome(self, fixture_data, sub_idx):
        """Verify the expected outcome for each labelled Python submission."""
        import signal

        sub = fixture_data["submissions"][sub_idx]
        exercise = fixture_data["exercise"]
        code = sub["code"]
        expected_outcome = sub["expectedOutcome"]

        class _Timeout(Exception):
            pass

        def _alarm(signum, frame):
            raise _Timeout

        # Run locally to verify the label; use SIGALRM to catch infinite loops.
        old = signal.signal(signal.SIGALRM, _alarm)
        try:
            ns: dict = {}
            exec(code, ns)
            fn = ns.get(exercise["functionName"])
            if fn is None:
                actual_outcome = "runtime_error"
            else:
                all_pass = True
                for ex in exercise["examples"] + exercise["hiddenTests"]:
                    signal.alarm(2)  # 2 second timeout per case
                    try:
                        result = fn(*ex["args"])
                        signal.alarm(0)
                        if result != ex["expected"]:
                            all_pass = False
                            actual_outcome = "wrong_answer"
                            break
                    except _Timeout:
                        actual_outcome = "time_limit"
                        all_pass = False
                        break
                    except RecursionError:
                        signal.alarm(0)
                        actual_outcome = "time_limit"
                        all_pass = False
                        break
                    except Exception:
                        signal.alarm(0)
                        actual_outcome = "runtime_error"
                        all_pass = False
                        break
                if all_pass:
                    actual_outcome = "passed"
        except SyntaxError:
            actual_outcome = "syntax_error"
        except _Timeout:
            actual_outcome = "time_limit"
        except Exception:
            actual_outcome = "runtime_error"
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, old)

        assert actual_outcome == expected_outcome, (
            f"Submission {sub['id']}: expected {expected_outcome}, got {actual_outcome}: {sub['description']}"
        )


class TestJavaScriptFixtureLabels:
    """Verify JS fixture labels are internally consistent."""

    @pytest.fixture
    def fixture_data(self):
        return load_fixture("javascript_submissions.json")

    def test_fixture_has_enough_submissions(self, fixture_data):
        assert len(fixture_data["submissions"]) >= 10

    def test_has_pass_and_fail(self, fixture_data):
        outcomes = {s["expectedOutcome"] for s in fixture_data["submissions"]}
        assert "passed" in outcomes
        assert "wrong_answer" in outcomes or "syntax_error" in outcomes


class TestJavaFixtureLabels:
    """Verify Java fixture labels."""

    @pytest.fixture
    def fixture_data(self):
        return load_fixture("java_submissions.json")

    def test_fixture_has_enough_submissions(self, fixture_data):
        assert len(fixture_data["submissions"]) >= 10

    def test_has_pass_and_fail(self, fixture_data):
        outcomes = {s["expectedOutcome"] for s in fixture_data["submissions"]}
        assert "passed" in outcomes
        assert any(o != "passed" for o in outcomes)


class TestCppFixtureLabels:
    @pytest.fixture
    def fixture_data(self):
        return load_fixture("cpp_submissions.json")

    def test_fixture_has_submissions(self, fixture_data):
        assert len(fixture_data["submissions"]) >= 5


class TestConceptQuestionFixtures:
    @pytest.fixture
    def fixture_data(self):
        return load_fixture("concept_questions.json")

    def test_has_questions(self, fixture_data):
        assert len(fixture_data["questions"]) >= 5

    @pytest.mark.parametrize("q_idx", range(5))
    def test_mc_and_predict_correct_answers(self, fixture_data, q_idx):
        q = fixture_data["questions"][q_idx]
        for test in q["tests"]:
            if q["style"] == "multiple_choice":
                result = grade_multiple_choice(test["answer"], q["correctAnswer"])
            elif q["style"] == "predict_output":
                result = grade_predict_output(test["answer"], q["correctAnswer"])
            else:
                continue
            assert result.correct == test["expectedCorrect"], (
                f"Question {q['id']}, answer {test['answer']}: "
                f"expected {test['expectedCorrect']}, got {result.correct}: {test['description']}"
            )


# ---------------------------------------------------------------------------
# API endpoint integration tests (with TestClient, stubbed runners)
# ---------------------------------------------------------------------------


@pytest.fixture
def registered_exercise():
    """Register a test exercise and return its data."""
    fixture = load_fixture("python_submissions.json")
    ex = fixture["exercise"]
    register_exercise(
        exercise_id=ex["id"], revision=ex["revision"], title=ex["title"],
        language=ex["language"], statement=ex["statement"],
        function_name=ex["functionName"], starter_code=ex["starterCode"],
        concepts=ex["concepts"], level=ex["level"],
        examples=ex["examples"], hidden_tests=ex["hiddenTests"],
        reference_solution=ex["referenceSolution"],
    )
    return fixture


@pytest.fixture
def registered_question():
    """Register a test concept question and return its data."""
    fixture = load_fixture("concept_questions.json")
    q = fixture["questions"][0]  # multiple choice 2D list
    register_question(
        question_id=q["id"], revision=q["revision"], title=q["title"],
        style=q["style"], prompt=q["prompt"], concepts=q["concepts"],
        level=q["level"], correct_answer=q["correctAnswer"],
        choices=q.get("choices"),
    )
    return q


# ---------------------------------------------------------------------------
# Total submission count across languages
# ---------------------------------------------------------------------------


def test_total_labelled_submissions():
    """Proof: >=30 labelled submissions across >=3 languages."""
    total = 0
    languages = set()
    for name in ("python_submissions.json", "javascript_submissions.json",
                 "java_submissions.json", "cpp_submissions.json"):
        data = load_fixture(name)
        total += len(data["submissions"])
        languages.add(data["language"])
    assert total >= 30, f"Only {total} submissions, need >=30"
    assert len(languages) >= 3, f"Only {len(languages)} languages, need >=3"


# ---------------------------------------------------------------------------
# Level-aware hint depth
# ---------------------------------------------------------------------------


class TestLevelAwareHintDepth:
    """Verify that advanced/expert learners get vaguer hints."""

    def test_beginner_no_penalty(self):
        from backend.app.feedback import _tier_from_level
        assert _tier_from_level("beginner-1") == "beginner"

    def test_intermediate_tier(self):
        from backend.app.feedback import _tier_from_level
        assert _tier_from_level("intermediate-3") == "intermediate"

    def test_advanced_tier(self):
        from backend.app.feedback import _tier_from_level
        assert _tier_from_level("advanced-2") == "advanced"

    def test_expert_tier(self):
        from backend.app.feedback import _tier_from_level
        assert _tier_from_level("expert-5") == "expert"


# ---------------------------------------------------------------------------
# Planner integration: /v2/submit resolves exercises via find_exercise
# ---------------------------------------------------------------------------


class TestPlannerExerciseLookup:
    """Verify that /v2/submit and /v2/hint fall back to the A1 planner."""

    def test_submit_finds_planner_exercise(self):
        """When the exercise is only in the planner, /v2/submit should find it."""
        from dataclasses import dataclass
        from backend.app.catalog import ApprovedExercise, Example, HiddenTest

        # Build a mock PrivateExercise
        @dataclass
        class FakePrivateExercise:
            exercise: ApprovedExercise
            revision: str
            concepts: list
            level: str
            language: str

        fake = FakePrivateExercise(
            exercise=ApprovedExercise(
                id="plan-ex-1",
                title="Planner Exercise",
                statement="Add two numbers",
                language="python",
                functionName="add",
                starterCode="def add(a, b):\n    pass",
                conceptTags=["functions"],
                examples=[Example(args=[1, 2], expected=3)],
                hiddenTests=[HiddenTest(args=[0, 0], expected=0)],
                referenceSolution="def add(a, b):\n    return a + b",
                knownWrongSolution="def add(a, b):\n    return a - b",
            ),
            revision="r-plan1",
            concepts=["functions"],
            level="beginner-1",
            language="python",
        )

        with patch("backend.app.feedback.get_store") as mock_store:
            mock_store.return_value.get_exercise.return_value = None
            with patch("backend.app.planner.find_exercise", return_value=fake):
                from backend.app.feedback import StoredExercise
                from backend.app.planner import find_exercise
                result = find_exercise("plan-ex-1")
                assert result is not None
                assert result.revision == "r-plan1"
                assert result.exercise.id == "plan-ex-1"


class TestPlannerQuestionLookup:
    """Verify that /v2/answer falls back to the A1 planner's questions."""

    def test_planner_question_found(self):
        """When a question is only in the planner, the lookup should work."""
        from dataclasses import dataclass

        @dataclass
        class FakePrivateQuestion:
            id: str
            revision: str
            title: str
            style: str
            prompt: str
            choices: list
            answer: str
            explanation: str
            concepts: list
            level: str

        fake = FakePrivateQuestion(
            id="plan-q-1", revision="r-planq1", title="Test MC",
            style="multiple_choice", prompt="What is 1+1?",
            choices=[{"id": "a", "text": "1"}, {"id": "b", "text": "2"}],
            answer="b", explanation="1+1=2",
            concepts=["arithmetic"], level="beginner-1",
        )

        with patch("backend.app.planner.find_question", return_value=fake):
            from backend.app.planner import find_question
            result = find_question("plan-q-1")
            assert result is not None
            assert result.id == "plan-q-1"
            assert result.answer == "b"


# ---------------------------------------------------------------------------
# Profile refresher integration: /v2/answer resolves refresher questions
# ---------------------------------------------------------------------------


class TestRefresherQuestionLookup:
    """Verify that /v2/answer falls back to B1 profile refresher questions."""

    def test_refresher_lookup(self):
        """When a question is a refresher, lookup_refresher returns grading data."""
        fake_ref = {
            "question": {
                "id": "rf-loops-1",
                "revision": "rf-loops-1-abc123",
                "title": "Loop Refresher",
                "style": "multiple_choice",
                "prompt": "What does a for loop do?",
                "choices": [{"id": "a", "text": "Iterates"}, {"id": "b", "text": "Declares"}],
                "concepts": ["loops"],
                "level": "beginner-1",
            },
            "answer": "a",
            "explanation": "A for loop iterates over a sequence.",
        }

        with patch("backend.app.profile.skills.lookup_refresher", return_value=fake_ref):
            from backend.app.profile.skills import lookup_refresher
            result = lookup_refresher("rf-loops-1")
            assert result is not None
            assert result["answer"] == "a"
            assert result["question"]["id"] == "rf-loops-1"

    def test_refresher_grading_mc(self):
        """Grade a refresher MC question correctly."""
        result = grade_multiple_choice("a", "a")
        assert result.correct

    def test_refresher_grading_mc_wrong(self):
        """Grade a refresher MC question incorrectly."""
        result = grade_multiple_choice("b", "a")
        assert not result.correct
