"""Failure feedback fixes: every structured-output schema is valid for the API, Python syntax errors
are labelled syntax_error, and diagnoses say what went wrong, why, and how to fix it (in words).
Offline: model and Judge0 are stubbed."""

from __future__ import annotations

import asyncio
import json

import pytest

from app.feedback.concepts import SHORT_ANSWER_SCHEMA, WRONG_ANSWER_SCHEMA
from app.feedback.diagnosis import DIAGNOSIS_SCHEMA, FailingCase, diagnose, static_diagnosis
from app.feedback.optimization import SUCCESS_SCHEMA
from app.feedback.refresher import REFRESHER_SCHEMA
from app.runners import get_runner


def _schemas() -> dict[str, dict]:
    from app.analysis import VERDICT_SCHEMA
    from app.hints import HINT_SCHEMA
    from app.planner.classify import WindowOut
    from app.planner.generate import QuestionOut
    from app.testme import GenOutput, strict_schema
    return {
        "diagnosis": DIAGNOSIS_SCHEMA, "success": SUCCESS_SCHEMA, "refresher": REFRESHER_SCHEMA,
        "short_answer": SHORT_ANSWER_SCHEMA, "wrong_answer": WRONG_ANSWER_SCHEMA, "hints": HINT_SCHEMA,
        "analysis": VERDICT_SCHEMA, "planner_window": strict_schema(WindowOut),
        "planner_question": strict_schema(QuestionOut), "coding_exercise": strict_schema(GenOutput),
    }


def _violations(node, path="$") -> list[str]:
    """Anthropic structured output: every object sets additionalProperties false and only requires
    properties it declares."""
    out: list[str] = []
    if isinstance(node, dict):
        if node.get("type") == "object":
            if node.get("additionalProperties") is not False:
                out.append(f"{path}: additionalProperties must be false")
            missing = set(node.get("required", [])) - set(node.get("properties", {}))
            if missing:
                out.append(f"{path}: requires undeclared {sorted(missing)}")
        for k, v in node.items():
            out += _violations(v, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            out += _violations(v, f"{path}[{i}]")
    return out


@pytest.mark.parametrize("name", list(_schemas()))
def test_every_structured_output_schema_is_valid(name):
    assert _violations(_schemas()[name]) == []


def test_the_original_bug_is_caught():
    bad = {"type": "object", "properties": {"lines": {"type": "array", "items": {"type": "object", "properties": {}}}},
           "additionalProperties": False}
    assert _violations(bad) == ["$.properties.lines.items: additionalProperties must be false"]


# --- Python syntax errors are syntax errors ------------------------------------------------------

PY_SYNTAX = '  File "/box/script.py", line 2\n    if n == 0\n             ^\nSyntaxError: expected \':\'\n'


@pytest.mark.parametrize("stderr,expected", [
    (PY_SYNTAX, "syntax_error"),
    ('  File "/box/script.py", line 3\n    return 0\n    ^\nIndentationError: expected an indented block\n', "syntax_error"),
    ('Traceback (most recent call last):\n  File "/box/script.py", line 9\nNameError: name \'x\' is not defined\n',
     "runtime_error"),
])
def test_python_runner_classifies_syntax_errors(stderr, expected):
    outcome, _, diag = get_runner("python")._parse_sandbox_output(
        {"status": {"id": 11}, "stdout": "", "stderr": stderr}, visible=True)
    assert outcome == expected and diag == stderr  # the real error text stays visible to the learner


# --- diagnosis content ---------------------------------------------------------------------------

CODE = "def sum_down(n):\n  if n == 0\n  return 0;\n  else;\n    return n + sum_down(n-1)\n"


def test_fallback_uses_the_real_error_and_line():
    d = static_diagnosis("syntax_error", FailingCase(args=[3], error=PY_SYNTAX), CODE, "python", "sum_down")
    assert d.summary == "Your code can't be read on line 2: SyntaxError: expected ':'"
    assert "How to fix it:" in d.misconception.explanation and "line 2" in d.misconception.explanation
    assert [(ln.line, ln.note) for ln in d.lines] == [(2, "The error points here: SyntaxError: expected ':'")]
    assert "possibly due to" not in d.misconception.explanation


def test_fallback_wrong_answer_names_the_failing_case():
    d = static_diagnosis("wrong_answer", FailingCase(args=[3], expected=6, actual=3), CODE, "python", "sum_down")
    assert d.summary == "For sum_down(3) your code gave 3, but 6 was expected."


def test_fallback_ignores_error_lines_outside_the_learners_code():
    err = "main.cpp:41:5: error: expected ';' before '}' token"
    d = static_diagnosis("syntax_error", FailingCase(error=err), "int f() { return 1 }\n", "cpp", "f")
    assert d.lines == [] and "error: expected ';'" in d.summary  # C++ wrapper shifts lines: no line claimed


AI_REPLY = {
    "misconceptionId": "python-block-syntax", "misconceptionName": "Python block syntax confusion",
    "whatWentWrong": "Python can't parse sum_down because the if and else headers are written C-style.",
    "why": "Python ends a block header with a colon and uses indentation for the body; semicolons end C-style statements.",
    "howToFix": "Put a colon at the end of the if and else lines and indent each body under its header.",
    "lines": [{"line": 2, "note": "Add a colon after the condition."},
              {"line": 4, "note": "Replace the semicolon after else with a colon."},
              {"line": 40, "note": "Out of range, must be dropped."}],
}


def test_ai_diagnosis_splits_what_why_and_how():
    seen = {}

    async def stub(prompt: str) -> str:
        seen["prompt"] = prompt
        return json.dumps(AI_REPLY)

    d, ai = asyncio.run(diagnose("Sum down", "Return n + ... + 0.", "python", CODE, "sum_down", "syntax_error",
                                 FailingCase(args=[3], error=PY_SYNTAX), ["recursion"], model_call=stub,
                                 learner_level="beginner-1"))
    assert ai and d.summary == AI_REPLY["whatWentWrong"]
    assert d.misconception.explanation == f"{AI_REPLY['why']} How to fix it: {AI_REPLY['howToFix']}"
    assert [ln.line for ln in d.lines] == [2, 4]
    assert "Learner level: beginner-1" in seen["prompt"] and "SyntaxError: expected ':'" in seen["prompt"]


def test_incomplete_ai_reply_falls_back():
    async def stub(prompt: str) -> str:
        return json.dumps({**AI_REPLY, "howToFix": ""})

    d, ai = asyncio.run(diagnose("t", "s", "python", CODE, "sum_down", "syntax_error",
                                 FailingCase(error=PY_SYNTAX), [], model_call=stub))
    assert not ai and d.summary.startswith("Your code can't be read on line 2")
