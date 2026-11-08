"""Exercise and concept-question generation for planned pauses (roadmap steps 2, 3, 5).

Only captions spoken before the pause reach the model. Coding exercises reuse the Test me
schema and checks (``app.testme``) and must pass the Judge0 rule: the reference passes
every test and the known-wrong solution fails at least one. Concept questions
(multiple choice / predict output / short answer) are used where the language is not one
we can verify yet, or where the section is theory. Answers, references and hidden tests
stay in the private record; the public plan never contains them.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from pydantic import BaseModel, Field, ValidationError

from ..catalog import ApprovedExercise, Example, HiddenTest
from ..testme import MAX_CODE_CHARS, MAX_STATEMENT, MAX_TITLE, GenOutput, _CheckFailed, _parse_case, check_output
from ..transcripts import Clip, Transcript, clip
from .classify import PauseSlot, Section
from .vocab import QUESTION_STYLES, TIER_GUIDANCE, concept_ids, tier_floor_level

logger = logging.getLogger("breakpoint.planner")

PROMPT_VERSION = "pl1"
CLIP_LOOKBACK_S = 600.0
CLIP_MAX_CHARS = 8000

ModelCall = Callable[[str, type[BaseModel]], Awaitable[str]]
"""(prompt, output model) -> raw JSON text matching that model."""

Verify = Callable[[ApprovedExercise], Awaitable[bool]]
"""Sandbox check of a candidate exercise; its ``.language`` selects the runner."""


class GenerationFailed(Exception):
    pass


class PlannedExercise(ApprovedExercise):
    """A v1 ``ApprovedExercise`` whose language may be any language lane A2's runners grade."""

    language: str  # type: ignore[assignment]


class ChoiceOut(BaseModel):
    id: str = Field(description='"a", "b", "c", "d" (or "e")')
    text: str


class QuestionOut(BaseModel):
    status: str = Field(description='"ok" or "noQuestion"')
    title: str
    style: str = Field(description='"multiple_choice", "predict_output" or "short_answer"')
    prompt: str
    choices: list[ChoiceOut] = Field(description="3-5 choices for multiple_choice, empty otherwise")
    answer: str = Field(description="the correct choice id, the exact expected output, or a model answer")
    explanation: str = Field(description="why the answer is right, for feedback after answering")
    concepts: list[str]
    evidenceCueIds: list[str]


@dataclass
class PrivateExercise:
    exercise: PlannedExercise
    revision: str
    concepts: list[str]
    level: str
    language: str


@dataclass
class PrivateQuestion:
    id: str
    revision: str
    title: str
    style: str
    prompt: str
    choices: list[dict]
    answer: str
    explanation: str
    concepts: list[str]
    level: str

    def public(self) -> dict:
        q: dict[str, Any] = {
            "id": self.id, "revision": self.revision, "title": self.title, "style": self.style,
            "prompt": self.prompt, "concepts": self.concepts, "level": self.level, "aiGenerated": True,
        }
        if self.style == "multiple_choice":
            q["choices"] = self.choices
        return q

    def dump(self) -> dict:
        return {**self.public(), "choices": self.choices, "answer": self.answer, "explanation": self.explanation}

    @classmethod
    def load(cls, d: dict) -> "PrivateQuestion":
        return cls(d["id"], d["revision"], d["title"], d["style"], d["prompt"], d.get("choices", []),
                   d["answer"], d.get("explanation", ""), d.get("concepts", []), d["level"])


def item_id(prefix: str, video_id: str, pause: PauseSlot, tier: str) -> str:
    key = f"{PROMPT_VERSION}|{video_id}|{pause.pause_at_s}|{pause.idea}|{tier}"
    return f"{prefix}-{video_id}-{hashlib.sha256(key.encode()).hexdigest()[:10]}"


def clip_before(transcript: Transcript, pause: PauseSlot) -> Clip:
    return clip(transcript, pause.pause_at_s, min_transcript_s=0.0, lookback_s=CLIP_LOOKBACK_S, max_chars=CLIP_MAX_CHARS)


def _cue_lines(c: Clip) -> str:
    return "\n".join(f"[{q.id}] ({q.start_s:.1f}s) {q.text}" for q in c.cues)


@dataclass(frozen=True)
class LangRules:
    """How a coding exercise is written in one language (the shape lane A2's runner wrappers call)."""

    name: str
    shape: str  # sent to the model
    defines: str  # regex template; FN is replaced by the escaped function name
    forbidden: re.Pattern
    allow_null: bool


_CPP_HEADERS = "algorithm|cmath|climits|cctype|map|set|unordered_map|unordered_set|numeric|string|vector|iostream"

LANG_RULES: dict[str, LangRules] = {
    "javascript": LangRules(
        "JavaScript",
        "One self-contained JavaScript function declaration `function name(a, b) { ... }` that returns a value "
        "(no console, require, import, process, fetch, timers or globals). starterCode is the declaration with "
        "the body `return null;`.",
        r"^\s*function\s+FN\s*\(",
        re.compile(r"\b(?:require|import|process|eval|fetch|XMLHttpRequest|setTimeout|setInterval|Function)\b"
                   r"|\bconsole\s*\.", re.M),
        True,
    ),
    "java": LangRules(
        "Java",
        "A class `class Solution { public static <type> name(...) { ... } }` (not `public class`, no main, no "
        "package) whose static method returns int, long, boolean or String and takes int, long, boolean or "
        "String parameters. Only java.util imports are allowed. starterCode is the class with the method "
        "returning a placeholder (0, false or an empty string).",
        r"\bclass\s+Solution\b[\s\S]*\bstatic\s+[\w<>\[\], ]+\s+FN\s*\(",
        re.compile(r"\bSystem\s*\.\s*(?:in|out|err|exit)\b|\bRuntime\b|\bProcessBuilder\b|\bThread\b|\bScanner\b"
                   r"|^\s*package\s|^\s*import\s+(?!java\.util\.)|\bpublic\s+class\b|\bstatic\s+void\s+main\b"
                   r"|\breflect\b", re.M),
        False,
    ),
    "cpp": LangRules(
        "C++",
        "One free C++ function `<type> name(...) { ... }` returning int, long long, bool or string and taking "
        "int, long long, bool or string parameters (const string& is fine). <iostream>, <string>, <vector> and "
        "`using namespace std;` are already present; extra #include lines may only name <algorithm>, <cmath>, "
        "<climits>, <cctype>, <map>, <set>, <unordered_map>, <unordered_set> or <numeric>. No main, cin, cout, "
        "files or system calls. starterCode is the function returning a placeholder (0, false or an empty string).",
        r"\bFN\s*\([^;{}]*\)\s*(?:const\s*)?\{",
        re.compile(rf"#\s*include\s*<(?!(?:{_CPP_HEADERS})>)|#\s*include\s*\x22"
                   r"|\b(?:system|popen|fork|exec\w*|fopen|freopen)\s*\("
                   r"|\b(?:cin|cout|cerr|ifstream|ofstream|fstream)\b|\bint\s+main\s*\(|\basm\b", re.M),
        False,
    ),
}


def coding_prompt(c: Clip, section: Section, pause: PauseSlot, tier: str, feedback: str | None,
                  language: str = "python") -> str:
    retry = f"\nYour previous answer was rejected: {feedback}. Fix that.\n" if feedback else ""
    if pause.trigger == "question_posed":
        how = ("The instructor just posed this task to the viewer and has not answered yet. Ask the learner "
               "to solve the same task as a function.")
    elif pause.trigger == "concept_complete":
        how = ("The instructor just finished explaining this idea. Write a small NEW coding problem that "
               "applies it (implement or use the idea on a fresh input); do not copy the instructor's example.")
    else:
        how = ("The instructor demonstrated this idea. Write a NEW problem that uses the same idea in a "
               "different setting; do not copy the instructor's example.")
    if language == "python":
        shape = ("- status \"ok\" unless nothing codeable was taught (\"noExercise\"). language is \"python\".\n"
                 "- Use only what was taught before the pause. One self-contained Python function that returns a "
                 "value (no print, input, files or imports).\n"
                 "- functionName is a Python identifier; starterCode is the def line with a `pass` body; ")
        runnable, values = "runnable Python", "integers, strings, booleans or null only"
    else:
        r = LANG_RULES[language]
        shape = (f"- status \"ok\" unless nothing codeable was taught (\"noExercise\"). language is \"{language}\".\n"
                 f"- Use only what was taught before the pause. {r.shape}\n"
                 "- functionName is a plain identifier (the function or method name); ")
        runnable = f"compiling {r.name}"
        values = "integers, strings, booleans or null only" if r.allow_null else "integers, strings or booleans only (no null)"
    return (
        "You write one short practice exercise for a learner watching a programming tutorial. The video "
        "is paused here; below is what the instructor said before the pause (nothing after it).\n"
        f"Video title: {c.title}\nSection: {section.title}\nIdea to practise: {pause.idea}\n{how}\n"
        f"{TIER_GUIDANCE[tier]}\n"
        "Rules:\n"
        f"{shape}"
        f"referenceSolution is correct; knownWrongSolution is {runnable} with a plausible logic mistake "
        "(never a syntax error) that fails at least one hidden test. Describe it in wrongMistake and put "
        "the argsJson of a hidden test it fails into wrongFailsOnArgsJson.\n"
        "- 1-2 examples and 3-5 hiddenTests, all inputs different. argsJson is ALWAYS a JSON array with one "
        "element per parameter (f(5) -> \"[5]\"). expectedJson is one JSON value: "
        f"{values}.\n"
        "- title <= 80 chars; statement <= 600 chars, names the function and what it returns.\n"
        f"- conceptTags from: {', '.join(concept_ids())}.\n"
        "- conceptEvidenceCueIds: cue ids (copied from the brackets) where the idea is taught.\n"
        "- languageEvidence: the words that show the language.\n"
        f"{retry}\n{_cue_lines(c)}\n"
    )


def check_coding(out: GenOutput, c: Clip, exercise_id: str, language: str) -> tuple[PlannedExercise, list[str]]:
    """Static checks for a non-Python exercise; the sandbox verify then proves its behaviour."""
    r = LANG_RULES[language]
    status = out.status.strip().lower()
    if status == "noexercise":
        raise GenerationFailed("model found nothing codeable")
    if status != "ok":
        raise _CheckFailed(f"status must be ok or noExercise, not {out.status!r}")
    if out.language.strip().lower() != language:
        raise _CheckFailed(f"language must be {language}")
    fn = out.functionName.strip()
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", fn):
        raise _CheckFailed("functionName must be a plain identifier")
    title, statement = out.title.strip(), out.statement.strip()
    if not title or len(title) > MAX_TITLE:
        raise _CheckFailed(f"title must be 1-{MAX_TITLE} chars")
    if not statement or len(statement) > MAX_STATEMENT:
        raise _CheckFailed(f"statement must be 1-{MAX_STATEMENT} chars")
    defines = re.compile(r.defines.replace("FN", re.escape(fn)), re.M)
    codes = {"starterCode": out.starterCode, "referenceSolution": out.referenceSolution,
             "knownWrongSolution": out.knownWrongSolution}
    for label, code in codes.items():
        if not code.strip() or len(code) > MAX_CODE_CHARS:
            raise _CheckFailed(f"{label} is empty or longer than {MAX_CODE_CHARS} chars")
        if not defines.search(code):
            raise _CheckFailed(f"{label} does not define {fn} in the required shape")
        if r.forbidden.search(code):
            raise _CheckFailed(f"{label} uses I/O, a process or network call, or a disallowed import/include")
    norm = {k: "\n".join(line.rstrip() for line in v.strip().splitlines()) for k, v in codes.items()}
    if len(set(norm.values())) < 3:
        raise _CheckFailed("starter, reference and wrong solutions must all differ")
    if not 1 <= len(out.examples) <= 2:
        raise _CheckFailed("use one or two examples")
    if not 3 <= len(out.hiddenTests) <= 8:
        raise _CheckFailed("use three to eight hidden tests")
    examples = [_parse_case(x, f"example {i}") for i, x in enumerate(out.examples)]
    hidden = [_parse_case(x, f"hidden test {i}") for i, x in enumerate(out.hiddenTests)]
    cases = examples + hidden
    if not r.allow_null and any(v is None for args, exp in cases for v in [*args, exp]):
        raise _CheckFailed(f"{r.name} cases cannot use null")
    if len({len(args) for args, _ in cases}) != 1:
        raise _CheckFailed("every case must pass the same number of arguments")
    seen = [json.dumps(args) for args, _ in cases]
    if len(set(seen)) != len(seen):
        raise _CheckFailed("test inputs must all differ")
    known = concept_ids()
    tags = [t for t in dict.fromkeys(out.conceptTags) if t in known]
    if not tags:
        raise _CheckFailed(f"conceptTags must include one of {', '.join(known)}")
    cue_ids = {q.id for q in c.cues}
    if not out.conceptEvidenceCueIds or any(e not in cue_ids for e in out.conceptEvidenceCueIds):
        raise _CheckFailed("conceptEvidenceCueIds must be cue ids from the excerpt")
    exercise = PlannedExercise(
        id=exercise_id, title=title, statement=statement, language=language, functionName=fn,
        starterCode=out.starterCode.rstrip() + "\n", conceptTags=tags,
        examples=[Example(args=a, expected=e) for a, e in examples],
        hiddenTests=[HiddenTest(args=a, expected=e) for a, e in hidden],
        referenceSolution=out.referenceSolution.rstrip() + "\n",
        knownWrongSolution=out.knownWrongSolution.rstrip() + "\n",
    )
    return exercise, tags


def question_prompt(c: Clip, section: Section, pause: PauseSlot, tier: str, feedback: str | None) -> str:
    retry = f"\nYour previous answer was rejected: {feedback}. Fix that.\n" if feedback else ""
    lang = section.language if section.language not in ("unknown",) else "language-neutral pseudocode"
    return (
        "You write one short concept question for a learner watching a programming or computer-science "
        "video. The video is paused here; below is what was said before the pause (nothing after it).\n"
        f"Video title: {c.title}\nSection: {section.title} (format {section.format}, language {lang})\n"
        f"Idea to check: {pause.idea}\n{TIER_GUIDANCE[tier]}\n"
        "Rules:\n"
        "- Test understanding of the idea, not recall of the instructor's words. Where it fits, apply it to "
        "a small concrete or real-world case (trace a few steps, predict a result, pick the right approach).\n"
        "- style multiple_choice (3-5 choices with ids a, b, c, d, e; exactly one correct; plausible "
        "distractors based on common misconceptions), predict_output (show a short snippet in the prompt "
        f"written in {lang}; answer is the exact output) or short_answer (one-sentence answer; answer is a "
        "model answer).\n"
        "- Use only material taught before the pause. prompt <= 700 chars; title <= 80 chars.\n"
        "- explanation: 1-3 sentences on why the answer is right.\n"
        f"- concepts from: {', '.join(concept_ids())}.\n"
        "- evidenceCueIds: cue ids (copied from the brackets) where the idea is taught.\n"
        "- status \"noQuestion\" if nothing checkable has been taught.\n"
        f"{retry}\n{_cue_lines(c)}\n"
    )


def check_question(out: QuestionOut, c: Clip, qid: str, revision: str, level: str, fallback: list[str]) -> PrivateQuestion:
    if out.status.strip() != "ok":
        raise GenerationFailed("model found nothing to ask")
    style = out.style.strip()
    if style not in QUESTION_STYLES:
        raise _CheckFailed(f"style must be one of {', '.join(QUESTION_STYLES)}")
    title, prompt, answer = out.title.strip(), out.prompt.strip(), out.answer.strip()
    if not title or len(title) > 80:
        raise _CheckFailed("title must be 1-80 chars")
    if not prompt or len(prompt) > 700:
        raise _CheckFailed("prompt must be 1-700 chars")
    if not answer or len(answer) > 400:
        raise _CheckFailed("answer must be 1-400 chars")
    choices: list[dict] = []
    if style == "multiple_choice":
        ids = [ch.id.strip().lower() for ch in out.choices]
        texts = [ch.text.strip() for ch in out.choices]
        if not 3 <= len(ids) <= 5 or ids != list("abcde"[: len(ids)]):
            raise _CheckFailed("multiple_choice needs 3-5 choices with ids a, b, c, …")
        if any(not t or len(t) > 200 for t in texts) or len(set(texts)) != len(texts):
            raise _CheckFailed("choices must be distinct, 1-200 chars")
        if answer.lower() not in ids:
            raise _CheckFailed("answer must be one of the choice ids")
        answer = answer.lower()
        choices = [{"id": i, "text": t} for i, t in zip(ids, texts)]
    cue_ids = {q.id for q in c.cues}
    if not out.evidenceCueIds or any(e not in cue_ids for e in out.evidenceCueIds):
        raise _CheckFailed("evidenceCueIds must be cue ids from the excerpt")
    known = set(concept_ids())
    concepts = [x for x in dict.fromkeys(out.concepts) if x in known] or fallback
    if not concepts:
        raise _CheckFailed("concepts must use the listed ids")
    return PrivateQuestion(qid, revision, title, style, prompt, choices, answer, out.explanation.strip()[:600],
                           concepts, level)


async def generate_coding(
    model_call: ModelCall, verify: Verify, transcript: Transcript, video_id: str,
    section: Section, pause: PauseSlot, tier: str,
) -> PrivateExercise:
    language = section.language
    if language != "python" and language not in LANG_RULES:
        raise GenerationFailed(f"no coding exercises for {language}")
    c = clip_before(transcript, pause)
    ex_id = item_id("pe", video_id, pause, tier)
    feedback: str | None = None
    for attempt in (1, 2):
        text = await model_call(coding_prompt(c, section, pause, tier, feedback, language), GenOutput)
        try:
            try:
                out = GenOutput.model_validate_json(text)
            except ValidationError as exc:
                raise _CheckFailed("output did not match the schema") from exc
            if out.status.strip().lower() == "noexercise":
                raise GenerationFailed("model found nothing codeable")
            if language == "python":
                try:
                    approved, tags = check_output(out, c, ex_id, allowed_tags=concept_ids())
                except Exception as exc:  # TestMeError (not python / no exercise) is terminal here
                    if isinstance(exc, _CheckFailed):
                        raise
                    raise GenerationFailed(str(exc)) from exc
                exercise = PlannedExercise.model_validate(approved.model_dump())
            else:
                exercise, tags = check_coding(out, c, ex_id, language)
            if not await verify(exercise):
                raise _CheckFailed("in the sandbox the reference must pass every test and the known-wrong solution must fail at least one")
        except _CheckFailed as exc:
            logger.info("planner coding %s attempt=%d rejected: %s", ex_id, attempt, exc)
            feedback = str(exc)
            continue
        revision = "r-" + hashlib.sha256(exercise.model_dump_json().encode()).hexdigest()[:12]
        return PrivateExercise(exercise, revision, tags, tier_floor_level(tier), language)
    raise GenerationFailed(f"no checked exercise after 2 attempts: {feedback}")


async def generate_question(
    model_call: ModelCall, transcript: Transcript, video_id: str, section: Section, pause: PauseSlot, tier: str,
) -> PrivateQuestion:
    c = clip_before(transcript, pause)
    qid = item_id("pq", video_id, pause, tier)
    feedback: str | None = None
    for attempt in (1, 2):
        text = await model_call(question_prompt(c, section, pause, tier, feedback), QuestionOut)
        try:
            try:
                out = QuestionOut.model_validate_json(text)
            except ValidationError as exc:
                raise _CheckFailed("output did not match the schema") from exc
            revision = "r-" + hashlib.sha256(text.encode()).hexdigest()[:12]
            return check_question(out, c, qid, revision, tier_floor_level(tier), [pause.concept])
        except _CheckFailed as exc:
            logger.info("planner question %s attempt=%d rejected: %s", qid, attempt, exc)
            feedback = str(exc)
    raise GenerationFailed(f"no valid question after 2 attempts: {feedback}")


def public_exercise(p: PrivateExercise) -> dict:
    ex = p.exercise
    return {
        "id": ex.id, "revision": p.revision, "title": ex.title, "language": p.language,
        "statement": ex.statement, "starterCode": ex.starterCode,
        "examples": [{"args": e.args, "expected": e.expected} for e in ex.examples],
        "concepts": p.concepts, "level": p.level, "aiGenerated": True,
    }
