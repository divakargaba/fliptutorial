"""Efficiency feedback after a passing submission (POST /v1/analysis).

1. A static estimate (Python ``ast``) of the learner's and the reference solution's
   time and space complexity: loop nesting, sorting, linear built-ins inside loops,
   halving loops, recursion.
2. Claude reviews the learner's code with that evidence and answers with a verdict:
   the learner's complexity, the best achievable complexity, whether the learner is
   optimal, a one-line tip and (only if not optimal) a faster solution.
3. A suggested faster solution is shown only after it passes every test in the
   grader. Without a key or on any provider error, the static comparison against
   the reviewed reference solution decides on its own.

Only code that already passed Submit for that exact exercise may be analysed, so the
reference solution is never revealed to someone who has not solved the exercise.
"""

from __future__ import annotations

import ast
import asyncio
import logging
import os
from dataclasses import dataclass
from typing import Awaitable, Callable

from pydantic import BaseModel

from .catalog import ApprovedExercise

logger = logging.getLogger("breakpoint.analysis")

DEFAULT_MODEL = "claude-opus-5-5"
BUDGET_S = 12.0

# Ranks let classes be compared: higher is slower.
TIME_CLASSES = ["O(1)", "O(log n)", "O(n)", "O(n log n)", "O(n^2)", "O(n^2 log n)", "O(n^3)", "O(2^n)"]
SPACE_CLASSES = ["O(1)", "O(log n)", "O(n)", "O(n^2)"]

LINEAR_CALLS = {"sum", "min", "max", "list", "set", "dict", "tuple", "sorted", "reversed", "any", "all",
                "enumerate", "zip", "map", "filter"}
LINEAR_METHODS = {"count", "index", "remove", "insert", "join", "split", "replace", "find", "copy", "extend"}
SORT_CALLS = {"sorted"}
SORT_METHODS = {"sort"}


@dataclass(frozen=True)
class Estimate:
    time_rank: int
    space_rank: int

    @property
    def time(self) -> str:
        return TIME_CLASSES[self.time_rank]

    @property
    def space(self) -> str:
        return SPACE_CLASSES[self.space_rank]


def _loop_is_logarithmic(node: ast.While) -> bool:
    """while loops whose variable is halved/doubled each pass run O(log n) times."""
    for sub in ast.walk(node):
        if isinstance(sub, ast.AugAssign) and isinstance(sub.op, (ast.FloorDiv, ast.Div, ast.RShift, ast.Mult, ast.LShift)):
            if isinstance(sub.value, ast.Constant) and sub.value.value in (2, 2.0):
                return True
    return False


def estimate(code: str, function_name: str) -> Estimate | None:
    """Static complexity estimate of ``function_name`` in ``code``; None if unparsable."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return None
    fn = next((n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == function_name), None)
    if fn is None:
        return None

    best_time = 0
    space = 0
    # Names bound to hash-based containers: membership tests on them are O(1).
    hashed: set[str] = set()
    for node in ast.walk(fn):
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            v = node.value
            if (isinstance(v, (ast.Set, ast.Dict, ast.SetComp, ast.DictComp))
                    or (isinstance(v, ast.Call) and isinstance(v.func, ast.Name)
                        and v.func.id in ("set", "dict", "Counter", "defaultdict", "frozenset"))):
                hashed.add(node.targets[0].id)

    def call_cost(call: ast.Call) -> int:
        f = call.func
        if isinstance(f, ast.Name):
            if f.id in SORT_CALLS:
                return 3
            if f.id in LINEAR_CALLS:
                return 2
        if isinstance(f, ast.Attribute):
            if f.attr in SORT_METHODS:
                return 3
            if f.attr in LINEAR_METHODS:
                return 2
        return 0

    def visit(node: ast.AST, loop_rank: int) -> None:
        nonlocal best_time, space
        for child in ast.iter_child_nodes(node):
            rank = loop_rank
            if isinstance(child, (ast.For, ast.AsyncFor)):
                rank = loop_rank + 2
            elif isinstance(child, ast.While):
                rank = loop_rank + (1 if _loop_is_logarithmic(child) else 2)
            elif isinstance(child, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
                rank = loop_rank + 2 * len(child.generators)
                if not isinstance(child, ast.GeneratorExp):
                    space = max(space, 2)
            elif isinstance(child, ast.Call):
                best_time = max(best_time, loop_rank + call_cost(child))
                if isinstance(child.func, ast.Name) and child.func.id in ("list", "set", "dict", "sorted"):
                    space = max(space, 2)
            elif isinstance(child, ast.Compare) and any(isinstance(op, (ast.In, ast.NotIn)) for op in child.ops):
                # membership in a list is a scan; in a set/dict it is O(1)
                target = child.comparators[-1]
                if loop_rank and not (isinstance(target, ast.Name) and target.id in hashed):
                    best_time = max(best_time, loop_rank + 2)
            elif isinstance(child, (ast.List, ast.Dict, ast.Set)) and loop_rank:
                space = max(space, 2)
            best_time = max(best_time, rank)
            visit(child, rank)

    visit(fn, 0)
    self_calls = [n for n in ast.walk(fn) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                  and n.func.id == function_name]
    if len(self_calls) >= 2:
        best_time, space = 7, max(space, 2)
    elif len(self_calls) == 1:
        halving = any(isinstance(a, ast.BinOp) and isinstance(a.op, (ast.FloorDiv, ast.RShift))
                      for c in self_calls for a in c.args)
        best_time = max(best_time, 1 if halving else 2)
        space = max(space, 1 if halving else 2)
    return Estimate(min(best_time, 7), min(space, 3))


# ---------------------------------------------------------------------------
# Model verdict
# ---------------------------------------------------------------------------


class Complexity(BaseModel):
    time: str
    space: str


class AnalysisResponse(BaseModel):
    learner: Complexity
    best: Complexity
    optimal: bool
    summary: str
    tip: str | None
    betterSolution: str | None
    aiGenerated: bool


VERDICT_SCHEMA = {
    "type": "object",
    "properties": {
        "learnerTime": {"type": "string", "description": "Big-O time of the learner's code, e.g. O(n log n)."},
        "learnerSpace": {"type": "string", "description": "Big-O extra space of the learner's code."},
        "bestTime": {"type": "string", "description": "Best achievable Big-O time for this problem in plain Python."},
        "bestSpace": {"type": "string", "description": "Extra space of that best approach."},
        "optimal": {"type": "boolean", "description": "true if the learner's time AND space already match the best."},
        "summary": {"type": "string", "description": "One friendly sentence on the learner's efficiency."},
        "tip": {"type": "string", "description": "If not optimal: one sentence on the idea that makes it faster. Else ''."},
        "betterSolution": {"type": "string", "description": "If not optimal: a complete faster Python solution defining the same function. Else ''."},
    },
    "required": ["learnerTime", "learnerSpace", "bestTime", "bestSpace", "optimal", "summary", "tip", "betterSolution"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """You review a beginner's Python solution that already passed every test. Judge its time and extra-space complexity in Big-O, in terms of the size of the input (for numbers, the numeric value n; for strings and lists, their length n). Compare it with the best practical approach for this exact problem. A static estimate is provided as evidence; trust it unless the code clearly does something it missed.

Mark optimal=true when the learner's complexity matches the best practical one, even if their code could be shorter. Only suggest a faster solution when it is asymptotically better and still simple enough for a beginner. Respect constraints stated in the exercise (for example "use a loop instead of **"). The faster solution must define the same function name and signature and return the same results. Keep summary and tip to one short sentence each, encouraging in tone."""

ModelCall = Callable[[str], Awaitable[str]]
Verify = Callable[[ApprovedExercise, str], Awaitable[bool]]


def anthropic_model_call(model: str | None = None) -> ModelCall:
    try:
        from dotenv import load_dotenv

        from .hints import BACKEND_DIR

        load_dotenv(BACKEND_DIR / ".env")
    except ImportError:  # pragma: no cover
        pass
    model_name = model or os.environ.get("ANTHROPIC_ANALYSIS_MODEL") or DEFAULT_MODEL
    client = None

    async def call(prompt: str) -> str:
        nonlocal client
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY is not set")
        import anthropic

        if client is None:
            client = anthropic.AsyncAnthropic(api_key=api_key, max_retries=1, timeout=BUDGET_S)
        resp = await client.beta.messages.create(
            model=model_name,
            max_tokens=6000,
            system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": prompt}],
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": VERDICT_SCHEMA}},
            betas=["server-side-fallback-2026-07-01"],
            extra_body={"fallbacks": "default"},
        )
        if resp.stop_reason in ("refusal", "max_tokens"):
            raise RuntimeError(f"model stopped: {resp.stop_reason}")
        return "".join(b.text for b in resp.content if b.type == "text")

    return call


def build_prompt(exercise: ApprovedExercise, code: str, learner: Estimate | None, ref: Estimate | None) -> str:
    def fmt(e: Estimate | None) -> str:
        return f"time {e.time}, space {e.space}" if e else "unknown"

    return (
        f"Exercise: {exercise.title}\n{exercise.statement}\n\n"
        f"Learner's passing solution:\n<code>\n{code[:8000]}\n</code>\n"
        f"Static estimate for the learner: {fmt(learner)}\n\n"
        f"Instructor's reference solution (for comparison):\n<code>\n{exercise.referenceSolution}\n</code>\n"
        f"Static estimate for the reference: {fmt(ref)}"
    )


def _rank(label: str, classes: list[str]) -> int | None:
    norm = label.replace(" ", "").replace("²", "^2").replace("³", "^3").lower()
    for i, c in enumerate(classes):
        if c.replace(" ", "").lower() == norm:
            return i
    return None


def static_verdict(exercise: ApprovedExercise, learner: Estimate | None, ref: Estimate | None) -> AnalysisResponse:
    if learner is None or ref is None:
        e = learner or ref or Estimate(2, 0)
        return AnalysisResponse(learner=Complexity(time=e.time, space=e.space), best=Complexity(time=e.time, space=e.space),
                                optimal=True, summary="Nice work: your solution passed every test.", tip=None,
                                betterSolution=None, aiGenerated=False)
    best = Estimate(min(learner.time_rank, ref.time_rank), min(learner.space_rank, ref.space_rank))
    slower = learner.time_rank > ref.time_rank or (learner.time_rank == ref.time_rank and learner.space_rank > ref.space_rank)
    if not slower:
        return AnalysisResponse(learner=Complexity(time=learner.time, space=learner.space),
                                best=Complexity(time=best.time, space=best.space), optimal=True,
                                summary=f"Efficient: {learner.time} time and {learner.space} extra space.",
                                tip=None, betterSolution=None, aiGenerated=False)
    return AnalysisResponse(
        learner=Complexity(time=learner.time, space=learner.space), best=Complexity(time=ref.time, space=ref.space),
        optimal=False,
        summary=f"You passed! Your solution runs in {learner.time} time, but this can be done in {ref.time}.",
        tip="Look for work that is repeated inside a loop and see if it can be done once.",
        betterSolution=exercise.referenceSolution, aiGenerated=False)


async def analyze(exercise: ApprovedExercise, code: str, verify: Verify,
                  model_call: ModelCall | None = None) -> AnalysisResponse:
    learner = estimate(code, exercise.functionName)
    ref = estimate(exercise.referenceSolution, exercise.functionName)
    fallback = static_verdict(exercise, learner, ref)
    try:
        call = model_call or anthropic_model_call()
        raw = await asyncio.wait_for(call(build_prompt(exercise, code, learner, ref)), BUDGET_S + 1)
        import json

        v = json.loads(raw)
        better = (v.get("betterSolution") or "").strip() or None
        optimal = bool(v["optimal"])
        result = AnalysisResponse(
            learner=Complexity(time=v["learnerTime"], space=v["learnerSpace"]),
            best=Complexity(time=v["bestTime"], space=v["bestSpace"]),
            optimal=optimal, summary=v["summary"].strip() or fallback.summary,
            tip=None if optimal else ((v.get("tip") or "").strip() or None),
            betterSolution=None if optimal else better, aiGenerated=True)
        # A model can only claim "slower than best" if the classes say so.
        lr, br = _rank(result.learner.time, TIME_CLASSES), _rank(result.best.time, TIME_CLASSES)
        if not optimal and lr is not None and br is not None and lr <= br:
            ls, bs = _rank(result.learner.space, SPACE_CLASSES), _rank(result.best.space, SPACE_CLASSES)
            if ls is None or bs is None or ls <= bs:
                result.optimal, result.tip, result.betterSolution = True, None, None
    except Exception as exc:  # noqa: BLE001 - any provider/parse failure falls back to the static verdict
        logger.info("analysis model unavailable for %s: %s", exercise.id, type(exc).__name__)
        result = fallback
    if result.betterSolution and result.betterSolution != exercise.referenceSolution:
        try:
            ok = await verify(exercise, result.betterSolution)
        except Exception:  # noqa: BLE001
            ok = False
        if not ok:
            logger.info("analysis: suggested solution for %s failed verification; dropped", exercise.id)
            result.betterSolution = None
    return result
