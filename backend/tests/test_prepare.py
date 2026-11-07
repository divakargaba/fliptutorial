"""Prep pipeline tests (PRD §8 prep rows). Gemini is always stubbed."""

from __future__ import annotations

import copy
import json
import math
import shutil
from pathlib import Path

import pytest

from app import prepare
from app.catalog import Catalog
from app.prepare import PrepError

BACKEND = Path(__file__).resolve().parent.parent
REAL_REVIEWED = BACKEND / "content" / "reviewed" / "rfscVS0vtbw.json"
REAL_APPROVED = BACKEND / "content" / "approved" / "rfscVS0vtbw.json"
REAL_TRANSCRIPT = BACKEND / "content" / "transcripts" / "rfscVS0vtbw.json"
VID = "rfscVS0vtbw"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _cue(start: float, end: float, text: str, cid: str | None = None) -> dict:
    cue = {"start_s": start, "end_s": end, "text": text}
    if cid:
        cue["id"] = cid
    return cue


VALID_CUES = [
    _cue(100.0, 105.0, "Let's write a function that raises a number to a power.", "c00100000"),
    _cue(105.0, 110.0, "def raise_to_power(base_num, pow_num): and a colon.", "c00105000"),
    _cue(110.0, 115.0, "Try to think how a for loop could do this.", "c00110000"),
    _cue(115.0, 120.0, "So I'll make a variable called result equal to one.", "c00115000"),
    _cue(120.0, 125.0, "Then loop pow_num times multiplying result.", "c00120000"),
]


@pytest.fixture()
def workspace(tmp_path: Path) -> dict[str, Path]:
    content = tmp_path / "content"
    (content / "transcripts").mkdir(parents=True)
    (content / "transcripts" / f"{VID}.json").write_text(
        json.dumps({"cues": VALID_CUES}), encoding="utf-8"
    )
    seeds = content / "seeds.json"
    seeds.write_text(
        json.dumps(
            {
                "videos": [
                    {
                        "videoId": VID,
                        "title": "Test course",
                        "url": f"https://www.youtube.com/watch?v={VID}",
                        "transcriptPath": f"transcripts/{VID}.json",
                        "scanWindows": [{"id": "w", "label": "Exponent", "startS": 95, "endS": 130}],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    reviewed = content / "reviewed"
    reviewed.mkdir()
    shutil.copy(REAL_REVIEWED, reviewed / f"{VID}.json")
    return {
        "content": content,
        "seeds": seeds,
        "drafts": content / "drafts",
        "reviewed": reviewed,
        "approved": content / "approved",
    }


def _candidate(**over) -> dict:
    base = {
        "title": "Raise a number to a power",
        "task": "Write raise_to_power(base_num, pow_num) using a loop.",
        "inputs": "two integers",
        "expectedOutput": "integer",
        "functionName": "raise_to_power",
        "setupEndCueId": "c00105000",
        "spokenRevealCueId": "c00115000",
        "language": "python",
        "languageEvidence": "def syntax with a colon",
        "conceptTags": ["loops", "functions"],
    }
    base.update(over)
    return base


def stub(*candidates: dict):
    calls: list[str] = []

    def detect(prompt: str) -> str:
        calls.append(prompt)
        return json.dumps({"candidates": list(candidates)})

    detect.calls = calls  # type: ignore[attr-defined]
    return detect


def run_scan(ws, detector):
    return prepare.scan(
        VID, detector, seeds_path=ws["seeds"], content_dir=ws["content"], drafts_dir=ws["drafts"]
    )


def read_draft(ws) -> dict:
    return json.loads((ws["drafts"] / f"{VID}.scan.json").read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Transcript validation
# ---------------------------------------------------------------------------


def test_valid_python_transcript_scans_to_candidate(workspace):
    detector = stub(_candidate())
    out = run_scan(workspace, detector)
    draft = json.loads(out.read_text(encoding="utf-8"))
    [cand] = draft["candidates"]
    assert cand["status"] == "candidate"
    assert cand["setupEndS"] == 110.0
    assert cand["firstSpokenRevealS"] == 115.0
    assert cand["reviewClip"]["url"].endswith(VID)
    # Prompt carries cue ids so timestamps trace back to the transcript.
    assert "[c00105000]" in detector.calls[0]


def test_real_transcript_excerpt_is_valid():
    cues = prepare.parse_transcript(json.loads(REAL_TRANSCRIPT.read_text(encoding="utf-8")))
    assert cues[0].start_s <= 9680 and cues[-1].end_s >= 10033
    ids = {c.id for c in cues}
    assert {"c09755320", "c09805320"} <= ids


def test_missing_transcript_file(workspace):
    (workspace["content"] / "transcripts" / f"{VID}.json").unlink()
    with pytest.raises(PrepError) as e:
        run_scan(workspace, stub(_candidate()))
    assert e.value.code == "TRANSCRIPT_UNAVAILABLE"


@pytest.mark.parametrize(
    "cues",
    [
        [],
        [_cue(10, 12, "a"), _cue(5, 6, "b")],  # out of order
        [{"end_s": 3, "text": "no start"}],
        [_cue(10, 8, "end before start")],
        [_cue(math.inf, math.inf, "nonfinite")],
        [_cue(1, 2, "   ")],
        [_cue(1, 2, "a", "dup"), _cue(3, 4, "b", "dup")],
    ],
    ids=["empty", "out-of-order", "missing-start", "end-before-start", "nonfinite", "empty-text", "dup-id"],
)
def test_invalid_transcript(cues):
    with pytest.raises(PrepError) as e:
        prepare.parse_transcript({"cues": cues})
    assert e.value.code == "INVALID_TRANSCRIPT"


def test_stable_cue_ids_assigned():
    cues = prepare.parse_transcript([_cue(9677.32, 9684.32, "x")])
    assert cues[0].id == "c09677320"
    assert prepare.parse_transcript([_cue(9677.32, 9684.32, "x")])[0].id == cues[0].id


def test_long_window_uses_overlapping_chunks():
    chunks = prepare.window_chunks(0, 700)
    assert chunks[0] == (0, 300)
    assert all(b[0] < a[1] for a, b in zip(chunks, chunks[1:]))  # overlap
    assert chunks[-1][1] == 700


# ---------------------------------------------------------------------------
# Model output validation
# ---------------------------------------------------------------------------


def test_invalid_model_cue_ids_are_held(workspace):
    with pytest.raises(PrepError) as e:
        run_scan(workspace, stub(_candidate(spokenRevealCueId="c99999999")))
    assert e.value.code == "NO_USABLE_CANDIDATE"
    [cand] = read_draft(workspace)["candidates"]
    assert cand["status"] == "held"
    assert "not in the supplied excerpt" in cand["reasons"][0]


def test_unknown_language_is_unsupported(workspace):
    with pytest.raises(PrepError) as e:
        run_scan(workspace, stub(_candidate(language="klingon")))
    assert e.value.code == "NO_USABLE_CANDIDATE"
    [cand] = read_draft(workspace)["candidates"]
    assert cand["status"] == "unsupported" and cand["language"] == "unknown"


def test_java_candidate_is_not_publishable(workspace):
    with pytest.raises(PrepError):
        run_scan(workspace, stub(_candidate(language="java")))
    assert read_draft(workspace)["candidates"][0]["status"] == "unsupported"


def test_setup_overlapping_reveal_is_held(workspace):
    with pytest.raises(PrepError):
        run_scan(workspace, stub(_candidate(setupEndCueId="c00115000", spokenRevealCueId="c00105000")))
    assert "overlaps" in read_draft(workspace)["candidates"][0]["reasons"][0]


def test_zero_candidates_is_an_error(workspace):
    with pytest.raises(PrepError) as e:
        run_scan(workspace, stub())
    assert e.value.code == "NO_USABLE_CANDIDATE"


@pytest.mark.parametrize("text", ["not json", "{}", '{"candidates": [{"title": "x"}]}'])
def test_invalid_structured_response(workspace, text):
    with pytest.raises(PrepError) as e:
        run_scan(workspace, lambda prompt: text)
    assert e.value.code == "INVALID_DRAFT"


def test_provider_failure(workspace):
    def boom(prompt):
        raise PrepError("PREP_PROVIDER_ERROR", "unavailable")

    with pytest.raises(PrepError) as e:
        run_scan(workspace, boom)
    assert e.value.code == "PREP_PROVIDER_ERROR"


def test_missing_key_is_provider_error(monkeypatch, tmp_path):
    monkeypatch.setattr(prepare, "BACKEND_DIR", tmp_path)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with pytest.raises(PrepError) as e:
        prepare.gemini_detector()
    assert e.value.code == "PREP_PROVIDER_ERROR"


def test_unknown_tags_dropped_and_spoiler_tags_internal(workspace):
    run_scan(workspace, stub(_candidate(conceptTags=["loops", "hash-map", "wizardry"])))
    cand = read_draft(workspace)["candidates"][0]
    assert cand["conceptTags"] == ["loops", "hash-map"]
    assert cand["internalTags"] == ["hash-map"]
    assert cand["droppedTags"] == ["wizardry"]


def test_duplicate_candidates_from_overlapping_chunks_deduped(workspace):
    run_scan(workspace, stub(_candidate(), _candidate(title="same again")))
    assert len(read_draft(workspace)["candidates"]) == 1


# ---------------------------------------------------------------------------
# Timing
# ---------------------------------------------------------------------------


def test_spoken_reveal_before_visual():
    t = prepare.compute_timing(0, 100, 10, 50, 53)
    assert t == {"revealAtS": 50.0, "pauseAtS": 48.0}


def test_visual_reveal_before_spoken():
    t = prepare.compute_timing(0, 100, 10, 60, 55)
    assert t == {"revealAtS": 55.0, "pauseAtS": 53.0}


def test_null_reveal_channel_allowed():
    assert prepare.compute_timing(0, 100, 10, None, 30)["revealAtS"] == 30.0


def test_tight_setup_pauses_at_setup_end():
    # setup 1.5 s before reveal: pause at setup end (still >= 1 s lead).
    assert prepare.compute_timing(0, 100, 48.5, 50, None)["pauseAtS"] == 48.5


@pytest.mark.parametrize(
    "args",
    [
        (0, 100, 10, None, None),  # missing reveal
        (0, 100, 50, 50, None),  # setup == reveal (overlap)
        (0, 100, 60, 50, None),  # setup after reveal
        (0, 100, 49.5, 50, None),  # no safe window (< 1 s lead)
        (20, 100, 10, 50, None),  # setup before window start
        (0, 40, 10, 50, None),  # reveal after window end
        (0, 100, math.nan, 50, None),
        (0, 100, 10, math.inf, None),
        (None, 100, 10, 50, None),
    ],
)
def test_unsafe_timing_rejected(args):
    with pytest.raises(PrepError) as e:
        prepare.compute_timing(*args)
    assert e.value.code == "INVALID_TIMING"


def test_clipping_offset_normalized_once():
    assert prepare.normalize_video_time(20.0, "clip", 9740.0) == 9760.0
    assert prepare.normalize_video_time(9760.0, "video") == 9760.0
    with pytest.raises(PrepError):
        prepare.normalize_video_time(20.0, "", 9740.0)  # basis required


def test_real_reviewed_timing_is_safe():
    bp = json.loads(REAL_REVIEWED.read_text(encoding="utf-8"))["breakpoints"][0]
    t = prepare.compute_timing(
        bp["windowStartS"], bp["windowEndS"], bp["setupEndS"], bp["firstSpokenRevealS"], bp["firstVisualRevealS"]
    )
    assert t["pauseAtS"] == bp["pauseAtS"] and t["revealAtS"] == bp["revealAtS"]


# ---------------------------------------------------------------------------
# Verify and publish
# ---------------------------------------------------------------------------


def _verify(ws):
    return prepare.verify(VID, reviewed_dir=ws["reviewed"], drafts_dir=ws["drafts"])


def _publish(ws):
    return prepare.publish(
        VID, reviewed_dir=ws["reviewed"], drafts_dir=ws["drafts"], approved_dir=ws["approved"]
    )


def _edit_reviewed(ws, fn):
    path = ws["reviewed"] / f"{VID}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    fn(data)
    path.write_text(json.dumps(data), encoding="utf-8")


def test_real_exercise_covers_required_hidden_cases():
    bps = json.loads(REAL_REVIEWED.read_text(encoding="utf-8"))["breakpoints"]
    ex = next(bp["exercise"] for bp in bps if bp["exercise"]["functionName"] == "raise_to_power")
    args = [tuple(h["args"]) for h in ex["hiddenTests"]]
    assert any(p == 0 for _, p in args)  # zero exponent
    assert any(b == 0 and p > 0 for b, p in args)  # zero base, positive exponent
    assert any(b < 0 and p % 2 == 1 for b, p in args)  # negative base, odd exponent


def test_verify_then_publish_matches_existing_approved(workspace):
    _verify(workspace)
    out = _publish(workspace)
    published = json.loads(out.read_text(encoding="utf-8"))
    existing = json.loads(REAL_APPROVED.read_text(encoding="utf-8"))
    assert published == existing  # same digest and revision as the shipped file
    catalog = Catalog(workspace["approved"])
    public = catalog.get_public(VID).model_dump_json()
    assert "hiddenTests" not in public and "referenceSolution" not in public


def test_publish_requires_verify(workspace):
    with pytest.raises(PrepError) as e:
        _publish(workspace)
    assert e.value.code == "NOT_VERIFIED"


def test_publish_rejects_edits_after_verify(workspace):
    _verify(workspace)
    _edit_reviewed(workspace, lambda d: d["breakpoints"][0]["exercise"]["hiddenTests"].append(
        {"args": [2, 2], "expected": 4}))
    with pytest.raises(PrepError) as e:
        _publish(workspace)
    assert e.value.code == "NOT_VERIFIED"


def test_review_notes_do_not_change_digest(workspace):
    first = json.loads(_verify(workspace).read_text())["approvedDigest"]
    _edit_reviewed(workspace, lambda d: d.update(reviewNote="reworded"))
    assert json.loads(_verify(workspace).read_text())["approvedDigest"] == first


def test_wrong_reference_fails_verify(workspace):
    _edit_reviewed(workspace, lambda d: d["breakpoints"][0]["exercise"].update(
        referenceSolution="def add_numbers(a, b):\n    return a * b\n"))
    with pytest.raises(PrepError) as e:
        _verify(workspace)
    assert e.value.code == "VERIFY_FAILED"


def test_wrong_solution_that_passes_fails_verify(workspace):
    _edit_reviewed(workspace, lambda d: d["breakpoints"][0]["exercise"].update(
        knownWrongSolution="def add_numbers(a, b):\n    return a + b\n"))
    with pytest.raises(PrepError) as e:
        _verify(workspace)
    assert e.value.code == "VERIFY_FAILED"


def test_bool_does_not_match_int(workspace):
    _edit_reviewed(workspace, lambda d: d["breakpoints"][0]["exercise"]["hiddenTests"].append(
        {"args": [1, 1], "expected": True}))
    with pytest.raises(PrepError) as e:
        _verify(workspace)
    assert e.value.code == "VERIFY_FAILED"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d["breakpoints"][0].update(pauseAtS=9805.0),  # disagrees with computed pause
        lambda d: d["breakpoints"][0].update(setupEndS=9804.9),  # no safe window
        lambda d: d["breakpoints"][0].update(firstSpokenRevealS=None, firstVisualRevealS=None),
        lambda d: d["breakpoints"][0]["exercise"].update(hiddenTests=[{"args": [1, 1], "expected": 1}]),
        lambda d: d["breakpoints"][0]["exercise"].update(language="java"),
        lambda d: d["breakpoints"][0]["exercise"].update(conceptTags=["made-up"]),
        lambda d: d.update(videoId="aaaaaaaaaaa"),
        lambda d: d.update(breakpoints=[]),
    ],
    ids=["pause-mismatch", "unsafe", "no-reveal", "few-hidden", "java", "bad-tag", "wrong-video", "empty"],
)
def test_invalid_reviewed_rejected(workspace, mutate):
    _edit_reviewed(workspace, mutate)
    with pytest.raises(PrepError) as e:
        _verify(workspace)
    assert e.value.code in {"INVALID_DRAFT", "INVALID_TIMING"}


def test_overlapping_breakpoints_rejected(workspace):
    def dup(d):
        second = copy.deepcopy(d["breakpoints"][0])
        second["id"] = "second"
        second["exercise"]["id"] = "second-ex"
        d["breakpoints"].append(second)

    _edit_reviewed(workspace, dup)
    with pytest.raises(PrepError) as e:
        _verify(workspace)
    assert e.value.code == "INVALID_TIMING"


def test_failed_rerun_leaves_approved_unchanged(workspace):
    _verify(workspace)
    approved = _publish(workspace)
    before = approved.read_bytes()

    # A broken review followed by verify + publish must not touch approved/.
    _edit_reviewed(workspace, lambda d: d["breakpoints"][0].update(setupEndS=9900))
    with pytest.raises(PrepError):
        _verify(workspace)
    with pytest.raises(PrepError):
        _publish(workspace)
    # A failed scan must not touch it either.
    with pytest.raises(PrepError):
        run_scan(workspace, lambda prompt: "garbage")

    assert approved.read_bytes() == before
    assert [p.name for p in workspace["approved"].iterdir()] == [f"{VID}.json"]  # no temp files
    Catalog(workspace["approved"])  # still loads


def test_cli_exit_codes(monkeypatch, workspace, capsys):
    # Path defaults are bound at definition time, so route the CLI through the workspace.
    real_verify = prepare.verify
    monkeypatch.setattr(
        prepare, "verify",
        lambda v: real_verify(v, reviewed_dir=workspace["reviewed"], drafts_dir=workspace["drafts"]),
    )
    assert prepare.main(["verify", "--video-id", VID]) == 0

    assert prepare.main(["scan", "--video-id", "bad"]) == 1
    assert "INVALID_VIDEO_ID" in capsys.readouterr().err

    def not_verified(video_id):
        raise PrepError("NOT_VERIFIED", "run verify")

    monkeypatch.setattr(prepare, "publish", not_verified)
    assert prepare.main(["publish", "--video-id", VID]) == 1
    assert "NOT_VERIFIED" in capsys.readouterr().err
