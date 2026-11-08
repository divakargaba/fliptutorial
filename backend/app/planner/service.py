"""Background planning, plan cache and public plan (contracts/v2/README.md §1).

``Planner.request(video_id, level, levels)`` returns the current public plan at once and
starts work in the background if needed ("pause only when ready"):

1. classification job per video: fetch captions, classify ~40-minute windows in order
   (earliest first), number/rank pauses window by window so ids stay stable;
2. generation job per (video, level tier): generate pause items in time order, two at a
   time, as soon as their window is classified. Each pause is planned at the learner's
   level for the pause's concept (``levels[concept]``, else the default ``level``), so a
   tier only generates the pauses whose concept some request wants at that tier.

Plans are cached on disk per video (``content/plans/<videoId>.json``, gitignored: it
holds private answers) so the next viewer gets the plan instantly and a restarted server
resumes unfinished work. The public plan never contains answers, references or tests.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

from pydantic import BaseModel, ValidationError

from ..catalog import ApprovedExercise
from ..transcripts import Transcript, TranscriptError
from .classify import (
    Block, Evidence, Numberer, PauseSlot, Section, WindowOut, build_prompt, make_blocks, validate_window, windows,
)
from .generate import (
    GenerationFailed, ModelCall, PrivateExercise, PrivateQuestion, Verify, generate_coding, generate_question,
    public_exercise,
)
from .vocab import CODING_LANGUAGES, DEFAULT_LEVEL, concept_ids, tier_of

logger = logging.getLogger("breakpoint.planner")

BACKEND_DIR = Path(__file__).resolve().parents[2]
CACHE_VERSION = 1
MISS_TTL_S = 600.0
ERROR_TTL_S = 60.0
GEN_CONCURRENCY = 2
MAX_NEW_VIDEOS_PER_HOUR = int(os.environ.get("PLANNER_MAX_NEW_VIDEOS_PER_HOUR", "30"))

FetchTranscript = Callable[[str], Awaitable[Transcript]]


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------


@dataclass
class Item:
    kind: str  # coding | concept
    status: str = "pending"  # pending | ready | failed
    exercise: PrivateExercise | None = None
    question: PrivateQuestion | None = None


@dataclass
class TierState:
    items: dict[str, Item] = field(default_factory=dict)
    want: set[str] = field(default_factory=set)  # concept ids some request wants at this tier (in memory)


Levels = dict[str, str]  # conceptId -> levelId (learnerLevels)


def slot_level(slot: PauseSlot, level: str, levels: Levels | None) -> str:
    return (levels or {}).get(slot.concept) or level


def wanted_concepts(level: str, levels: Levels | None) -> dict[str, set[str]]:
    """tier -> concept ids that a request with this default level and per-concept map needs."""
    levels = levels or {}
    out: dict[str, set[str]] = {}
    for c in set(concept_ids()) | set(levels):
        out.setdefault(tier_of(levels.get(c) or level), set()).add(c)
    return out


@dataclass
class VideoState:
    video_id: str
    status: str = "planning"  # planning | classified | not_coding | no_captions | error
    reason: str = ""
    verdict_evidence: list[Evidence] = field(default_factory=list)
    sections: list[Section] = field(default_factory=list)
    generated_at: str = field(default_factory=_now_iso)
    expires_at: float | None = None  # in-memory only states (no_captions / error)
    tiers: dict[str, TierState] = field(default_factory=dict)
    progress: asyncio.Event = field(default_factory=asyncio.Event)

    @property
    def slots(self) -> list[PauseSlot]:
        return sorted((p for s in self.sections for p in s.pauses), key=lambda p: p.pause_at_s)

    @property
    def classified(self) -> bool:
        return self.status != "planning"


def planned_kind(section: Section, slot: PauseSlot) -> str:
    if section.language in CODING_LANGUAGES and section.format in ("code", "mixed") and slot.trigger != "concept_complete":
        return "coding"
    return "concept"


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


def _dump_state(st: VideoState) -> dict:
    def sec(s: Section) -> dict:
        return {**s.dump(), "confidence": s.confidence, "pauses": [asdict(p) for p in s.pauses]}

    def item(it: Item) -> dict:
        d: dict[str, Any] = {"kind": it.kind, "status": it.status}
        if it.exercise:
            d["exercise"] = {"exercise": it.exercise.exercise.model_dump(), "revision": it.exercise.revision,
                             "concepts": it.exercise.concepts, "level": it.exercise.level,
                             "language": it.exercise.language}
        if it.question:
            d["question"] = it.question.dump()
        return d

    return {
        "cacheVersion": CACHE_VERSION, "videoId": st.video_id, "status": st.status, "reason": st.reason,
        "verdictEvidence": [e.dump() for e in st.verdict_evidence], "generatedAt": st.generated_at,
        "sections": [sec(s) for s in st.sections],
        "tiers": {t: {"items": {k: item(v) for k, v in ts.items.items()}} for t, ts in st.tiers.items()},
    }


def _load_state(d: dict) -> VideoState:
    st = VideoState(d["videoId"], d["status"], d.get("reason", ""),
                    [Evidence(**e) for e in d.get("verdictEvidence", [])], generated_at=d.get("generatedAt", _now_iso()))
    for s in d.get("sections", []):
        sec = Section(s["startS"], s["endS"], s["title"], s["format"], s["language"], s["concepts"], s["qualifies"],
                      s.get("confidence", "medium"), [Evidence(**e) for e in s["evidence"]], id=s["id"])
        sec.pauses = [PauseSlot(**p) for p in s.get("pauses", [])]
        st.sections.append(sec)
    for t, ts in d.get("tiers", {}).items():
        tier = TierState()
        for k, v in ts.get("items", {}).items():
            it = Item(v["kind"], v.get("status", "pending"))
            if "exercise" in v:
                e = v["exercise"]
                it.exercise = PrivateExercise(ApprovedExercise.model_validate(e["exercise"]), e["revision"],
                                              e["concepts"], e["level"], e["language"])
            if "question" in v:
                it.question = PrivateQuestion.load(v["question"])
            tier.items[k] = it
        st.tiers[t] = tier
    if st.status == "planning":  # interrupted classification: redo it
        st.sections, st.tiers = [], {}
    return st


class PlanStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(root or os.environ.get("PLANNER_CACHE_DIR") or BACKEND_DIR / "content" / "plans")

    def path(self, video_id: str) -> Path:
        return self.root / f"{video_id}.json"

    def load(self, video_id: str) -> VideoState | None:
        p = self.path(video_id)
        if not p.exists():
            return None
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            if d.get("cacheVersion") != CACHE_VERSION:
                return None
            return _load_state(d)
        except (OSError, ValueError, KeyError, TypeError, ValidationError) as exc:
            logger.warning("planner: ignoring unreadable cache %s (%s)", p.name, type(exc).__name__)
            return None

    def save(self, st: VideoState) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        p = self.path(st.video_id)
        tmp = p.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(_dump_state(st), indent=1, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, p)


# ---------------------------------------------------------------------------
# Planner
# ---------------------------------------------------------------------------


class PlannerUnavailable(Exception):
    """The model can't be called (no key, provider down). Reported as status error."""


@dataclass
class Planner:
    fetch_transcript: FetchTranscript
    model_call: ModelCall
    verify: Verify
    store: PlanStore = field(default_factory=PlanStore)
    gen_concurrency: int = GEN_CONCURRENCY
    max_new_videos_per_hour: int = MAX_NEW_VIDEOS_PER_HOUR
    clock: Callable[[], float] = time.monotonic
    _states: dict[str, VideoState] = field(default_factory=dict)
    _tasks: dict[str, asyncio.Task] = field(default_factory=dict)
    _starts: list[float] = field(default_factory=list)
    _transcripts: dict[str, Transcript] = field(default_factory=dict)
    _specs: dict[str, tuple[str, Levels]] = field(default_factory=dict)  # latest POST levels per video

    # -- public API -----------------------------------------------------------

    def state(self, video_id: str) -> VideoState | None:
        st = self._states.get(video_id)
        if st and st.expires_at is not None and st.expires_at <= self.clock():
            self._states.pop(video_id, None)
            st = None
        if st is None:
            st = self.store.load(video_id)
            if st is not None:
                self._states[video_id] = st
        return st

    def peek(self, video_id: str, level: str | None = None) -> dict | None:
        """Latest plan with the levels of the latest request for this video (``level`` overrides its default)."""
        st = self.state(video_id)
        if not st:
            return None
        last_level, levels = self._specs.get(video_id, (DEFAULT_LEVEL, {}))
        return public_plan(st, level or last_level, levels)

    def request(self, video_id: str, level: str, levels: Levels | None = None) -> dict:
        levels = dict(levels or {})
        self._specs[video_id] = (level, levels)
        st = self.state(video_id)
        if st is None:
            if not self._take_slot():
                st = VideoState(video_id, "error", "Planner is at its hourly limit; try again later.",
                                expires_at=self.clock() + ERROR_TTL_S)
                return public_plan(st, level, levels)
            st = VideoState(video_id)
            self._states[video_id] = st
        if not st.classified:
            self._spawn(f"c:{video_id}", self._classify(st))
        if st.status in ("planning", "classified"):
            for tier, concepts in wanted_concepts(level, levels).items():
                ts = st.tiers.setdefault(tier, TierState())
                ts.want |= concepts
                if not st.classified or _unstarted(st, ts):
                    self._spawn(f"g:{video_id}:{tier}", self._generate(st, tier))
        return public_plan(st, level, levels)

    async def wait_idle(self) -> None:
        """Test helper: wait until all background work has finished."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks.values()), return_exceptions=True)

    def find_exercise(self, exercise_id: str) -> PrivateExercise | None:
        for st in self._iter_states():
            for ts in st.tiers.values():
                for it in ts.items.values():
                    if it.exercise and it.exercise.exercise.id == exercise_id:
                        return it.exercise
        return None

    def find_question(self, question_id: str) -> PrivateQuestion | None:
        for st in self._iter_states():
            for ts in st.tiers.values():
                for it in ts.items.values():
                    if it.question and it.question.id == question_id:
                        return it.question
        return None

    # -- internals ------------------------------------------------------------

    def _iter_states(self):
        yield from list(self._states.values())
        if self.store.root.exists():
            for p in self.store.root.glob("*.json"):
                if p.stem not in self._states:
                    st = self.state(p.stem)
                    if st:
                        yield st

    def _take_slot(self) -> bool:
        now = self.clock()
        self._starts = [t for t in self._starts if t > now - 3600.0]
        if len(self._starts) >= self.max_new_videos_per_hour:
            return False
        self._starts.append(now)
        return True

    def _spawn(self, key: str, coro) -> None:
        if key in self._tasks and not self._tasks[key].done():
            coro.close()
            return
        task = asyncio.get_running_loop().create_task(coro)
        self._tasks[key] = task
        task.add_done_callback(lambda _t, k=key: self._tasks.pop(k, None))

    def _fail(self, st: VideoState, status: str, reason: str, ttl: float) -> None:
        st.status, st.reason, st.expires_at = status, reason, self.clock() + ttl
        st.sections, st.tiers = [], {}
        st.progress.set()

    async def _classify(self, st: VideoState) -> None:
        started = time.monotonic()
        try:
            try:
                transcript = await self.fetch_transcript(st.video_id)
            except TranscriptError as exc:
                if exc.code == "NO_CAPTIONS":
                    self._fail(st, "no_captions", "This video has no English captions to plan from.", MISS_TTL_S)
                else:
                    self._fail(st, "error", f"Captions could not be read right now ({exc.code}).", ERROR_TTL_S)
                return
            self._transcripts[st.video_id] = transcript
            blocks = make_blocks(transcript)
            wins = windows(blocks)
            numberer = Numberer()
            reasons: list[str] = []
            about = False
            for wi, win in enumerate(wins):
                nxt = wins[wi + 1][0].start_s if wi + 1 < len(wins) else None
                out = await self._classify_window(transcript.title, win, wi == 0, wi == len(wins) - 1)
                res = validate_window(out, win, nxt)
                window_s = (nxt or win[-1].end_s) - win[0].start_s
                numberer.add(res.sections, window_s)
                st.sections.extend(res.sections)
                reasons.append(res.reason)
                about = about or res.about_programming
                qual = [s for s in st.sections if s.qualifies]
                if qual:  # show the verdict so far while later windows are classified
                    st.reason = st.reason or res.reason
                    st.verdict_evidence = [e for s in qual[:3] for e in s.evidence[:1]]
                st.progress.set()
                st.progress = asyncio.Event()
                if wi == 0 and not about and not any(s.qualifies for s in res.sections):
                    break  # clearly not a programming video: say so now, don't spend more
            qualifying = [s for s in st.sections if s.qualifies]
            if qualifying:
                st.status = "classified"
                st.reason = reasons[0] if reasons else ""
                st.verdict_evidence = [e for s in qualifying[:3] for e in s.evidence[:1]]
            else:
                st.status = "not_coding"
                st.reason = (reasons[0] if reasons else "") or "No section teaches or demonstrates code."
                st.verdict_evidence = [e for s in st.sections[:3] for e in s.evidence[:1]]
            st.generated_at = _now_iso()
            self.store.save(st)
            logger.info("planner classify video=%s status=%s sections=%d pauses=%d ms=%d", st.video_id, st.status,
                        len(st.sections), len(st.slots), int((time.monotonic() - started) * 1000))
        except PlannerUnavailable as exc:
            self._fail(st, "error", str(exc), ERROR_TTL_S)
        except Exception:
            logger.exception("planner classify failed video=%s", st.video_id)
            self._fail(st, "error", "Planning failed for this video.", ERROR_TTL_S)
        finally:
            st.progress.set()

    async def _classify_window(self, title: str, win: list[Block], first: bool, last: bool) -> WindowOut:
        prompt = build_prompt(title, win, first, last)
        for attempt in (1, 2):
            text = await self.model_call(prompt, WindowOut)
            try:
                return WindowOut.model_validate_json(text)
            except ValidationError:
                logger.info("planner classify window attempt=%d: output did not match the schema", attempt)
        return WindowOut(videoIsAboutProgramming=False, reason="", sections=[])

    async def _transcript(self, video_id: str) -> Transcript:
        t = self._transcripts.get(video_id)
        if t is None:
            t = await self.fetch_transcript(video_id)
            self._transcripts[video_id] = t
        return t

    async def _generate(self, st: VideoState, tier: str) -> None:
        """Generate items in pause order (semaphore is FIFO, so earliest pauses first),
        picking up newly classified windows and newly wanted concepts as they arrive."""
        ts = st.tiers.setdefault(tier, TierState())
        sem = asyncio.Semaphore(self.gen_concurrency)
        started: set[str] = set()
        tasks: list[asyncio.Task] = []
        try:
            while True:
                progress = st.progress  # capture before scanning so no update is missed
                for slot in st.slots:
                    if slot.id in started or slot.concept not in ts.want:
                        continue
                    started.add(slot.id)
                    it = ts.items.get(slot.id)
                    if it is not None and it.status != "pending":
                        continue
                    tasks.append(asyncio.get_running_loop().create_task(self._guarded(sem, st, ts, tier, slot)))
                if st.classified:
                    await asyncio.gather(*tasks)
                    if not any(s.id not in started and s.concept in ts.want for s in st.slots):
                        break  # else a request widened ``want`` while we waited: start those too
                else:
                    await progress.wait()
            if st.status == "classified":
                self.store.save(st)
        except Exception:
            logger.exception("planner generate failed video=%s tier=%s", st.video_id, tier)

    async def _guarded(self, sem: asyncio.Semaphore, st: VideoState, ts: TierState, tier: str, slot: PauseSlot) -> None:
        async with sem:
            await self._one(st, ts, tier, slot)

    async def _one(self, st: VideoState, ts: TierState, tier: str, slot: PauseSlot) -> None:
        section = st.sections[slot.section_index]
        kind = planned_kind(section, slot)
        item = Item(kind)
        ts.items[slot.id] = item
        try:
            transcript = await self._transcript(st.video_id)
            if kind == "coding":
                try:
                    item.exercise = await generate_coding(self.model_call, self.verify, transcript, st.video_id,
                                                          section, slot, tier)
                except GenerationFailed as exc:
                    logger.info("planner %s/%s coding failed (%s); trying a concept question", st.video_id, slot.id, exc)
                    item.kind = "concept"
            if item.kind == "concept":
                item.question = await generate_question(self.model_call, transcript, st.video_id, section, slot, tier)
            item.status = "ready"
        except (GenerationFailed, PlannerUnavailable, TranscriptError) as exc:
            logger.info("planner %s/%s dropped: %s", st.video_id, slot.id, exc)
            item.status = "failed"
        except Exception:
            logger.exception("planner %s/%s failed", st.video_id, slot.id)
            item.status = "failed"
        if st.classified:
            self.store.save(st)



# ---------------------------------------------------------------------------
# Public plan
# ---------------------------------------------------------------------------


def _unstarted(st: VideoState, ts: TierState) -> bool:
    return any(s.concept in ts.want and (s.id not in ts.items or ts.items[s.id].status == "pending")
               for s in st.slots)


def _slot_item(st: VideoState, slot: PauseSlot, level: str, levels: Levels | None) -> tuple[str, Item | None]:
    tier = tier_of(slot_level(slot, level, levels))
    ts = st.tiers.get(tier)
    return tier, (ts.items.get(slot.id) if ts else None)


def public_plan(st: VideoState, level: str, levels: Levels | None = None) -> dict:
    """Public plan for one learner: each pause uses the level for its concept, else ``level``."""
    slots = st.slots
    picked = [_slot_item(st, slot, level, levels) for slot in slots]
    if st.status in ("not_coding", "no_captions", "error"):
        status = st.status
    elif st.status == "classified" and all(it is not None and it.status != "pending" for _, it in picked):
        status = "ready"
    else:
        status = "planning"

    pauses: list[dict] = []
    if status in ("planning", "ready"):
        for slot, (_, it) in zip(slots, picked):
            section = st.sections[slot.section_index]
            if it is not None and it.status == "failed":
                continue
            ready = it is not None and it.status == "ready"
            kind = it.kind if it else planned_kind(section, slot)
            p: dict[str, Any] = {
                "id": slot.id, "sectionId": section.id, "pauseAtS": slot.pause_at_s, "revealAtS": slot.reveal_at_s,
                "kind": kind, "rank": slot.rank, "ready": ready,
            }
            if kind == "coding":
                p["exercise"] = public_exercise(it.exercise) if ready and it.exercise else None
            else:
                p["question"] = it.question.public() if ready and it.question else None
            pauses.append(p)

    sections = [s.dump() for s in st.sections] if status in ("planning", "ready", "not_coding") else []
    digest = hashlib.sha256(json.dumps([sections, [(p["id"], p["ready"]) for p in pauses], [t for t, _ in picked]]).encode()).hexdigest()[:8]
    qualifies = status in ("planning", "ready") and any(s.qualifies for s in st.sections)
    reason = st.reason or ("Planning this video…" if st.status == "planning" else "")
    return {
        "schemaVersion": 2,
        "videoId": st.video_id,
        "planId": f"plan-{st.video_id}-{digest}",
        "status": status,
        "generatedAt": st.generated_at,
        "learnerLevel": level,
        "verdict": {"qualifies": qualifies, "reason": reason, "evidence": [e.dump() for e in st.verdict_evidence]},
        "sections": sections,
        "pauses": pauses,
    }
