"""H1: documentation-grounded graduated hints (offline; Claude is stubbed)."""

from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app import hints
from app.catalog import ApprovedExercise

CONTRACTS = Path(__file__).resolve().parent.parent.parent / "contracts"


def exercise() -> ApprovedExercise:
    rec = json.loads((CONTRACTS / "approved-record.fixture.json").read_text(encoding="utf-8"))
    return ApprovedExercise.model_validate(rec["breakpoints"][0]["exercise"])


def stub(payload: dict):
    calls: list[str] = []

    async def call(prompt: str) -> str:
        calls.append(prompt)
        return json.dumps(payload)

    call.calls = calls  # type: ignore[attr-defined]
    return call


def test_corpus_loads_and_retrieves_by_concept() -> None:
    idx = hints.DocIndex.load()
    assert len(idx.chunks) >= 30
    assert all(c.url.startswith("https://") for c in idx.chunks)
    top = [c.id for c in idx.search("raise a number to a power exponent repeated multiplication")]
    assert "power-operator" in top
    assert idx.search("convert input string to int ValueError")[0].id in ("int-function", "try-except")
    assert "dicts" in [c.id for c in idx.search("fast lookup hash map seen before")]


def test_query_uses_code_calls_and_error() -> None:
    q = hints.build_query(exercise(), "def raise_to_power(b, e):\n    return sum(range(e))",
                          hints.LastResult(outcome="runtime_error", diagnostic="TypeError: bad operand"))
    assert "sum" in q and "range" in q and "TypeError" in q and "raise_to_power" not in q.split(exercise().title)[-1].split()[:0]


def test_leak_guard_blocks_code_and_reference_lines() -> None:
    ex = exercise()
    assert hints.leaks_solution("```python\nx = 1\n```", ex)
    assert hints.leaks_solution("try: def raise_to_power(base, exponent):", ex)
    assert hints.leaks_solution("just write\n  return base * exponent", ex)
    assert hints.leaks_solution("use result *= base inside for _ in range(exponent):", ex)
    assert not hints.leaks_solution("Try repeating a multiplication; `range()` can control how many times.", ex)


def test_ai_hint_is_grounded_and_sources_resolved() -> None:
    model = stub({"feedback": "For (2, 3) you returned 6, which means you multiplied base by exponent once.",
                  "hint": "Raising to a power means multiplying base by itself several times.",
                  "focus": "repeated multiplication", "docIds": ["power-operator", "not-a-real-id"]})
    svc = hints.HintService(model_call=model)
    last = hints.LastResult(outcome="wrong_answer", args=[2, 3], expected=8, actual=6)
    r = asyncio.run(svc.hint(exercise(), "def raise_to_power(base, exponent):\n    return base * exponent", 2, last, []))
    assert r.aiGenerated and r.level == 2 and r.maxLevel == 3
    assert r.feedback and r.hint and r.focus == "repeated multiplication"
    assert [s.url for s in r.sources] == ["https://docs.python.org/3/reference/expressions.html#the-power-operator"]
    prompt = model.calls[0]
    assert "[power-operator]" in prompt and "expected 8, got 6" in prompt and "Requested hint level: 2" in prompt
    assert "result *= base" not in prompt  # the reference solution never goes to the model


def test_leaky_model_answer_falls_back_to_docs() -> None:
    svc = hints.HintService(model_call=stub({"feedback": "", "hint": "Just do:\n    return base ** exponent",
                                              "focus": "power", "docIds": []}))
    r = asyncio.run(svc.hint(exercise(), "def raise_to_power(base, exponent):\n    pass", 1, None, []))
    assert not r.aiGenerated
    assert r.hint and "return" not in r.hint and r.feedback is None


def test_level0_is_feedback_only_and_missing_key_falls_back(monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    # A developer's backend/.env must not put a real key back during the offline suite.
    import dotenv

    monkeypatch.setattr(dotenv, "load_dotenv", lambda *a, **k: False)
    svc = hints.HintService(model_call=hints.anthropic_model_call())
    last = hints.LastResult(outcome="wrong_answer", args=[3, 2], expected=9, actual=6)
    r = asyncio.run(svc.hint(exercise(), "def raise_to_power(base, exponent):\n    return base * exponent", 0, last, []))
    assert r.hint is None and not r.aiGenerated
    assert r.feedback and "9" in r.feedback and "6" in r.feedback


def test_responses_are_cached() -> None:
    model = stub({"feedback": "", "hint": "Think about repetition.", "focus": "loops", "docIds": []})
    svc = hints.HintService(model_call=model)
    for _ in range(2):
        asyncio.run(svc.hint(exercise(), "def raise_to_power(base, exponent):\n    pass", 1, None, []))
    assert len(model.calls) == 1


@pytest.fixture()
def client(tmp_path: Path):
    d = tmp_path / "approved"
    d.mkdir()
    shutil.copy(CONTRACTS / "approved-record.fixture.json", d / "samplevid01.json")
    svc = hints.HintService(model_call=stub({"feedback": "", "hint": "Repeat a multiplication.",
                                             "focus": "loops", "docIds": ["range"]}))
    with patch("app.catalog.APPROVED_DIR", d), patch("app.hints.service", lambda: svc):
        from app.main import app

        with TestClient(app) as c:
            yield c


def test_hint_endpoint(client: TestClient) -> None:
    body = {"exerciseId": "samplevid01-exponent", "revision": "demo-1", "code": "def raise_to_power(b, e):\n    pass", "level": 1}
    r = client.post("/v1/hints", json=body)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["hint"] == "Repeat a multiplication." and data["aiGenerated"] is True
    assert "referenceSolution" not in r.text and "hiddenTests" not in r.text
    assert client.post("/v1/hints", json={**body, "revision": "old"}).json()["error"]["code"] == "STALE_EXERCISE"
    assert client.post("/v1/hints", json={**body, "exerciseId": "nope"}).status_code == 404
    assert client.post("/v1/hints", json={**body, "level": 7}).status_code == 422
