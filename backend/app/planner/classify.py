"""Section classifier and pause finder (lane A1, roadmap Component 1 steps 1-3).

The transcript is merged into ~20 s blocks (``b0``, ``b1`` … with start times) and sent
to the model in windows of ~40 minutes. For each window the model returns sections
(block ranges with format, language, concepts, confidence and evidence block ids) and,
inside qualifying sections, candidate pauses: where an explanation is complete, whether
the instructor poses a question (pause before the answer) or only demonstrates (new
problem with the same idea), and how important the moment is.

Everything the model returns is checked against the real transcript: block ids must
exist, evidence text is copied from the real captions (never from the model), pauses
must sit inside their section and before the answer. Anything that fails is dropped,
so weak evidence leaves playback alone.
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass, field

from pydantic import BaseModel, Field

from ..transcripts import Cue, Transcript
from .vocab import FORMATS, LANGUAGES, concept_ids

logger = logging.getLogger("breakpoint.planner")

BLOCK_S = 20.0
WINDOW_S = 40 * 60.0
EVIDENCE_CHARS = 200
MIN_PAUSE_GAP_S = 60.0
PAUSE_BEFORE_ANSWER_S = 1.0
TRIGGERS = ("question_posed", "demonstration", "concept_complete")


# ---------------------------------------------------------------------------
# Blocks
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Block:
    id: str
    start_s: float
    end_s: float
    cues: tuple[Cue, ...]

    @property
    def text(self) -> str:
        return " ".join(c.text for c in self.cues)


def make_blocks(transcript: Transcript, block_s: float = BLOCK_S) -> list[Block]:
    blocks: list[Block] = []
    cur: list[Cue] = []
    for cue in transcript.cues:
        if cur and cue.start_s - cur[0].start_s >= block_s:
            blocks.append(Block(f"b{len(blocks)}", cur[0].start_s, cur[-1].end_s, tuple(cur)))
            cur = []
        cur.append(cue)
    if cur:
        blocks.append(Block(f"b{len(blocks)}", cur[0].start_s, cur[-1].end_s, tuple(cur)))
    return blocks


def windows(blocks: list[Block], window_s: float = WINDOW_S) -> list[list[Block]]:
    out: list[list[Block]] = []
    cur: list[Block] = []
    for b in blocks:
        if cur and b.start_s - cur[0].start_s >= window_s:
            out.append(cur)
            cur = []
        cur.append(b)
    if cur:
        out.append(cur)
    return out


# ---------------------------------------------------------------------------
# Model output schema
# ---------------------------------------------------------------------------


class PauseOut(BaseModel):
    afterBlock: str = Field(description="block id where the explanation of the idea is complete; pause at its end")
    trigger: str = Field(description='"question_posed", "demonstration" or "concept_complete"')
    answerBlock: str = Field(description='block id where the instructor reveals the answer/solution, or "" if none')
    concept: str = Field(description="one concept id from the list")
    idea: str = Field(description="one sentence: the idea a practice task should test, using only what was taught so far")
    importance: int = Field(description="1 = key moment of the section, 2 = good, 3 = minor")


class SectionOut(BaseModel):
    startBlock: str
    endBlock: str
    title: str
    format: str = Field(description='"code", "theory", "mixed" or "off_topic"')
    language: str = Field(description="language taught in this section, or \"pseudocode\" / \"unknown\"")
    languageEvidence: str
    concepts: list[str]
    qualifies: bool = Field(description="true only if it teaches or demonstrates something concrete you can do or reason about in code")
    confidence: str = Field(description='"high", "medium" or "low"')
    evidenceBlocks: list[str] = Field(description="1-3 block ids that justify the decision")
    pauses: list[PauseOut]


class WindowOut(BaseModel):
    videoIsAboutProgramming: bool
    reason: str = Field(description="one sentence on what this part of the video is")
    sections: list[SectionOut]


def build_prompt(title: str, blocks: list[Block], is_first: bool, is_last: bool) -> str:
    lines = "\n".join(f"[{b.id}] ({b.start_s:.0f}s) {b.text}" for b in blocks)
    span = "the start" if is_first else "a middle part"
    if is_first and is_last:
        span = "the whole"
    return (
        "You classify a YouTube video's transcript for Breakpoint, which pauses programming "
        "tutorials at the right moments to give the learner a practice question.\n"
        f"Video title: {title}\n"
        f"Below is {span} of the transcript as blocks of about 20 seconds: [blockId] (start time) text.\n\n"
        "Split it into sections (contiguous block ranges, in order, not overlapping, covering the "
        "transcript; typically 2-15 minutes each, split where the topic changes).\n"
        "For each section:\n"
        "- format: code (writes/runs/reads code), theory (explains a CS idea, algorithm or concept "
        "without much code), mixed, or off_topic (intros, sponsors, channel news, career talk, chit-chat).\n"
        "- qualifies: true only if the section teaches or demonstrates something concrete the learner can "
        "do or reason about in code (writing, reading, debugging, testing, tracing an algorithm). A career "
        "vlog, news or opinion that only mentions code does NOT qualify. Music, gaming, cooking etc. never qualify.\n"
        "- Setup is NOT teaching: installing tools/libraries, downloading an IDE or editor, creating a "
        "project from a template, touring the generated files or the IDE, and typing or running the "
        "starter Hello World / first print just to check the setup works. Put such setup in its own "
        "section (split it from the teaching that follows, at the block where the instructor starts "
        "explaining a language idea such as variables, types or how a statement works), with "
        "qualifies false and no pauses. A section qualifies only once the instructor explains "
        "something the learner could practise in code beyond running the template.\n"
        f"- language: one of {', '.join(LANGUAGES)}. Use what the captions show (keywords, syntax read "
        "aloud, the language named). If the concept is clear but the language is not, use \"pseudocode\" "
        "for algorithm/theory content, else \"unknown\". languageEvidence quotes the words that show it.\n"
        f"- concepts: ids from this list only: {', '.join(concept_ids())}.\n"
        "- confidence: high / medium / low that your qualifies decision is right. Use low when the evidence is thin.\n"
        "- evidenceBlocks: 1-3 block ids whose words justify the decision.\n"
        "- pauses (only for qualifying sections, 0-3 each, empty otherwise): moments where an explanation "
        "is complete and a practice question would help. trigger question_posed when the instructor asks "
        "the viewer something or announces a challenge before showing the answer (answerBlock = where the "
        "answer starts, afterBlock must be before it); demonstration when the instructor builds or runs "
        "code (we will write a NEW problem with the same idea, so answerBlock is \"\"); concept_complete "
        "when a theory explanation has just finished. idea describes what to practise, e.g. \"loop that "
        "sums prices -> count scores above a threshold\". Never place a pause in the first 60 seconds.\n"
        "Return block ids exactly as written in the brackets.\n\n"
        f"{lines}\n"
    )


# ---------------------------------------------------------------------------
# Validated result
# ---------------------------------------------------------------------------


@dataclass
class Evidence:
    startS: float
    endS: float
    text: str

    def dump(self) -> dict:
        return {"startS": round(self.startS, 1), "endS": round(self.endS, 1), "text": self.text}


@dataclass
class PauseSlot:
    section_index: int
    pause_at_s: float
    reveal_at_s: float | None
    trigger: str
    concept: str
    idea: str
    importance: int
    id: str = ""
    rank: int = 3
    ask_start_s: float | None = None  # question_posed: start of the block where the task is asked
    screen: str = ""  # answer-on-screen check (screen.py): clear | moved | new_problem | unchecked | "" (not checked)


@dataclass
class Section:
    start_s: float
    end_s: float
    title: str
    format: str
    language: str
    concepts: list[str]
    qualifies: bool
    confidence: str
    evidence: list[Evidence]
    id: str = ""
    pauses: list[PauseSlot] = field(default_factory=list)

    def dump(self) -> dict:
        return {
            "id": self.id, "startS": round(self.start_s, 1), "endS": round(self.end_s, 1), "title": self.title,
            "qualifies": self.qualifies, "format": self.format, "language": self.language,
            "concepts": self.concepts, "evidence": [e.dump() for e in self.evidence],
        }


@dataclass
class WindowResult:
    about_programming: bool
    reason: str
    sections: list[Section]


def _evidence(block: Block) -> Evidence:
    text = block.text
    if len(text) > EVIDENCE_CHARS:
        text = text[: EVIDENCE_CHARS - 1].rsplit(" ", 1)[0] + "…"
    return Evidence(block.start_s, block.end_s, text)


def _question_end(block: Block) -> float:
    """End of the last cue in the block that asks something, else the block end."""
    for cue in reversed(block.cues):
        if "?" in cue.text or re.search(r"\b(try|pause the video|challenge|your turn)\b", cue.text, re.I):
            return cue.end_s
    return block.end_s


def validate_window(out: WindowOut, blocks: list[Block], next_start_s: float | None) -> WindowResult:
    """Check the model's answer against the real blocks; drop anything that does not hold."""
    index = {b.id: i for i, b in enumerate(blocks)}
    known = set(concept_ids())
    sections: list[Section] = []
    last_end = -1
    for so in out.sections:
        if so.startBlock not in index or so.endBlock not in index:
            logger.info("planner: dropping section with unknown block ids")
            continue
        a, z = index[so.startBlock], index[so.endBlock]
        if z < a:
            a, z = z, a
        a = max(a, last_end + 1)
        if a > z:
            continue
        last_end = z
        fmt = so.format if so.format in FORMATS else "off_topic"
        lang = so.language.strip().lower()
        lang = {"c++": "cpp", "c#": "csharp", "js": "javascript", "ts": "typescript", "golang": "go"}.get(lang, lang)
        if lang not in LANGUAGES:
            lang = "unknown"
        conf = so.confidence if so.confidence in ("high", "medium", "low") else "low"
        ev_ids = [e for e in so.evidenceBlocks if e in index and a <= index[e] <= z][:3]
        evidence = [_evidence(blocks[index[e]]) for e in dict.fromkeys(ev_ids)]
        qualifies = bool(so.qualifies) and fmt != "off_topic" and conf != "low" and bool(evidence)
        concepts = [c for c in dict.fromkeys(so.concepts) if c in known]
        end_s = blocks[z + 1].start_s if z + 1 < len(blocks) else (next_start_s or blocks[z].end_s)
        sec = Section(
            start_s=blocks[a].start_s, end_s=max(end_s, blocks[z].end_s), title=so.title.strip()[:80] or "Section",
            format=fmt, language=lang, concepts=concepts, qualifies=qualifies, confidence=conf,
            evidence=evidence or [_evidence(blocks[a])],
        )
        if qualifies:
            sec.pauses = _validate_pauses(so.pauses, blocks, index, a, z, len(sections), concepts, known)
        sections.append(sec)
    return WindowResult(bool(out.videoIsAboutProgramming), out.reason.strip()[:300], sections)


def _validate_pauses(
    pauses: list[PauseOut], blocks: list[Block], index: dict[str, int], a: int, z: int,
    section_index: int, section_concepts: list[str], known: set[str],
) -> list[PauseSlot]:
    slots: list[PauseSlot] = []
    for po in pauses[:3]:
        if po.afterBlock not in index or not a <= index[po.afterBlock] <= z:
            continue
        after = blocks[index[po.afterBlock]]
        trigger = po.trigger if po.trigger in TRIGGERS else "concept_complete"
        reveal: float | None = None
        pause_at = after.end_s
        if po.answerBlock and po.answerBlock in index:
            ans = index[po.answerBlock]
            if ans <= index[po.afterBlock]:
                if trigger == "question_posed":
                    continue  # answer is not after the pause point: can't pause before it
            else:
                reveal = blocks[ans].start_s
        if trigger == "question_posed":
            pause_at = _question_end(after)
        if reveal is not None:
            pause_at = min(pause_at, reveal - PAUSE_BEFORE_ANSWER_S)
        if pause_at < 60.0:
            continue
        concept = po.concept if po.concept in known else (section_concepts[0] if section_concepts else "")
        if not concept or not po.idea.strip():
            continue
        importance = po.importance if po.importance in (1, 2, 3) else 3
        slots.append(PauseSlot(section_index, round(pause_at, 1), round(reveal, 1) if reveal is not None else None,
                               trigger, concept, po.idea.strip()[:300], importance,
                               ask_start_s=after.start_s if trigger == "question_posed" else None))
    return slots


# ---------------------------------------------------------------------------
# Merge windows, rank and cap pauses
# ---------------------------------------------------------------------------


def pause_cap(duration_s: float) -> int:
    """At most one pause per ~6 minutes of video, 2..30 per window."""
    return max(2, min(30, math.ceil(duration_s / 360.0)))


@dataclass
class Numberer:
    """Numbers sections/pauses and ranks pauses window by window, so ids stay stable
    while later windows are still being classified (earliest pauses are ready first).

    rank 1: the most important pause of each qualifying section, spaced >= 5 min apart;
    rank 2: other importance-1/2 pauses; rank 3: the rest. Each window keeps at most
    ``pause_cap(window length)`` pauses, best-ranked first, and pauses are >= 60 s apart.
    """

    next_section: int = 1
    next_pause: int = 1
    last_rank1_s: float = -1e9
    last_pause_s: float = -1e9

    def add(self, sections: list[Section], window_s: float) -> list[PauseSlot]:
        for i, s in enumerate(sections):
            s.id = f"s{self.next_section + i}"
        slots = sorted(
            ((i, p) for i, s in enumerate(sections) for p in s.pauses), key=lambda t: t[1].pause_at_s
        )
        spaced: list[tuple[int, PauseSlot]] = []
        last = self.last_pause_s
        for i, p in slots:
            if p.pause_at_s - last < MIN_PAUSE_GAP_S:
                # Too close to the previous pause: keep the more important one (moving
                # later only widens the gap to the pause before it).
                if spaced and p.importance < spaced[-1][1].importance:
                    spaced[-1] = (i, p)
                    last = p.pause_at_s
                continue
            spaced.append((i, p))
            last = p.pause_at_s
        by_section: dict[int, list[PauseSlot]] = {}
        for i, p in spaced:
            by_section.setdefault(i, []).append(p)
        for i in sorted(by_section):
            best = min(by_section[i], key=lambda p: (p.importance, p.pause_at_s))
            for p in by_section[i]:
                if p is best and p.pause_at_s - self.last_rank1_s >= 300.0:
                    p.rank = 1
                    self.last_rank1_s = p.pause_at_s
                else:
                    p.rank = 2 if p.importance <= 2 else 3
        kept = sorted((p for _, p in spaced), key=lambda p: (p.rank, p.importance, p.pause_at_s))[: pause_cap(window_s)]
        kept.sort(key=lambda p: p.pause_at_s)
        for p in kept:
            p.id = f"p{self.next_pause}"
            self.next_pause += 1
        keep = {id(p) for p in kept}
        for i, s in enumerate(sections):
            s.pauses = [p for p in s.pauses if id(p) in keep]
            for p in s.pauses:
                p.section_index = self.next_section - 1 + i
        self.next_section += len(sections)
        if kept:
            self.last_pause_s = kept[-1].pause_at_s
        return kept
