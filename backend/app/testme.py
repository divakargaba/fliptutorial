""""Test me" exercise generator (docs/TEST-ME.md, T2).

``ExerciseGenerator.generate(clip, verify)`` turns a transcript clip (from
``app.transcripts.clip``) into one checked coding exercise:

1. cache lookup (videoId + last cue id + prompt version; 30 min TTL) — free;
2. rate limit: 10 new sets per rolling 60 s, else ``BUSY``;
3. Anthropic structured output (or an injected ``model_call`` in tests);
4. rule and concept checks (code is only ``compile()``d, never run here);
5. ``verify(exercise)`` — the Judge0 check (T3): reference passes every case and
   the known-wrong solution fails at least one;
6. one retry on a failed check if enough budget remains.

The whole call is bounded by ``budget_s`` (18 s, under the extension's 20 s).
Errors are ``TestMeError`` with codes ``NOT_PYTHON``, ``GENERATOR_UNAVAILABLE``,
``GENERATOR_TIMEOUT`` and ``BUSY``. Prompts, solutions and hidden tests are never
logged.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from pydantic import BaseModel, Field, ValidationError

from .catalog import (
    ApprovedBreakpoint,
    ApprovedExercise,
    ApprovedRecord,
    Example,
    HiddenTest,
    PracticeResponse,
    build_public_response,
)
from .transcripts import Clip

logger = logging.getLogger("breakpoint.testme")

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROMPT_VERSION = "tm2"
# Test me runs on Haiku for latency headroom under BUDGET_S; ANTHROPIC_TESTME_MODEL
# overrides it. ANTHROPIC_MODEL (prep scan, Sonnet) does not apply here.
DEFAULT_MODEL = "claude-haiku-5-5"
MAX_OUTPUT_TOKENS = 4096

BUDGET_S = 18.0
# Retry a rejected set only if the first attempt was quick; otherwise fail fast
# (GENERATOR_UNAVAILABLE ~10 s) instead of timing out at BUDGET_S.
RETRY_MIN_REMAINING_S = 13.0
# One retry on an Anthropic 5xx (e.g. 529 overloaded), only when the failed call
# came back fast enough that a second call can still fit in BUDGET_S.
SERVER_RETRY_MAX_ELAPSED_S = 6.0
SERVER_RETRY_BACKOFF_S = 0.5
SET_TTL_S = 1800.0
MAX_CACHED_SETS = 256
RATE_LIMIT = 10
RATE_WINDOW_S = 60.0

CONCEPT_TAGS = (
    "arithmetic", "loops", "conditionals", "functions", "arrays", "strings",
    "binary-search", "hash-map", "two-pointers", "recursion", "sorting",
)
MAX_CODE_CHARS = 4096
MAX_TITLE = 80
MAX_STATEMENT = 600
MAX_STR_VALUE = 200
FORBIDDEN = re.compile(
    r"\binput\s*\(|\bopen\s*\(|\beval\s*\(|\bexec\s*\(|__import__|"
    r"^\s*(?:import|from)\s+(?:os|sys|subprocess|socket|shutil|pathlib|ctypes)\b",
    re.M,
)


class TestMeError(Exception):
    __test__ = False  # not a pytest class

    def __init__(self, code: str, message: str, retryable: bool = False) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.retryable = retryable


class _CheckFailed(Exception):
    """A generated exercise failed a rule/concept/verify check (retryable once)."""


# ---------------------------------------------------------------------------
# Structured output schema (plain types; sent via strict_schema)
# ---------------------------------------------------------------------------


class GenCase(BaseModel):
    argsJson: str = Field(
        description='Always a JSON array with one element per parameter, even for one '
        'argument: f(2, 3) -> "[2, 3]", f(5) -> "[5]", f("abc") -> "[\\"abc\\"]"'
    )
    expectedJson: str = Field(description='JSON return value, e.g. "5" or "\\"abc\\""')


class GenOutput(BaseModel):
    status: str = Field(description='"ok", "notPython" or "noExercise"')
    language: str
    languageEvidence: str
    title: str
    statement: str
    functionName: str
    starterCode: str
    referenceSolution: str
    examples: list[GenCase]
    hiddenTests: list[GenCase]
    wrongMistake: str = Field(description="the logic mistake the wrong solution makes (not a syntax error)")
    wrongFailsOnArgsJson: str = Field(description="argsJson of a hidden test the wrong solution gets wrong")
    knownWrongSolution: str
    conceptTags: list[str]
    conceptEvidenceCueIds: list[str]


ModelCall = Callable[[str], Awaitable[str]]
"""Takes the prompt, returns the model's raw JSON text."""

Verify = Callable[[ApprovedExercise], Awaitable[bool]]
"""Judge0 check: True iff reference passes all cases and wrong fails >= 1."""


def build_prompt(clip: Clip, feedback: str | None = None) -> str:
    lines = "\n".join(f"[{c.id}] ({c.start_s:.1f}s) {c.text}" for c in clip.cues)
    retry = f"\nYour previous answer was rejected: {feedback}. Fix that.\n" if feedback else ""
    return (
        "You write one short practice exercise for a learner watching a programming "
        "tutorial. The learner paused the video; below is everything the instructor "
        "said recently, up to the pause.\n"
        f"Video title: {clip.title}\n"
        "Rules:\n"
        "- If the tutorial is not teaching Python code, return status \"notPython\".\n"
        "- If nothing codeable has been taught yet, return status \"noExercise\".\n"
        "- Otherwise status \"ok\": one self-contained beginner Python function that "
        "practises a concept the instructor already taught in this excerpt, using only "
        "what was taught so far. Do not copy the instructor's exact example.\n"
        "- functionName is a Python identifier. starterCode is just the def line with "
        "parameters and a `pass` body. referenceSolution is correct. knownWrongSolution "
        "is valid, runnable Python with a plausible beginner logic mistake (off-by-one, "
        "wrong operator, missed edge case): never a syntax error. It defines the same "
        "function, returns the same type, and fails at least one hidden test. Describe "
        "the mistake in wrongMistake and copy the argsJson of a hidden test it gets "
        "wrong into wrongFailsOnArgsJson; check that its return value there really "
        "differs from expectedJson.\n"
        "- The function returns a value (no print, no input, no files, no imports).\n"
        "- 1 or 2 examples (shown to the learner) and 3 to 5 hiddenTests covering edge "
        "cases; inputs must all differ. argsJson is ALWAYS a JSON array in square "
        "brackets with exactly one element per function parameter, even when there is "
        "only one: f(5) is \"[5]\", f(\"abc\") is \"[\\\"abc\\\"]\", f(2, 3) is \"[2, 3]\"; "
        "never a bare value like \"5\" or \"\\\"abc\\\"\". wrongFailsOnArgsJson uses the "
        "same array form. expectedJson is a single JSON value; use only integers, "
        "strings, booleans or null (no floats, lists or dicts).\n"
        f"- title <= {MAX_TITLE} chars; statement <= {MAX_STATEMENT} chars, plain text "
        "that names the function and says what it returns.\n"
        f"- conceptTags from: {', '.join(CONCEPT_TAGS)}.\n"
        "- conceptEvidenceCueIds: ids (copied exactly from the brackets) of the cues "
        "where the instructor teaches the concept.\n"
        "- language: the language being taught; languageEvidence: the code syntax or "
        "words that show it.\n"
        f"{retry}\n{lines}\n"
    )


def strict_schema(model: type[BaseModel]) -> dict:
    """Pydantic JSON schema with $refs inlined, every property required and no
    extra properties: the shape Anthropic structured output expects."""
    root = model.model_json_schema()
    defs = root.pop("$defs", {})

    def fix(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                return fix(defs[node["$ref"].rsplit("/", 1)[-1]])
            node = {
                k: ({p: fix(s) for p, s in v.items()} if k == "properties" else fix(v))
                for k, v in node.items()
                if k not in ("title", "default")
            }
            if node.get("type") == "object":
                node["required"] = list(node.get("properties", {}))
                node["additionalProperties"] = False
            return node
        if isinstance(node, list):
            return [fix(v) for v in node]
        return node

    return fix(root)


def _is_server_error(exc: BaseException) -> bool:
    status = getattr(exc, "status_code", None)
    return isinstance(status, int) and 500 <= status < 600


def resolve_model() -> str:
    return os.environ.get("ANTHROPIC_TESTME_MODEL") or DEFAULT_MODEL


def anthropic_model_call(model: str | None = None) -> ModelCall:
    """Real model call via the Anthropic SDK; key read from env / backend/.env only."""
    try:
        from dotenv import load_dotenv

        load_dotenv(BACKEND_DIR / ".env")
    except ImportError:  # pragma: no cover
        pass
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    model_name = model or resolve_model()
    schema = strict_schema(GenOutput)
    client = None

    async def call(prompt: str) -> str:
        nonlocal client
        if not api_key:
            raise TestMeError("GENERATOR_UNAVAILABLE", "ANTHROPIC_API_KEY is not set", True)
        try:
            import anthropic

            if client is None:
                # The SDK's own retries would blow the 18 s budget; we retry once below.
                client = anthropic.AsyncAnthropic(api_key=api_key, max_retries=0, timeout=BUDGET_S)

            async def once():
                return await client.messages.create(
                    model=model_name,
                    max_tokens=MAX_OUTPUT_TOKENS,
                    messages=[{"role": "user", "content": prompt}],
                    output_config={"format": {"type": "json_schema", "schema": schema}},
                )

            t0 = time.monotonic()
            try:
                resp = await once()
            except Exception as exc:
                if not _is_server_error(exc) or time.monotonic() - t0 > SERVER_RETRY_MAX_ELAPSED_S:
                    raise
                logger.info("testme anthropic %s; retrying once", getattr(exc, "status_code", type(exc).__name__))
                await asyncio.sleep(SERVER_RETRY_BACKOFF_S)
                resp = await once()
            text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text")
            if getattr(resp, "stop_reason", None) == "max_tokens":
                raise TestMeError("GENERATOR_UNAVAILABLE", "the model's answer was cut off", True)
        except TestMeError:
            raise
        except Exception as exc:
            if getattr(exc, "status_code", None) == 429:
                raise TestMeError("BUSY", "the exercise generator is at its rate limit; try again in a minute", True) from exc
            raise TestMeError("GENERATOR_UNAVAILABLE", f"Anthropic call failed: {type(exc).__name__}", True) from exc
        if not text:
            raise TestMeError("GENERATOR_UNAVAILABLE", "Anthropic returned an empty response", True)
        return text

    return call


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------


def _scalar_ok(v: Any) -> bool:
    if v is None or isinstance(v, bool) or isinstance(v, int):
        return True
    return isinstance(v, str) and len(v) <= MAX_STR_VALUE


def _parse_case(case: GenCase, label: str) -> tuple[list, Any]:
    try:
        args = json.loads(case.argsJson)
        expected = json.loads(case.expectedJson)
    except json.JSONDecodeError as exc:
        raise _CheckFailed(f"{label} is not valid JSON") from exc
    if not isinstance(args, list) or not all(_scalar_ok(a) for a in args):
        raise _CheckFailed(f"{label} args must be a JSON array of int/str/bool/null")
    if not _scalar_ok(expected):
        raise _CheckFailed(f"{label} expected must be int/str/bool/null")
    return args, expected


def check_output(out: GenOutput, clip: Clip, exercise_id: str) -> tuple[ApprovedExercise, list[str]]:
    """Validate model output; return the private exercise and concept tags.

    Raises TestMeError(NOT_PYTHON / GENERATOR_UNAVAILABLE) for terminal answers
    and _CheckFailed for rule violations worth one retry.
    """
    status = out.status.strip().lower()
    if status == "notpython" or (status == "ok" and out.language.strip().lower() != "python"):
        raise TestMeError("NOT_PYTHON", "this part of the video is not teaching Python")
    if status == "noexercise":
        raise TestMeError("GENERATOR_UNAVAILABLE", "no exercise fits this part of the video yet", True)
    if status != "ok":
        raise _CheckFailed(f"unknown status {out.status!r}")

    fn = out.functionName.strip()
    if not fn.isidentifier() or fn.startswith("_"):
        raise _CheckFailed("functionName is not a plain Python identifier")
    title, statement = out.title.strip(), out.statement.strip()
    if not title or len(title) > MAX_TITLE:
        raise _CheckFailed(f"title must be 1-{MAX_TITLE} chars")
    if not statement or len(statement) > MAX_STATEMENT:
        raise _CheckFailed(f"statement must be 1-{MAX_STATEMENT} chars")

    codes = {
        "starterCode": out.starterCode,
        "referenceSolution": out.referenceSolution,
        "knownWrongSolution": out.knownWrongSolution,
    }
    for label, code in codes.items():
        if not code.strip() or len(code) > MAX_CODE_CHARS:
            raise _CheckFailed(f"{label} is empty or longer than {MAX_CODE_CHARS} chars")
        try:
            compile(code, label, "exec")  # syntax check only; never executed here
        except (SyntaxError, ValueError) as exc:
            raise _CheckFailed(f"{label} does not compile") from exc
        if not re.search(rf"^def {re.escape(fn)}\s*\(", code, re.M):
            raise _CheckFailed(f"{label} does not define {fn}()")
        if label != "starterCode" and FORBIDDEN.search(code):
            raise _CheckFailed(f"{label} uses input/files/eval/exec or a forbidden import")
    norm = {k: "\n".join(l.rstrip() for l in v.strip().splitlines()) for k, v in codes.items()}
    if len(set(norm.values())) < 3:
        raise _CheckFailed("starter, reference and wrong solutions must all differ")

    if not 1 <= len(out.examples) <= 2:
        raise _CheckFailed("use one or two examples")
    if not 3 <= len(out.hiddenTests) <= 8:
        raise _CheckFailed("use three to eight hidden tests")
    examples = [_parse_case(c, f"example {i}") for i, c in enumerate(out.examples)]
    hidden = [_parse_case(c, f"hidden test {i}") for i, c in enumerate(out.hiddenTests)]
    arities = {len(a) for a, _ in examples + hidden}
    if len(arities) != 1:
        raise _CheckFailed("every case must pass the same number of arguments")
    seen = [json.dumps(a) for a, _ in examples + hidden]
    if len(set(seen)) != len(seen):
        raise _CheckFailed("test inputs must all differ")
    try:
        fails_on = json.dumps(json.loads(out.wrongFailsOnArgsJson))
    except json.JSONDecodeError:
        fails_on = None
    if fails_on not in {json.dumps(a) for a, _ in hidden}:
        # Only a hint: the Judge0 verify step is what proves the wrong solution
        # fails a test. Rejecting here forced a second model call that pushed
        # live requests past the time budget.
        logger.info("testme %s: wrongFailsOnArgsJson names no hidden test; relying on verify", exercise_id)

    tags = [t for t in out.conceptTags if t in CONCEPT_TAGS]
    if not tags:
        raise _CheckFailed(f"conceptTags must include one of {', '.join(CONCEPT_TAGS)}")
    clip_ids = {c.id for c in clip.cues}
    evidence = out.conceptEvidenceCueIds
    if not evidence or any(e not in clip_ids for e in evidence):
        raise _CheckFailed("conceptEvidenceCueIds must be cue ids from the excerpt")

    exercise = ApprovedExercise(
        id=exercise_id,
        title=title,
        statement=statement,
        language="python",
        functionName=fn,
        starterCode=out.starterCode.rstrip() + "\n",
        conceptTags=tags,
        examples=[Example(args=a, expected=e) for a, e in examples],
        hiddenTests=[HiddenTest(args=a, expected=e) for a, e in hidden],
        referenceSolution=out.referenceSolution.rstrip() + "\n",
        knownWrongSolution=out.knownWrongSolution.rstrip() + "\n",
    )
    return exercise, tags


# ---------------------------------------------------------------------------
# Generated set + generator
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GeneratedSet:
    set_id: str
    video_id: str
    timestamp_s: float
    exercise: ApprovedExercise
    concept_tags: tuple[str, ...]
    model: str
    created_at: float
    expires_at: float
    ai_generated: bool = True

    def to_record(self) -> ApprovedRecord:
        """A private one-breakpoint record so catalog/grader code can reuse it.

        ``revision`` is the setId; the breakpoint pauses/reveals at the moment
        the learner pressed Test me.
        """
        t = self.timestamp_s
        bp = ApprovedBreakpoint(
            id=f"{self.set_id}-bp1",
            windowStartS=t, setupEndS=t, firstSpokenRevealS=None, firstVisualRevealS=None,
            revealAtS=t, pauseAtS=t, windowEndS=t,
            exercise=self.exercise,
        )
        return ApprovedRecord(
            videoId=self.video_id, revision=self.set_id,
            approvedDigest=self.set_id.removeprefix("tm-"), breakpoints=[bp],
        )

    def public_response(self) -> dict:
        """Practice-response shape + generated/aiGenerated/setId (no hidden data)."""
        public: PracticeResponse = build_public_response(self.to_record())
        return {**public.model_dump(), "generated": True, "aiGenerated": True, "setId": self.set_id}


def set_id_for(video_id: str, last_cue_id: str) -> str:
    key = f"{PROMPT_VERSION}|{video_id}|{last_cue_id}"
    return "tm-" + hashlib.sha256(key.encode()).hexdigest()[:16]


@dataclass
class ExerciseGenerator:
    model_call: ModelCall | None = None
    model_name: str = field(default_factory=resolve_model)
    budget_s: float = BUDGET_S
    retry_min_remaining_s: float = RETRY_MIN_REMAINING_S
    set_ttl_s: float = SET_TTL_S
    max_sets: int = MAX_CACHED_SETS
    rate_limit: int = RATE_LIMIT
    rate_window_s: float = RATE_WINDOW_S
    clock: Callable[[], float] = time.monotonic
    model_calls: int = 0
    _sets: dict[str, GeneratedSet] = field(default_factory=dict)
    _starts: deque = field(default_factory=deque)
    _inflight: dict[str, asyncio.Future] = field(default_factory=dict)

    def get_set(self, set_id: str) -> GeneratedSet | None:
        """The cached private set, or None once expired/evicted (→ SET_EXPIRED)."""
        s = self._sets.get(set_id)
        if s is None:
            return None
        if s.expires_at <= self.clock():
            self._sets.pop(set_id, None)
            return None
        return s

    def find_exercise(self, exercise_id: str) -> GeneratedSet | None:
        """Catalog fallback for /v1/submissions: exercise ids are ``{setId}-1``."""
        return self.get_set(exercise_id.rsplit("-", 1)[0]) if exercise_id.startswith("tm-") else None

    def _take_rate_slot(self) -> None:
        now = self.clock()
        while self._starts and self._starts[0] <= now - self.rate_window_s:
            self._starts.popleft()
        if len(self._starts) >= self.rate_limit:
            raise TestMeError("BUSY", "too many Test me requests right now; try again in a minute", True)
        self._starts.append(now)

    def _store(self, s: GeneratedSet) -> None:
        self._sets.pop(s.set_id, None)
        self._sets[s.set_id] = s
        while len(self._sets) > self.max_sets:
            self._sets.pop(next(iter(self._sets)))

    async def generate(self, clip: Clip, verify: Verify) -> GeneratedSet:
        set_id = set_id_for(clip.video_id, clip.last_cue_id)
        cached = self.get_set(set_id)
        if cached:
            return cached
        if set_id in self._inflight:
            return await asyncio.shield(self._inflight[set_id])
        self._take_rate_slot()

        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._inflight[set_id] = fut
        try:
            try:
                result = await asyncio.wait_for(self._generate(clip, set_id, verify), self.budget_s)
            except asyncio.TimeoutError as exc:
                raise TestMeError("GENERATOR_TIMEOUT", "generating the exercise took too long", True) from exc
        except asyncio.CancelledError:
            fut.cancel()
            raise
        except Exception as exc:  # TestMeError or a verify() error (e.g. Grader.Unavailable)
            fut.set_exception(exc)
            fut.exception()
            raise
        else:
            fut.set_result(result)
            return result
        finally:
            self._inflight.pop(set_id, None)

    async def _generate(self, clip: Clip, set_id: str, verify: Verify) -> GeneratedSet:
        call = self.model_call or anthropic_model_call(self.model_name)
        started = time.monotonic()
        feedback: str | None = None
        for attempt in (1, 2):
            self.model_calls += 1
            text = await call(build_prompt(clip, feedback))
            try:
                try:
                    out = GenOutput.model_validate_json(text)
                except ValidationError as exc:
                    raise _CheckFailed("output did not match the schema") from exc
                exercise, tags = check_output(out, clip, f"{set_id}-1")
                if not await verify(exercise):
                    raise _CheckFailed(
                        "in the sandbox the reference must pass every test and the "
                        "known-wrong solution must fail at least one"
                    )
            except _CheckFailed as exc:
                remaining = self.budget_s - (time.monotonic() - started)
                logger.info("testme set=%s attempt=%d rejected: %s", set_id, attempt, exc)
                if attempt == 1 and remaining >= self.retry_min_remaining_s:
                    feedback = str(exc)
                    continue
                raise TestMeError(
                    "GENERATOR_UNAVAILABLE", "could not build a checked exercise for this moment", True
                ) from exc
            now = self.clock()
            s = GeneratedSet(
                set_id=set_id, video_id=clip.video_id, timestamp_s=clip.timestamp_s,
                exercise=exercise, concept_tags=tuple(tags), model=self.model_name,
                created_at=now, expires_at=now + self.set_ttl_s,
            )
            self._store(s)
            logger.info(
                "testme set=%s video=%s attempts=%d ms=%d",
                set_id, clip.video_id, attempt, int((time.monotonic() - started) * 1000),
            )
            return s
        raise AssertionError("unreachable")  # pragma: no cover


# ---------------------------------------------------------------------------
# Module-level API used by app.main (T4)
# ---------------------------------------------------------------------------

EndpointVerify = Callable[[str, str, str, list[dict]], Awaitable[bool]]
"""main.py's verify: (functionName, reference, knownWrong, [{args, expected}]) -> valid."""

_default: ExerciseGenerator | None = None


def default_generator() -> ExerciseGenerator:
    global _default
    if _default is None:
        _default = ExerciseGenerator()
    return _default


async def generate(clip: Clip, verify: EndpointVerify) -> GeneratedSet:
    """Generate (or return the cached) checked set for this moment."""

    async def adapted(ex: ApprovedExercise) -> bool:
        cases = [{"args": c.args, "expected": c.expected} for c in [*ex.examples, *ex.hiddenTests]]
        return await verify(ex.functionName, ex.referenceSolution, ex.knownWrongSolution, cases)

    return await default_generator().generate(clip, adapted)


def get_set(set_id: str) -> GeneratedSet | None:
    return default_generator().get_set(set_id)


def find_exercise(exercise_id: str) -> GeneratedSet | None:
    """Catalog fallback: look up a generated set by exercise id."""
    return default_generator().find_exercise(exercise_id)
