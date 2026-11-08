"""Lane A1 Goal 6: answer-already-on-screen check with storyboard frames (offline, stubbed)."""

from __future__ import annotations

import asyncio
import json
import re

import httpx

from app.planner.classify import PauseSlot
from app.planner.generate import QuestionOut
from app.planner.screen import Board, ScreenCheck, ScreenOut, StoryboardFetcher, apply_verdict, parse_spec
from app.planner.service import Planner, PlanStore
from app.testme import GenOutput
from tests.test_planner import StubModel, make_transcript

# Shape of a real spec (rfscVS0vtbw, 4 h 27 min), signatures shortened.
SPEC = ("https://i.ytimg.com/sb/vid/storyboard3_L$L/$N.jpg?sqp=abc"
        "|48#27#100#10#10#0#default#rs$AAA|80#45#1603#10#10#10000#M$M#rs$BBB|160#90#1603#5#5#10000#M$M#rs$CCC")


def board(**kw) -> Board:
    return Board(**{"base": "https://i.ytimg.com/sb/v/storyboard3_L$L/$N.jpg?sqp=x", "level": 2, "width": 160,
                    "height": 90, "count": 500, "cols": 5, "rows": 5, "interval_s": 10.0, "name": "M$M",
                    "sigh": "rs$C", **kw})


def test_parse_spec_picks_largest_level_and_builds_sheet_urls():
    b = parse_spec(SPEC, 16012)
    assert b is not None and (b.level, b.width, b.height, b.cols, b.rows, b.interval_s) == (2, 160, 90, 5, 5, 10.0)
    k = b.frame_at(3338)  # calculator pause in rfscVS0vtbw
    assert (k, k // b.per_sheet, k % b.per_sheet) == (333, 13, 8)
    assert b.sheet_url(13) == "https://i.ytimg.com/sb/vid/storyboard3_L2/M13.jpg?sqp=abc&sigh=rs$CCC"
    # level 0 has interval 0: derived from the duration
    only0 = parse_spec("https://x/sb/$L/$N.jpg?a=1|48#27#100#10#10#0#default#rs$A", 1000)
    assert only0 is not None and only0.interval_s == 10.0 and only0.sheet_url(0).endswith("/0/default.jpg?a=1&sigh=rs$A")
    assert parse_spec("garbage") is None
    assert parse_spec("https://x/$L/$N.jpg|1#2", 100) is None


def q_slot(pause=415.0, ask=400.0) -> PauseSlot:
    return PauseSlot(0, pause, 420.0, "question_posed", "loops", "sum 1..n", 1, ask_start_s=ask)


def test_verdict_clear_moved_new_problem():
    b = board()
    s = q_slot()
    apply_verdict(s, b, {40: False, 41: False, 42: False})
    assert (s.screen, s.pause_at_s, s.trigger) == ("clear", 415.0, "question_posed")

    s = q_slot()  # typed between 400 and 410: pause at the last clear frame
    apply_verdict(s, b, {40: False, 41: True, 42: True})
    assert (s.screen, s.pause_at_s, s.trigger) == ("moved", 400.0, "question_posed")

    s = q_slot()  # visible only on the frame after the pause: it may already show at 415
    apply_verdict(s, b, {40: False, 41: False, 42: True})
    assert (s.screen, s.pause_at_s) == ("moved", 410.0)

    s = q_slot(ask=405.0)  # visible from the first frame, or the clear frame is before the question block
    apply_verdict(s, b, {40: False, 41: True, 42: True})
    assert (s.screen, s.pause_at_s, s.trigger) == ("new_problem", 415.0, "demonstration")


class StubBoards:
    def __init__(self, board: Board | None = None, fail=False):
        self.b, self.fail, self.sheets = board, fail, []

    async def board(self, video_id):
        if self.fail:
            raise httpx.ConnectError("offline")
        return self.b

    async def sheet(self, b, n):
        self.sheets.append(n)
        return b"\xff\xd8fake"


class StubVision:
    """Marks frames from ``first_visible_s`` on as showing the answer."""

    def __init__(self, first_visible_s: float | None, b: Board):
        self.first, self.b, self.prompts = first_visible_s, b, []

    async def __call__(self, prompt, jpeg, model):
        assert model is ScreenOut and jpeg.startswith(b"\xff\xd8")
        self.prompts.append(prompt)
        tiles = []
        for n, mm, ss in re.findall(r"tile (\d+): row \d+, column \d+, video time (\d+):(\d+)", prompt):
            t = int(mm) * 60 + int(ss)
            tiles.append({"tile": int(n), "answerVisible": self.first is not None and t >= self.first, "seen": "code"})
        return json.dumps({"tiles": tiles})


def planner_with(tmp_path, screen: ScreenCheck | None, model=None) -> Planner:
    t = make_transcript()

    async def fetch(video_id):
        return t

    async def verify(ex):
        return True

    return Planner(fetch_transcript=fetch, model_call=model or StubModel(), verify=verify, store=PlanStore(tmp_path),
                   screen_check=screen)


async def ready(p: Planner) -> dict:
    p.request("vidPlanner1", "beginner-1")
    await p.wait_idle()
    return p.request("vidPlanner1", "beginner-1")


def q_pause(plan):
    return next(x for x in plan["pauses"] if x["sectionId"] == "s2" and x["revealAtS"] is not None)


def test_answer_typed_while_asking_moves_pause_earlier(tmp_path):
    b = board()
    vision = StubVision(410.0, b)
    p = planner_with(tmp_path, ScreenCheck(StubBoards(b), vision))
    plan = asyncio.run(ready(p))
    q = q_pause(plan)
    assert q["pauseAtS"] == 400.0 and q["revealAtS"] == 420.0 and q["kind"] == "coding"
    assert len(vision.prompts) == 1  # only the question_posed pause is checked
    assert "sum the numbers 1..n" in vision.prompts[0] and "can you write a function" in vision.prompts[0]
    saved = json.loads((tmp_path / "vidPlanner1.json").read_text())
    slot = next(x for s in saved["sections"] for x in s["pauses"] if x["reveal_at_s"] == 420.0)
    assert slot["screen"] == "moved" and slot["pause_at_s"] == 400.0 and slot["ask_start_s"] == 400.0


def test_answer_on_screen_throughout_becomes_new_problem(tmp_path):
    b = board()
    model = StubModel()
    p = planner_with(tmp_path, ScreenCheck(StubBoards(b), StubVision(0.0, b)), model)
    plan = asyncio.run(ready(p))
    q = q_pause(plan)
    assert q["pauseAtS"] == 415.0  # same time, but a new problem on the same idea
    gen = [pr for n, pr in model.calls if n == GenOutput.__name__]
    assert gen and all("NEW problem" in pr for pr in gen)
    assert not any("posed this task" in pr for pr in gen)
    assert model.count(QuestionOut.__name__) >= 1


def test_clear_screen_or_failed_check_keeps_the_pause(tmp_path):
    b = board()
    plan = asyncio.run(ready(planner_with(tmp_path / "a", ScreenCheck(StubBoards(b), StubVision(None, b)))))
    assert q_pause(plan)["pauseAtS"] == 415.0
    plan = asyncio.run(ready(planner_with(tmp_path / "b", ScreenCheck(StubBoards(fail=True), StubVision(0.0, b)))))
    assert q_pause(plan)["pauseAtS"] == 415.0
    plan = asyncio.run(ready(planner_with(tmp_path / "c", ScreenCheck(StubBoards(None), StubVision(0.0, b)))))
    assert q_pause(plan)["pauseAtS"] == 415.0
    saved = json.loads((tmp_path / "c" / "vidPlanner1.json").read_text())
    assert any(x["screen"] == "unchecked" for s in saved["sections"] for x in s["pauses"])


def test_storyboard_fetcher_reads_spec_and_sheet():
    page = ('<html>"lengthSeconds":"16012" ... "playerStoryboardSpecRenderer":{"spec":"'
            + SPEC.replace("&", "\\u0026") + '","recommendedLevel":2}</html>')
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(str(req.url))
        if req.url.host == "www.youtube.com":
            return httpx.Response(200, text=page)
        return httpx.Response(200, content=b"\xff\xd8\xff\xe0jpeg")

    async def go():
        f = StoryboardFetcher(httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        b = await f.board("rfscVS0vtbw")
        again = await f.board("rfscVS0vtbw")
        jpeg = await f.sheet(b, 13)
        return b, again, jpeg

    b, again, jpeg = asyncio.run(go())
    assert b == again and b.width == 160 and jpeg.startswith(b"\xff\xd8")
    assert sum("youtube.com/watch" in u for u in seen) == 1  # spec cached per video
    assert seen[-1].startswith("https://i.ytimg.com/sb/vid/storyboard3_L2/M13.jpg")
