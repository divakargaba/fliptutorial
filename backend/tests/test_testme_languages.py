"""Offline: multi-language Test me (planner shapes/checks + runner verify) and coding-first planning."""

from __future__ import annotations

import asyncio
import json

import pytest

from app.planner.classify import PauseSlot, Section
from app.planner.service import planned_kind
from app.testme import ExerciseGenerator, TestMeError, build_prompt, enabled_languages
from tests.test_testme import CLIP, StubModel, _good, ok_verify

ALL = ("python", "javascript", "java", "cpp")

JS = _good(
    language="JavaScript", languageEvidence="function add3(a, b, c)",
    starterCode="function add3(a, b, c) {\n  return null;\n}\n",
    referenceSolution="function add3(a, b, c) {\n  return a + b + c;\n}\n",
    knownWrongSolution="function add3(a, b, c) {\n  return a + b;\n}\n",
)
JAVA = _good(
    language="java", languageEvidence="public static int",
    starterCode="class Solution {\n  public static int add3(int a, int b, int c) { return 0; }\n}\n",
    referenceSolution="class Solution {\n  public static int add3(int a, int b, int c) { return a + b + c; }\n}\n",
    knownWrongSolution="class Solution {\n  public static int add3(int a, int b, int c) { return a + b; }\n}\n",
)
CPP = _good(
    language="C++", languageEvidence="int add3(int a",
    starterCode="int add3(int a, int b, int c) {\n  return 0;\n}\n",
    referenceSolution="int add3(int a, int b, int c) {\n  return a + b + c;\n}\n",
    knownWrongSolution="int add3(int a, int b, int c) {\n  return a + b;\n}\n",
)


def _run(gen: ExerciseGenerator, verify=None):
    return asyncio.run(gen.generate(CLIP, verify or ok_verify()))


@pytest.mark.parametrize("answer,language", [(JS, "javascript"), (JAVA, "java"), (CPP, "cpp")])
def test_non_python_exercise_uses_planner_checks_and_runner_verify(answer, language):
    python_verify, runner = ok_verify(), ok_verify()
    model = StubModel(answer)
    s = _run(ExerciseGenerator(model_call=model, model_name="stub", languages=ALL, runner_verify=runner),
             python_verify)
    assert s.exercise.language == language and s.exercise.id == f"{s.set_id}-1"
    assert runner.seen == [s.exercise] and python_verify.seen == []  # graded by the language runner
    assert "operators" in s.concept_tags or "functions" in s.concept_tags
    assert "JavaScript" in model.prompts[0] and "class Solution" in model.prompts[0]


def test_python_still_uses_the_python_verify_in_multi_language_mode():
    python_verify, runner = ok_verify(), ok_verify()
    s = _run(ExerciseGenerator(model_call=StubModel(_good()), model_name="stub", languages=ALL,
                               runner_verify=runner), python_verify)
    assert s.exercise.language == "python" and python_verify.seen and not runner.seen


def test_language_not_enabled_is_not_python():
    with pytest.raises(TestMeError) as e:
        _run(ExerciseGenerator(model_call=StubModel(JS), model_name="stub", languages=("python",)))
    assert e.value.code == "NOT_PYTHON"


def test_unsupported_language_is_not_python():
    with pytest.raises(TestMeError) as e:
        _run(ExerciseGenerator(model_call=StubModel(_good(language="rust")), model_name="stub", languages=ALL))
    assert e.value.code == "NOT_PYTHON"


def test_static_check_failure_retries_then_runner_verify_failure_is_unavailable():
    bad = {**JAVA, "referenceSolution": "public class Solution { public static int add3(int a) { return a; } }"}
    model = StubModel(bad, JAVA)
    runner = ok_verify([False])
    with pytest.raises(TestMeError) as e:
        _run(ExerciseGenerator(model_call=model, model_name="stub", languages=ALL, runner_verify=runner))
    assert e.value.code == "GENERATOR_UNAVAILABLE" and len(model.prompts) == 2
    assert "rejected" in model.prompts[1] and len(runner.seen) == 1


def test_python_only_prompt_is_unchanged_and_default_is_every_gradable_language(monkeypatch):
    monkeypatch.delenv("BREAKPOINT_TESTME_LANGUAGES", raising=False)
    assert enabled_languages() == ALL
    assert "not teaching Python code" in build_prompt(CLIP)
    monkeypatch.setenv("BREAKPOINT_TESTME_LANGUAGES", "python, js ,java,c++,rust")
    assert set(enabled_languages()) == set(ALL)


def test_env_var_narrows_languages(monkeypatch):
    monkeypatch.setenv("BREAKPOINT_TESTME_LANGUAGES", "python")
    assert enabled_languages() == ("python",)
    monkeypatch.setenv("BREAKPOINT_TESTME_LANGUAGES", "java")
    assert enabled_languages() == ("python", "java")  # Python is always on


def test_public_endpoint_shape_unchanged_for_javascript(monkeypatch):
    """/v1/test-me keeps its keys; only exercise.language differs."""
    from fastapi.testclient import TestClient

    import app.main as main
    import app.testme as testme
    from app.transcripts import Transcript

    from unittest.mock import AsyncMock, patch

    monkeypatch.setattr(main, "TESTME_ENABLED", True)
    monkeypatch.setattr(testme, "_default", ExerciseGenerator(
        model_call=StubModel(JS), model_name="stub", languages=ALL, runner_verify=ok_verify()))
    transcript = Transcript(CLIP.video_id, "asr", "en", "Learn JS", CLIP.cues)
    with TestClient(main.app) as client, patch("app.main.fetcher") as fetcher:
        fetcher.get = AsyncMock(return_value=transcript)
        resp = client.post("/v1/test-me", json={"videoId": CLIP.video_id, "timestampS": 605.0})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"setId", "generated", "aiGenerated", "exercise"}
    assert set(body["exercise"]) == {"id", "title", "statement", "language", "starterCode", "examples"}
    assert body["exercise"]["language"] == "javascript"
    assert "referenceSolution" not in json.dumps(body) and "a + b + c" not in json.dumps(body)


def _section(fmt: str, language: str) -> Section:
    return Section(start_s=0.0, end_s=600.0, title="t", format=fmt, language=language, concepts=["loops"],
                   qualifies=True, confidence="high", evidence=[])


def _slot(trigger: str) -> PauseSlot:
    return PauseSlot(section_index=0, pause_at_s=300.0, reveal_at_s=None, trigger=trigger, concept="loops",
                     idea="sum a list", importance=1)


@pytest.mark.parametrize("trigger", ["question_posed", "demonstration", "concept_complete"])
@pytest.mark.parametrize("fmt", ["code", "mixed"])
def test_code_and_mixed_sections_prefer_coding_for_every_trigger(fmt, trigger):
    assert planned_kind(_section(fmt, "python"), _slot(trigger)) == "coding"


@pytest.mark.parametrize("fmt,language", [("theory", "python"), ("code", "pseudocode"), ("mixed", "unknown")])
def test_theory_and_language_neutral_sections_apply_the_idea_in_code(fmt, language):
    # Theory = application: implement the idea (Python when no gradable language is shown).
    assert planned_kind(_section(fmt, language), _slot("concept_complete")) == "coding"


def test_ungradable_code_language_stays_concept():
    assert planned_kind(_section("code", "rust"), _slot("concept_complete")) == "concept"
