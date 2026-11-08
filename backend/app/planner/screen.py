"""Goal 6: is the answer already on screen at a pause? (YouTube storyboard thumbnails.)

A ``question_posed`` pause sits before the spoken answer, but instructors often type the
solution while they ask. Before such a pause is accepted we look at the storyboard frames
from the start of the asking block up to the first frame after the pause and ask a vision
model, per frame, whether the answer to the posed task is visible (solution code, or output
that gives it away).

* No frame shows it -> the pause stays (``screen = "clear"``).
* It shows from frame k on -> the pause moves to frame k-1 when that frame is clear and still
  inside the asking block (``"moved"``); otherwise the pause becomes a NEW problem on the same
  idea at the same time (trigger ``demonstration``, ``"new_problem"``), because the learner
  would see the answer to the instructor's own task.
* No storyboard, a failed fetch or a failed model call -> the pause is kept as before
  (``"unchecked"``). ``demonstration`` / ``concept_complete`` pauses already ask a new problem and
  are not checked.

Storyboard spec (``playerStoryboardSpecRenderer.spec`` on the watch page):
``<url with $L and $N>|<level 0>|<level 1>|...``, each level ``w#h#count#cols#rows#intervalMs#name#sigh``.
Frame ``k`` is at about ``k * interval``; sheet ``k // (cols*rows)`` holds it at tile ``k % (cols*rows)``
(row-major). We use the largest level (160x90 on long videos, readable for zoomed-in code).
"""

from __future__ import annotations

import asyncio
import base64
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Protocol

import httpx
from pydantic import BaseModel, Field, ValidationError

from .classify import PauseSlot

logger = logging.getLogger("breakpoint.planner")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0 Safari/537.36")
FETCH_TIMEOUT_S = 10.0
MAX_SHEET_BYTES = 2 * 1024 * 1024
MAX_PAGE_BYTES = 8 * 1024 * 1024
MAX_FRAMES = 12
BOARD_TTL_S = 6 * 3600.0
MAX_BOARDS = 64


@dataclass(frozen=True)
class Board:
    """The largest storyboard level of one video."""

    base: str
    level: int
    width: int
    height: int
    count: int
    cols: int
    rows: int
    interval_s: float
    name: str
    sigh: str

    @property
    def per_sheet(self) -> int:
        return self.cols * self.rows

    def frame_at(self, t: float) -> int:
        return max(0, min(self.count - 1, int(t // self.interval_s)))

    def time_of(self, k: int) -> float:
        return k * self.interval_s

    def sheet_url(self, sheet: int) -> str:
        url = self.base.replace("$L", str(self.level)).replace("$N", self.name.replace("$M", str(sheet)))
        return f"{url}{'&' if '?' in url else '?'}sigh={self.sigh}" if self.sigh else url


def parse_spec(spec: str, duration_s: float | None = None) -> Board | None:
    spec = spec.replace("\\u0026", "&")
    parts = spec.split("|")
    if len(parts) < 2 or not parts[0].startswith("https://"):
        return None
    for level in range(len(parts) - 1, 0, -1):
        f = parts[level].split("#")
        if len(f) < 7:
            continue
        try:
            w, h, count, cols, rows, iv = (int(x) for x in f[:6])
        except ValueError:
            continue
        if count <= 0 or cols <= 0 or rows <= 0:
            continue
        interval = iv / 1000.0 if iv > 0 else ((duration_s or 0) / count)
        if interval <= 0:
            continue
        return Board(parts[0], level - 1, w, h, count, cols, rows, interval, f[6], f[7] if len(f) > 7 else "")
    return None


class Boards(Protocol):
    async def board(self, video_id: str) -> Board | None: ...
    async def sheet(self, board: Board, sheet: int) -> bytes | None: ...


@dataclass
class StoryboardFetcher:
    """Reads the storyboard spec from the watch page and downloads sheets. Inject ``client`` in tests."""

    client: httpx.AsyncClient | None = None
    clock: Callable[[], float] = time.monotonic
    _boards: dict[str, tuple[float, Board | None]] = field(default_factory=dict)

    def _http(self) -> httpx.AsyncClient:
        if self.client is None:
            self.client = httpx.AsyncClient(timeout=httpx.Timeout(FETCH_TIMEOUT_S), follow_redirects=True,
                                            trust_env=False)
        return self.client

    async def board(self, video_id: str) -> Board | None:
        hit = self._boards.get(video_id)
        if hit and hit[0] > self.clock():
            return hit[1]
        resp = await self._http().get(f"https://www.youtube.com/watch?v={video_id}",
                                      headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
        if resp.status_code >= 400 or len(resp.content) > MAX_PAGE_BYTES:
            return None  # not cached: a later pause may try again
        html = resp.text
        m = re.search(r'"playerStoryboardSpecRenderer":\{"spec":"([^"]+)"', html)
        dur = re.search(r'"lengthSeconds":"(\d+)"', html)
        board = parse_spec(m.group(1), float(dur.group(1)) if dur else None) if m else None
        self._boards[video_id] = (self.clock() + BOARD_TTL_S, board)
        while len(self._boards) > MAX_BOARDS:
            self._boards.pop(next(iter(self._boards)))
        return board

    async def sheet(self, board: Board, sheet: int) -> bytes | None:
        resp = await self._http().get(board.sheet_url(sheet), headers={"User-Agent": UA})
        if resp.status_code >= 400 or len(resp.content) > MAX_SHEET_BYTES:
            return None
        if image_type(resp.content) is None:
            return None  # not a JPEG/WebP image
        return resp.content


# ---------------------------------------------------------------------------
# Vision check
# ---------------------------------------------------------------------------


class TileOut(BaseModel):
    tile: int = Field(description="tile number as listed in the prompt")
    answerVisible: bool = Field(description="true if this frame shows the answer/solution to the task")
    seen: str = Field(description="what the frame shows, in at most 12 words")


class ScreenOut(BaseModel):
    tiles: list[TileOut]


VisionCall = Callable[[str, bytes, type[BaseModel]], Awaitable[str]]  # (prompt, jpeg, schema) -> json text


def screen_prompt(board: Board, tiles: list[tuple[int, float]], task: str, asked: str, pause_s: float) -> str:
    listing = "\n".join(
        f"- tile {n}: row {(n - 1) // board.cols + 1}, column {(n - 1) % board.cols + 1}, video time {_mmss(t)}"
        for n, t in tiles)
    return (
        "The image is a YouTube storyboard: a grid of video frames, "
        f"{board.cols} columns x {board.rows} rows, read left to right, top to bottom (tile 1 is top-left). "
        f"Each frame is {board.interval_s:g} s after the previous one.\n"
        "A programming tutorial will pause at "
        f"{_mmss(pause_s)} and ask the learner to solve the task the instructor just posed:\n"
        f"Task: {task}\nWhat the instructor said while asking: \"{asked}\"\n"
        "For each tile below, say whether the frame already shows the answer: finished solution code for this "
        "task, or program output / slide text that gives the answer away. Code that only sets up the task "
        "(inputs, a function header, an empty body, unrelated earlier code) is NOT the answer. A face, slide "
        "title or blank editor is not the answer. If the text is unreadable, answer false.\n"
        f"{listing}\nReturn one entry per listed tile."
    )


def _mmss(t: float) -> str:
    t = int(t)
    return f"{t // 3600}:{t // 60 % 60:02d}:{t % 60:02d}" if t >= 3600 else f"{t // 60}:{t % 60:02d}"


@dataclass
class ScreenCheck:
    boards: Boards
    vision: VisionCall
    concurrency: int = 3
    _sem: asyncio.Semaphore | None = None

    async def check(self, video_id: str, slot: PauseSlot, asked: str) -> None:
        """Move or convert ``slot`` in place when its answer is already on screen."""
        if slot.trigger != "question_posed" or slot.ask_start_s is None:
            return
        if self._sem is None:
            self._sem = asyncio.Semaphore(self.concurrency)
        async with self._sem:
            try:
                verdict = await self._frames(video_id, slot, asked)
            except Exception as exc:  # provider/network trouble: keep today's behaviour
                logger.info("planner screen video=%s pause_at=%s unchecked (%s)", video_id, slot.pause_at_s,
                            type(exc).__name__)
                verdict = None
        if verdict is None:
            slot.screen = "unchecked"
            return
        board, visible = verdict
        apply_verdict(slot, board, visible)
        logger.info("planner screen video=%s pause_at=%s screen=%s", video_id, slot.pause_at_s, slot.screen)

    async def _frames(self, video_id: str, slot: PauseSlot, asked: str) -> tuple[Board, dict[int, bool]] | None:
        board = await self.boards.board(video_id)
        if board is None:
            return None
        assert slot.ask_start_s is not None
        k0 = board.frame_at(slot.ask_start_s)
        k1 = min(board.count - 1, board.frame_at(slot.pause_at_s) + 1)
        k0 = max(k0, k1 - MAX_FRAMES + 1)
        by_sheet: dict[int, list[int]] = {}
        for k in range(k0, k1 + 1):
            by_sheet.setdefault(k // board.per_sheet, []).append(k)
        visible: dict[int, bool] = {}
        for sheet, ks in sorted(by_sheet.items()):
            jpeg = await self.boards.sheet(board, sheet)
            if jpeg is None:
                return None
            tiles = [(k % board.per_sheet + 1, board.time_of(k)) for k in ks]
            prompt = screen_prompt(board, tiles, slot.idea, asked[:600], slot.pause_at_s)
            out = await self._ask(prompt, jpeg)
            if out is None:
                return None
            got = {t.tile: t.answerVisible for t in out.tiles}
            for k in ks:
                visible[k] = got.get(k % board.per_sheet + 1, True)  # missing tile: assume visible (safe side)
        return board, visible

    async def _ask(self, prompt: str, jpeg: bytes) -> ScreenOut | None:
        for _ in (1, 2):
            text = await self.vision(prompt, jpeg, ScreenOut)
            try:
                return ScreenOut.model_validate_json(text)
            except ValidationError:
                continue
        return None


def apply_verdict(slot: PauseSlot, board: Board, visible: dict[int, bool]) -> None:
    shown = sorted(k for k, v in visible.items() if v)
    if not shown:
        slot.screen = "clear"
        return
    first = shown[0]
    prev = first - 1
    assert slot.ask_start_s is not None
    if prev in visible and not visible[prev] and board.time_of(prev) >= slot.ask_start_s and board.time_of(prev) >= 60.0:
        slot.pause_at_s = round(min(slot.pause_at_s, board.time_of(prev)), 1)
        slot.screen = "moved"
    else:
        slot.trigger = "demonstration"  # the learner would see the answer: ask a new problem on the same idea
        slot.screen = "new_problem"


def image_type(data: bytes) -> str | None:
    """Sheets are JPEG, or WebP when YouTube sees a Chrome user agent."""
    if data.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def image_block(data: bytes) -> dict:
    return {"type": "image", "source": {"type": "base64", "media_type": image_type(data) or "image/jpeg",
                                         "data": base64.b64encode(data).decode("ascii")}}


