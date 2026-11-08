"""Graduated, documentation-grounded hints (RAG) and wrong-answer feedback.

Flow for POST /v1/hints:
1. Retrieve the official-doc chunks (backend/content/docs/*.json) most relevant to
   the exercise, the learner's code and their last failing result (BM25, offline).
2. Ask Claude for feedback on what went wrong and/or a hint at the requested level,
   grounded only in those chunks.
3. Guard the reply: it must never contain the reference solution or a full
   implementation. On any guard failure, provider error or missing key, fall back
   to a deterministic hint built from the retrieved docs.

Levels: 0 = feedback only (explain the failing case, no hint), 1 = a nudge toward the
concept, 2 = point at the specific tool (function/operator/pattern) and its doc,
3 = a step-by-step outline in plain words. Never code that solves the task.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import os
import re
import time
from collections import Counter, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal

from pydantic import BaseModel, Field

from .catalog import ApprovedExercise

logger = logging.getLogger("breakpoint.hints")

BACKEND_DIR = Path(__file__).resolve().parent.parent
DOCS_DIR = BACKEND_DIR / "content" / "docs"
DEFAULT_MODEL = "claude-opus-5-5"
MAX_LEVEL = 3
BUDGET_S = 15.0
MAX_OUTPUT_TOKENS = 4000
RATE_PER_MINUTE = 30
TOP_K = 3

# ---------------------------------------------------------------------------
# Retrieval
# ---------------------------------------------------------------------------

STOP = set(
    "a an the and or of to in on for is are be it its this that with as by at from your you "
    "return returns value values given write function which into than then if not use using "
    "should would each one two all any can".split()
)


def tokenize(text: str) -> list[str]:
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)
    words = re.findall(r"[A-Za-z]+|\*\*|//|%|==|<=|>=", text.replace("_", " ").lower())
    return [w for w in words if w not in STOP and len(w) > 1 or w in ("**", "//", "%", "==", "<=", ">=")]


@dataclass(frozen=True)
class DocChunk:
    id: str
    title: str
    url: str
    tags: tuple[str, ...]
    text: str
    nudge: str
    language: str = "python"

    @property
    def searchable(self) -> str:
        return " ".join([self.title, " ".join(self.tags) * 2, self.text])


class DocIndex:
    """Small BM25 index over curated official-documentation chunks."""

    def __init__(self, chunks: list[DocChunk]) -> None:
        self.chunks = chunks
        self.docs = [tokenize(c.searchable) for c in chunks]
        self.avg = sum(map(len, self.docs)) / max(1, len(self.docs))
        df: Counter[str] = Counter()
        for d in self.docs:
            df.update(set(d))
        n = len(self.docs)
        self.idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}
        self.tf = [Counter(d) for d in self.docs]

    @classmethod
    def load(cls, directory: Path = DOCS_DIR, language: str | None = None) -> "DocIndex":
        chunks: list[DocChunk] = []
        for path in sorted(directory.glob("*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            file_lang = data.get("language", path.stem)
            if language and file_lang != language:
                continue
            for c in data["chunks"]:
                chunks.append(DocChunk(c["id"], c["title"], c["url"], tuple(c["tags"]), c["text"], c["nudge"], language=file_lang))
        return cls(chunks)

    def search(self, query: str, k: int = TOP_K) -> list[DocChunk]:
        terms = tokenize(query)
        scores = []
        for i, tf in enumerate(self.tf):
            length = len(self.docs[i])
            s = 0.0
            for t in terms:
                f = tf.get(t)
                if f:
                    s += self.idf[t] * f * 2.2 / (f + 1.2 * (0.25 + 0.75 * length / self.avg))
            scores.append(s)
        ranked = sorted(range(len(self.chunks)), key=lambda i: -scores[i])
        return [self.chunks[i] for i in ranked[:k] if scores[i] > 0]


CALL_RE = re.compile(r"\b([A-Za-z_]\w*)\s*\(")
ERROR_RE = re.compile(r"\b([A-Z][a-zA-Z]+Error)\b")


def build_query(exercise: ApprovedExercise, code: str, last: "LastResult | None") -> str:
    parts = [exercise.title, exercise.statement, " ".join(exercise.conceptTags)]
    parts.append(" ".join(n for n in CALL_RE.findall(code) if n != exercise.functionName))
    for op in ("**", "//", "%", "+", "*"):
        if op in code:
            parts.append({"**": "power exponent", "//": "floor division", "%": "remainder modulo",
                          "+": "add", "*": "multiply"}[op])
    if last:
        parts.append(last.outcome.replace("_", " "))
        if last.diagnostic:
            parts.append(" ".join(ERROR_RE.findall(last.diagnostic)) + " " + last.diagnostic[:200])
    return " ".join(parts)


# ---------------------------------------------------------------------------
# Request / response
# ---------------------------------------------------------------------------


class LastResult(BaseModel):
    outcome: Literal["wrong_answer", "syntax_error", "runtime_error", "time_limit", "invalid_output"]
    args: list[Any] | None = None
    expected: Any = None
    actual: Any = None
    diagnostic: str | None = Field(default=None, max_length=4000)


class HintSource(BaseModel):
    title: str
    url: str


class HintResponse(BaseModel):
    level: int
    maxLevel: int = MAX_LEVEL
    feedback: str | None
    hint: str | None
    focus: str
    sources: list[HintSource]
    aiGenerated: bool


class HintOutput(BaseModel):
    """What the model returns (structured output)."""

    feedback: str
    hint: str
    focus: str
    docIds: list[str]


HINT_SCHEMA = {
    "type": "object",
    "properties": {
        "feedback": {"type": "string", "description": "What went wrong in the learner's last attempt, or '' if there is no failing attempt."},
        "hint": {"type": "string", "description": "The hint at the requested level, or '' for level 0."},
        "focus": {"type": "string", "description": "The concept the hint is about, 1-4 words."},
        "docIds": {"type": "array", "items": {"type": "string"}, "description": "ids of the doc chunks the hint relies on."},
    },
    "required": ["feedback", "hint", "focus", "docIds"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """You are Breakpoint's hint coach. A learner paused a coding tutorial to solve a short coding exercise and is stuck. Your job is to help them get unstuck while leaving the solving to them.

Rules that always apply:
- Never write the solution, the function body, or any code that would pass the tests. No code blocks. You may mention a single built-in name, operator or keyword inline (for example `range()` or `**`) when the level allows it.
- Ground every hint in the documentation excerpts provided, and list the ids you used in docIds. If none of the excerpts fit, give a general hint and return docIds as [].
- Be specific to this learner's code and failing case. Be kind, plain and short: feedback at most 2 sentences, hint at most 2 sentences (level 3: at most 4 short numbered steps in words).
- Feedback explains what their code did wrong on the failing case (for example "for (3, 2) your function returns 6 but 9 is expected, so it is adding up instead of multiplying"), without saying how to fix it in code.

Hint levels:
- 0: feedback only; set hint to "".
- 1: a gentle nudge toward the right idea or concept. Do not name the specific function or operator.
- 2: point to the specific tool (function, operator, method or pattern) and why it fits, citing the doc.
- 3: an outline of the approach as numbered steps in plain words. Still no code.
Previous hints are listed; do not repeat them, go one step further."""


ModelCall = Callable[[str], Awaitable[str]]


class HintError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = True) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


def build_user_prompt(exercise: ApprovedExercise, code: str, level: int, last: LastResult | None,
                      previous: list[str], docs: list[DocChunk]) -> str:
    examples = "\n".join(f"  {exercise.functionName}({', '.join(map(repr, e.args))}) -> {e.expected!r}"
                         for e in exercise.examples)
    excerpts = "\n".join(f"[{d.id}] {d.title} ({d.url}): {d.text}" for d in docs) or "(no excerpts matched)"
    attempt = "No attempt has been graded yet."
    if last:
        attempt = f"Last attempt outcome: {last.outcome}."
        if last.args is not None:
            attempt += f" Failing case: {exercise.functionName}({', '.join(map(repr, last.args))}) expected {last.expected!r}, got {last.actual!r}."
        if last.diagnostic:
            attempt += f"\nError output:\n{last.diagnostic[:1500]}"
    prev = "\n".join(f"- {p}" for p in previous) or "(none)"
    return (
        f"Exercise: {exercise.title}\n{exercise.statement}\nExamples:\n{examples}\n\n"
        f"Learner's current code:\n<code>\n{code[:8000]}\n</code>\n\n{attempt}\n\n"
        f"Previous hints already shown:\n{prev}\n\n"
        f"Requested hint level: {level}\n\nDocumentation excerpts:\n{excerpts}"
    )


def anthropic_model_call(model: str | None = None) -> ModelCall:
    """Real Claude call. Key from ANTHROPIC_API_KEY (backend/.env), never logged."""
    try:
        from dotenv import load_dotenv

        load_dotenv(BACKEND_DIR / ".env")
    except ImportError:  # pragma: no cover
        pass
    model_name = model or os.environ.get("ANTHROPIC_HINT_MODEL") or DEFAULT_MODEL
    client = None

    async def call(user_prompt: str) -> str:
        nonlocal client
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise HintError("HINTS_UNAVAILABLE", "ANTHROPIC_API_KEY is not set")
        import anthropic

        if client is None:
            client = anthropic.AsyncAnthropic(api_key=api_key, max_retries=1, timeout=BUDGET_S)
        try:
            resp = await client.beta.messages.create(
                model=model_name,
                max_tokens=MAX_OUTPUT_TOKENS,
                system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": user_prompt}],
                output_config={"effort": "low", "format": {"type": "json_schema", "schema": HINT_SCHEMA}},
                # Server-side fallback: if a safety classifier declines, retry on another model.
                betas=["server-side-fallback-2026-07-01"],
                extra_body={"fallbacks": "default"},
            )
        except anthropic.RateLimitError as exc:
            raise HintError("BUSY", "the hint coach is at its rate limit; try again shortly") from exc
        except anthropic.APIStatusError as exc:
            raise HintError("HINTS_UNAVAILABLE", f"Anthropic error {exc.status_code}") from exc
        except anthropic.APIConnectionError as exc:
            raise HintError("HINTS_UNAVAILABLE", "cannot reach Anthropic") from exc
        if resp.stop_reason in ("refusal", "max_tokens"):
            raise HintError("HINTS_UNAVAILABLE", f"model stopped: {resp.stop_reason}")
        text = "".join(b.text for b in resp.content if b.type == "text")
        if not text:
            raise HintError("HINTS_UNAVAILABLE", "empty response")
        return text

    return call


# ---------------------------------------------------------------------------
# Leak guard
# ---------------------------------------------------------------------------


def _norm(line: str) -> str:
    return re.sub(r"\s+", "", line)


def leaks_solution(text: str, exercise: ApprovedExercise) -> bool:
    """True when the text gives away code: a code block, a def/return line, or any
    non-trivial line of the reference solution."""
    if "```" in text or re.search(r"\bdef\s+\w+\s*\(", text) or re.search(r"(^|\n)\s*return\b", text):
        return True
    flat = _norm(text)
    for line in exercise.referenceSolution.splitlines():
        n = _norm(line)
        if len(n) >= 10 and not n.startswith("def") and n in flat:
            return True
    return False


def fallback_hint(level: int, docs: list[DocChunk], last: LastResult | None, exercise: ApprovedExercise) -> HintOutput:
    feedback = ""
    if last is not None:
        if last.args is not None and last.outcome == "wrong_answer":
            feedback = (f"For {exercise.functionName}({', '.join(map(repr, last.args))}) your code returned "
                        f"{last.actual!r}, but {last.expected!r} was expected.")
        elif last.outcome == "syntax_error":
            feedback = "Python couldn't read your code; check the line mentioned in the error for a typo, a missing colon or bad indentation."
        elif last.outcome == "runtime_error":
            err = ERROR_RE.search(last.diagnostic or "")
            feedback = f"Your code crashed{' with ' + err.group(1) if err else ''} while running a test."
        elif last.outcome == "time_limit":
            feedback = "Your code took too long; a loop may never finish."
    top = docs[0] if docs else None
    hint = ""
    if level >= 1 and top:
        hint = top.nudge if level == 1 else f"Look at {top.title}: {top.text.split('. ')[0]}."
        if level >= 3 and len(docs) > 1:
            hint += f" Then check {docs[1].title}."
    return HintOutput(feedback=feedback, hint=hint, focus=top.title if top else "the problem statement",
                      docIds=[d.id for d in docs[:2]] if level >= 2 else [])


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


@dataclass
class HintService:
    index: DocIndex = field(default_factory=DocIndex.load)
    model_call: ModelCall | None = None
    _cache: dict[str, HintResponse] = field(default_factory=dict)
    _calls: deque = field(default_factory=deque)
    _lang_indices: dict[str, DocIndex] = field(default_factory=dict)

    def _get_index(self, language: str | None = None) -> DocIndex:
        """Return a language-specific doc index, falling back to the default (all languages)."""
        if not language:
            return self.index
        if language not in self._lang_indices:
            idx = DocIndex.load(language=language)
            if not idx.chunks:
                # No docs for this language; fall back to default
                return self.index
            self._lang_indices[language] = idx
        return self._lang_indices[language]

    def _rate_ok(self) -> bool:
        now = time.monotonic()
        while self._calls and now - self._calls[0] > 60:
            self._calls.popleft()
        if len(self._calls) >= RATE_PER_MINUTE:
            return False
        self._calls.append(now)
        return True

    async def hint(self, exercise: ApprovedExercise, code: str, level: int, last: LastResult | None,
                   previous: list[str], language: str | None = None) -> HintResponse:
        level = max(0, min(MAX_LEVEL, level))
        key = hashlib.sha256(json.dumps([exercise.id, code, level, last.model_dump() if last else None, previous, language],
                                        sort_keys=True, default=str).encode()).hexdigest()
        if key in self._cache:
            return self._cache[key]
        index = self._get_index(language)
        docs = index.search(build_query(exercise, code, last))
        by_id = {d.id: d for d in docs}
        out: HintOutput | None = None
        ai = False
        if self._rate_ok():
            try:
                call = self.model_call or anthropic_model_call()
                text = await asyncio.wait_for(
                    call(build_user_prompt(exercise, code, level, last, previous, docs)), BUDGET_S + 1)
                out = HintOutput.model_validate_json(text)
                if leaks_solution(out.hint, exercise) or leaks_solution(out.feedback, exercise):
                    logger.info("hint for %s rejected by leak guard", exercise.id)
                    out = None
                else:
                    ai = True
            except (HintError, asyncio.TimeoutError, ValueError) as exc:
                logger.info("hint model unavailable for %s: %s", exercise.id, getattr(exc, "message", type(exc).__name__))
        if out is None:
            out = fallback_hint(level, docs, last, exercise)
        if level == 0:
            out.hint = ""
        if last is None:
            out.feedback = ""
        sources = [HintSource(title=by_id[i].title, url=by_id[i].url) for i in out.docIds if i in by_id]
        if level >= 2 and not sources and docs:
            sources = [HintSource(title=docs[0].title, url=docs[0].url)]
        resp = HintResponse(level=level, feedback=out.feedback or None, hint=out.hint or None,
                            focus=out.focus or "the problem", sources=sources, aiGenerated=ai)
        self._cache[key] = resp
        return resp


_service: HintService | None = None


def service() -> HintService:
    global _service
    if _service is None:
        _service = HintService()
    return _service
