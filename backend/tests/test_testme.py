"""Offline tests for app.testme with a stubbed Gemini and a stubbed Judge0 verify."""

from __future__ import annotations

import asyncio
import json

import pytest

from app.testme import (
    ExerciseGenerator,
    GenOutput,
    TestMeError,
    build_prompt,
    check_output,
    set_id_for,
)
from app.transcripts import Clip, Cue

VID = "AbCdEfGhIjK"


def _clip(last_start=600.0, ts=605.0) -> Clip:
    intro = Cue("c00001000", 1.0, 5.0, "functions return values")
    cues = (intro,) + tuple(
        Cue(f"c{int(s * 1000):08d}", s, s + 5, f"we use the plus operator {i}")
        for i, s in enumerate([last_start - 300 + 5 * k for k in range(61)])
    )
    return Clip(VID, "asr", "Learn Python", ts, cues[0].start_s, cues)


CLIP = _clip()


def _good(**over) -> dict:
    d = {
        "status": "ok",
        "language": "python",
        "languageEvidence": "def add(a, b): return a + b",
        "title": "Add three numbers",
        "statement": "Write add3(a, b, c) that returns the sum of the three numbers.",
        "functionName": "add3",
        "starterCode": "def add3(a, b, c):\n    pass\n",
        "referenceSolution": "def add3(a, b, c):\n    return a + b + c\n",
        "knownWrongSolution": "def add3(a, b, c):\n    return a + b\n",
        "examples": [{"argsJson": "[1, 2, 3]", "expectedJson": "6"}],
        "hiddenTests": [
            {"argsJson": "[0, 0, 0]", "expectedJson": "0"},
            {"argsJson": "[-1, 1, 5]", "expectedJson": "5"},
            {"argsJson": "[10, 20, 30]", "expectedJson": "60"},
        ],
        "wrongMistake": "forgets c",
        "wrongFailsOnArgsJson": "[-1, 1, 5]",
        "conceptTags": ["arithmetic", "functions", "made-up"],
        "conceptEvidenceCueIds": ["c00001000"],
    }
    d.update(over)
    return d


class StubModel:
    def __init__(self, *answers, delay=0.0, exc=None):
        self.answers = list(answers)
        self.prompts: list[str] = []
        self.delay = delay
        self.exc = exc

    async def __call__(self, prompt: str) -> str:
        self.prompts.append(prompt)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.exc:
            raise self.exc
        a = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        return a if isinstance(a, str) else json.dumps(a)


def ok_verify(results=None):
    seen = []

    async def verify(ex):
        seen.append(ex)
        return results.pop(0) if results else True

    verify.seen = seen  # type: ignore[attr-defined]
    return verify


def run(coro):
    return asyncio.run(coro)


def gen(model, **kw) -> ExerciseGenerator:
    return ExerciseGenerator(model_call=model, model_name="stub", **kw)


# ---------------------------------------------------------------------------
# Happy path + public shape
# ---------------------------------------------------------------------------


def test_generates_checked_set_and_public_shape_hides_private_data():
    model = StubModel(_good())
    verify = ok_verify()
    s = run(gen(model).generate(CLIP, verify))
    assert s.set_id == set_id_for(VID, CLIP.last_cue_id) and s.set_id.startswith("tm-")
    assert s.exercise.id == f"{s.set_id}-1"
    assert s.exercise.functionName == "add3" and s.concept_tags == ("arithmetic", "functions")
    assert len(s.exercise.examples) == 1 and len(s.exercise.hiddenTests) == 3
    assert verify.seen == [s.exercise]

    pub = s.public_response()
    assert pub["generated"] is True and pub["aiGenerated"] is True and pub["setId"] == s.set_id
    assert pub["revision"] == s.set_id and pub["status"] == "ready" and pub["videoId"] == VID
    bp = pub["breakpoints"][0]
    assert bp["pauseAtS"] == CLIP.timestamp_s
    text = json.dumps(pub)
    for secret in ("return a + b + c", "return a + b\\n", "hiddenTests", "functionName", "[10, 20, 30]", "[-1, 1, 5]"):
        assert secret not in text
    assert set(bp["exercise"]) == {"id", "title", "statement", "language", "starterCode", "examples"}


def test_prompt_contains_cue_ids_title_and_rules():
    p = build_prompt(CLIP)
    assert f"[{CLIP.cues[0].id}]" in p and "Learn Python" in p and "notPython" in p
    assert "rejected" not in p
    assert "rejected: x" in build_prompt(CLIP, "x")


def test_to_record_is_gradeable_shape():
    s = run(gen(StubModel(_good())).generate(CLIP, ok_verify()))
    rec = s.to_record()
    assert rec.revision == s.set_id and rec.breakpoints[0].exercise is s.exercise


# ---------------------------------------------------------------------------
# Rule and concept checks
# ---------------------------------------------------------------------------

BAD = [
    {"functionName": "add 3"},
    {"functionName": "_hidden"},
    {"title": ""},
    {"title": "x" * 81},
    {"statement": "s" * 601},
    {"referenceSolution": "def add3(a, b, c)\n    return a"},
    {"knownWrongSolution": "def other(a, b, c):\n    return 0\n"},
    {"starterCode": ""},
    {"knownWrongSolution": "def add3(a, b, c):\n    return a + b + c\n"},
    {"starterCode": "def add3(a, b, c):\n    return a + b + c\n"},
    {"referenceSolution": "import os\ndef add3(a, b, c):\n    return a + b + c\n"},
    {"referenceSolution": "def add3(a, b, c):\n    return int(input())\n"},
    {"referenceSolution": "def add3(a, b, c):\n    return eval('a+b+c')\n"},
    {"referenceSolution": "def add3(a, b, c):\n    return a+b+c\n" + "#" * 5000},
    {"examples": []},
    {"examples": [{"argsJson": f"[{i}, 0, 0]", "expectedJson": str(i)} for i in range(3)]},
    {"hiddenTests": [{"argsJson": "[0, 0, 0]", "expectedJson": "0"}]},
    {"hiddenTests": [{"argsJson": f"[{i}, 1, 1]", "expectedJson": str(i + 2)} for i in range(9)]},
    {"examples": [{"argsJson": "1, 2, 3", "expectedJson": "6"}]},
    {"examples": [{"argsJson": "[1.5, 2, 3]", "expectedJson": "6.5"}]},
    {"examples": [{"argsJson": "[[1], 2, 3]", "expectedJson": "6"}]},
    {"examples": [{"argsJson": "[1, 2, 3]", "expectedJson": "{\"a\": 1}"}]},
    {"examples": [{"argsJson": json.dumps(["x" * 201, 1, 1]), "expectedJson": "1"}]},
    {"examples": [{"argsJson": "[1, 2]", "expectedJson": "3"}]},
    {"examples": [{"argsJson": "[0, 0, 0]", "expectedJson": "0"}]},
    {"conceptTags": ["made-up"]},
    {"conceptEvidenceCueIds": []},
    {"conceptEvidenceCueIds": ["c99999999"]},
    {"status": "maybe"},
]


@pytest.mark.parametrize("over", BAD)
def test_rule_and_concept_checks_reject(over):
    from app.testme import _CheckFailed

    with pytest.raises(_CheckFailed):
        check_output(GenOutput.model_validate(_good(**over)), CLIP, "tm-x-1")


@pytest.mark.parametrize("fails_on", ["[1, 2, 3]", "nope"])
def test_wrong_fails_on_pointer_is_only_a_hint(fails_on):
    # An off pointer must not reject the exercise; Judge0 verify enforces the rule.
    ex, _ = check_output(GenOutput.model_validate(_good(wrongFailsOnArgsJson=fails_on)), CLIP, "tm-x-1")
    assert ex.knownWrongSolution


def test_bool_and_string_values_are_allowed():
    over = {
        "examples": [{"argsJson": '["abc", true, null]', "expectedJson": '"cba"'}],
        "hiddenTests": [
            {"argsJson": '["", false, null]', "expectedJson": '""'},
            {"argsJson": '["a", true, 1]', "expectedJson": "true"},
            {"argsJson": '["ab", true, 2]', "expectedJson": "null"},
        ],
        "wrongFailsOnArgsJson": '["a", true, 1]',
    }
    ex, _ = check_output(GenOutput.model_validate(_good(**over)), CLIP, "tm-x-1")
    assert ex.examples[0].args == ["abc", True, None]
    assert ex.hiddenTests[1].expected is True


@pytest.mark.parametrize("over", [{"status": "notPython"}, {"language": "javascript"}])
def test_not_python(over):
    with pytest.raises(TestMeError) as e:
        run(gen(StubModel(_good(**over))).generate(CLIP, ok_verify()))
    assert e.value.code == "NOT_PYTHON" and not e.value.retryable


def test_no_exercise_is_generator_unavailable_without_retry():
    model = StubModel(_good(status="noExercise"))
    with pytest.raises(TestMeError) as e:
        run(gen(model).generate(CLIP, ok_verify()))
    assert e.value.code == "GENERATOR_UNAVAILABLE" and len(model.prompts) == 1


# ---------------------------------------------------------------------------
# Retry, verify, provider failures, timeout
# ---------------------------------------------------------------------------


def test_one_retry_with_feedback_then_success():
    model = StubModel(_good(functionName="add 3"), _good())
    s = run(gen(model).generate(CLIP, ok_verify()))
    assert len(model.prompts) == 2 and "rejected" in model.prompts[1]
    assert s.exercise.functionName == "add3"


def test_invalid_json_then_invalid_again_gives_unavailable():
    model = StubModel("not json", {"status": "ok"})
    with pytest.raises(TestMeError) as e:
        run(gen(model).generate(CLIP, ok_verify()))
    assert e.value.code == "GENERATOR_UNAVAILABLE" and e.value.retryable and len(model.prompts) == 2


def test_verify_failure_retries_then_succeeds_and_failed_set_not_served():
    verify = ok_verify([False, True])
    model = StubModel(_good())
    s = run(gen(model).generate(CLIP, verify))
    assert len(verify.seen) == 2 and len(model.prompts) == 2 and "sandbox" in model.prompts[1]
    assert s is not None


def test_verify_failing_twice_is_unavailable_and_not_cached():
    g = gen(StubModel(_good()))
    with pytest.raises(TestMeError) as e:
        run(g.generate(CLIP, ok_verify([False, False])))
    assert e.value.code == "GENERATOR_UNAVAILABLE"
    assert g.get_set(set_id_for(VID, CLIP.last_cue_id)) is None


def test_no_retry_when_budget_is_low():
    model = StubModel(_good(functionName="bad name"), _good())
    with pytest.raises(TestMeError):
        run(gen(model, retry_min_remaining_s=1000).generate(CLIP, ok_verify()))
    assert len(model.prompts) == 1


def test_verify_exception_propagates_for_endpoint_mapping():
    class Unavailable(Exception):
        pass

    async def verify(ex):
        raise Unavailable("judge0 down")

    with pytest.raises(Unavailable):
        run(gen(StubModel(_good())).generate(CLIP, verify))


def test_provider_error_is_generator_unavailable():
    model = StubModel(exc=TestMeError("GENERATOR_UNAVAILABLE", "Gemini call failed", True))
    with pytest.raises(TestMeError) as e:
        run(gen(model).generate(CLIP, ok_verify()))
    assert e.value.code == "GENERATOR_UNAVAILABLE"


def test_timeout():
    model = StubModel(_good(), delay=0.5)
    with pytest.raises(TestMeError) as e:
        run(gen(model, budget_s=0.05).generate(CLIP, ok_verify()))
    assert e.value.code == "GENERATOR_TIMEOUT" and e.value.retryable


def test_provider_quota_is_busy(monkeypatch):
    import types as pytypes

    from app import testme

    class QuotaError(Exception):
        code = 429

    class Models:
        async def generate_content(self, **kw):
            raise QuotaError("429 RESOURCE_EXHAUSTED")

    class Client:
        def __init__(self, api_key):
            self.aio = pytypes.SimpleNamespace(models=Models())

    import google.genai as real

    monkeypatch.setattr(real, "Client", Client)
    monkeypatch.setenv("GEMINI_API_KEY", "test-only")
    with pytest.raises(TestMeError) as e:
        run(testme.gemini_model_call("gemini-2.5-flash")("prompt"))
    assert e.value.code == "BUSY" and e.value.retryable
    assert "test-only" not in e.value.message


def _fake_genai(monkeypatch, outcomes):
    """Patch genai.Client; each generate_content pops the next outcome (exception or text)."""
    import types as pytypes

    calls = []

    class Models:
        async def generate_content(self, **kw):
            calls.append(kw)
            o = outcomes.pop(0)
            if isinstance(o, BaseException):
                raise o
            return pytypes.SimpleNamespace(text=o)

    class Client:
        def __init__(self, api_key):
            self.aio = pytypes.SimpleNamespace(models=Models())

    import google.genai as real

    monkeypatch.setattr(real, "Client", Client)
    monkeypatch.setenv("GEMINI_API_KEY", "test-only")
    return calls


class _Overloaded(Exception):
    code = 503


def test_server_error_retries_once_then_succeeds(monkeypatch):
    from app import testme

    monkeypatch.setattr(testme, "SERVER_RETRY_BACKOFF_S", 0)
    calls = _fake_genai(monkeypatch, [_Overloaded("503 UNAVAILABLE"), '{"ok": 1}'])
    assert run(testme.gemini_model_call("gemini-2.5-flash")("prompt")) == '{"ok": 1}'
    assert len(calls) == 2


def test_server_error_twice_is_unavailable(monkeypatch):
    from app import testme

    monkeypatch.setattr(testme, "SERVER_RETRY_BACKOFF_S", 0)
    calls = _fake_genai(monkeypatch, [_Overloaded("503"), _Overloaded("503")])
    with pytest.raises(TestMeError) as e:
        run(testme.gemini_model_call("gemini-2.5-flash")("prompt"))
    assert e.value.code == "GENERATOR_UNAVAILABLE" and e.value.retryable
    assert len(calls) == 2


def test_slow_server_error_is_not_retried(monkeypatch):
    from app import testme

    monkeypatch.setattr(testme, "SERVER_RETRY_MAX_ELAPSED_S", -1)
    calls = _fake_genai(monkeypatch, [_Overloaded("503"), '{"ok": 1}'])
    with pytest.raises(TestMeError) as e:
        run(testme.gemini_model_call("gemini-2.5-flash")("prompt"))
    assert e.value.code == "GENERATOR_UNAVAILABLE"
    assert len(calls) == 1


def test_missing_key_is_unavailable(monkeypatch):
    from app import testme

    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: False)
    call = testme.gemini_model_call("stub")
    with pytest.raises(TestMeError) as e:
        run(call("prompt"))
    assert e.value.code == "GENERATOR_UNAVAILABLE"


# ---------------------------------------------------------------------------
# Cache, expiry, rate limit
# ---------------------------------------------------------------------------


def test_cache_hit_skips_model_and_rate_limit():
    model = StubModel(_good())
    g = gen(model, rate_limit=1)
    a = run(g.generate(CLIP, ok_verify()))
    b = run(g.generate(CLIP, ok_verify()))
    assert a is b and len(model.prompts) == 1
    assert g.find_exercise(a.exercise.id) is a
    assert g.find_exercise("exponent-1") is None


def test_concurrent_same_moment_shares_one_generation():
    model = StubModel(_good(), delay=0.05)
    g = gen(model)

    async def both():
        return await asyncio.gather(g.generate(CLIP, ok_verify()), g.generate(CLIP, ok_verify()))

    a, b = run(both())
    assert a is b and len(model.prompts) == 1


def test_set_expires_after_ttl():
    now = [100.0]
    g = gen(StubModel(_good()), clock=lambda: now[0])
    s = run(g.generate(CLIP, ok_verify()))
    now[0] += 1799
    assert g.get_set(s.set_id) is s
    now[0] += 2
    assert g.get_set(s.set_id) is None and g.find_exercise(s.exercise.id) is None


def test_rate_limit_ten_per_minute():
    now = [0.0]
    g = gen(StubModel(_good()), clock=lambda: now[0])
    for i in range(10):
        run(g.generate(_clip(last_start=600.0 + i * 5), ok_verify()))
    with pytest.raises(TestMeError) as e:
        run(g.generate(_clip(last_start=900.0), ok_verify()))
    assert e.value.code == "BUSY" and e.value.retryable
    now[0] = 60.5
    run(g.generate(_clip(last_start=900.0), ok_verify()))


def test_module_generate_adapts_endpoint_verify(monkeypatch):
    from app import testme

    monkeypatch.setattr(testme, "_default", gen(StubModel(_good())))
    calls = []

    async def endpoint_verify(fn, ref, wrong, cases):
        calls.append((fn, ref, wrong, cases))
        return True

    s = run(testme.generate(CLIP, endpoint_verify))
    fn, ref, wrong, cases = calls[0]
    assert fn == "add3" and "a + b + c" in ref and "a + b\n" in wrong
    assert cases[0] == {"args": [1, 2, 3], "expected": 6} and len(cases) == 4
    assert testme.get_set(s.set_id) is s


def test_different_moments_get_different_sets():
    assert set_id_for(VID, "c00001000") != set_id_for(VID, "c00002000")
    assert set_id_for(VID, "c00001000") != set_id_for("ZZZZZZZZZZZ", "c00001000")
