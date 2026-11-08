"""Planner eval scoring (app.planner.evaluate): offline, no model calls."""

import json

from app.planner import evaluate as ev
from app.transcripts import Cue, Transcript

LABEL = {
    "videoId": "v1", "category": "tutorial", "labelledUntilS": 600,
    "segments": [
        {"startS": 0, "endS": 100, "qualifies": False},
        {"startS": 100, "endS": 600, "qualifies": True},
    ],
    "challenges": [{"askS": 300, "answerS": 320, "endS": 400}],
}


def sec(a, b, q, pauses=()):
    return {"startS": a, "endS": b, "qualifies": q, "pauses": list(pauses)}


def test_sections_labelled_by_majority_overlap():
    res = {"status": "classified", "sections": [
        sec(0, 90, False),        # TN
        sec(90, 300, True),       # 200/210 qualifying -> TP
        sec(300, 500, False),     # FN
        sec(500, 900, True),      # clipped to 500-600 -> TP
    ]}
    c = ev.score_video(LABEL, res)
    assert (c["tp"], c["fp"], c["fn"], c["tn"]) == (2, 0, 1, 1)
    assert c["tp_s"] == 300 and c["fp_s"] == 10 and c["fn_s"] == 200


def test_false_positive_and_uncovered_time_is_missed():
    res = {"status": "classified", "sections": [sec(0, 150, True)]}  # 50/150 qualifying -> FP
    c = ev.score_video(LABEL, res)
    assert (c["tp"], c["fp"]) == (0, 1)
    assert c["fp_s"] == 100
    assert c["fn_s"] == 450  # 150-600 never covered by any section


def test_pause_correctness_and_challenges():
    pauses = [
        {"pause_at_s": 50, "trigger": "demonstration"},     # outside teaching -> wrong
        {"pause_at_s": 315, "trigger": "question_posed"},   # before the answer -> ok
        {"pause_at_s": 330, "trigger": "question_posed"},   # after the answer -> wrong
        {"pause_at_s": 390, "trigger": "demonstration"},    # new problem after the answer -> ok
        {"pause_at_s": 601, "trigger": "demonstration"},    # past labelledUntilS -> not scored
    ]
    res = {"status": "classified", "sections": [sec(0, 600, True, pauses)]}
    c = ev.score_video(LABEL, res)
    assert (c["pauses_ok"], c["pauses"]) == (2, 4)
    assert c["bad_pauses"] == [50, 330]


def test_summary_and_report_bar():
    labels = [LABEL, {"videoId": "v2", "category": "non_coding", "title": "song",
                      "segments": [{"startS": 0, "endS": 200, "qualifies": False}]}]
    results = {"model": "m", "videos": {
        "v1": {"status": "classified", "sections": [sec(0, 100, False), sec(100, 600, True)]},
        "v2": {"status": "not_coding", "sections": [sec(0, 200, False)]},
    }}
    s = ev.summarize(labels, results)
    assert s["precision"] == 1.0 and s["recall"] == 1.0 and s["verdict_accuracy"] == 1.0
    assert "met, auto-pause on" in ev.report(labels, results)
    bad = {"videos": {**results["videos"], "v2": {"status": "classified", "sections": [sec(0, 200, True)]}}}
    s = ev.summarize(labels, bad)
    assert s["precision"] == 0.5 and s["verdict_accuracy"] == 0.5
    text = ev.report(labels, bad)
    assert "not met" in text and "| `v2` | FP | 0-200 | 0.00 |" in text
    # Every run has to meet the bar.
    assert "not met" in ev.report(labels, results, [("run2", bad)])
    assert "met, auto-pause on" in ev.report(labels, results, [("run2", results)])


def test_wilson_lower_bound():
    assert ev.wilson_low(0, 0) is None
    assert 0.83 < ev.wilson_low(78, 85) < 0.85
    assert ev.wilson_low(10, 10) < 1.0


def test_truncate_keeps_labelled_span():
    t = Transcript("v1", "asr", "en", "t", tuple(Cue(f"c{i}", i * 10.0, i * 10.0 + 9, "x") for i in range(10)))
    assert len(ev.truncate(t, 45).cues) == 5
    assert ev.truncate(t, None) is t


def test_committed_labels_are_well_formed():
    data = json.loads(ev.LABELS.read_text(encoding="utf-8"))["videos"]
    assert len(data) >= 20
    assert len({v["videoId"] for v in data}) == len(data)
    assert any(not any(g["qualifies"] for g in v["segments"]) for v in data)  # non-coding videos included
    for v in data:
        segs = v["segments"]
        assert segs[0]["startS"] == 0
        for a, b in zip(segs, segs[1:]):
            assert a["endS"] == b["startS"], v["videoId"]  # contiguous, no gaps or overlaps
        if "labelledUntilS" in v:
            assert segs[-1]["endS"] == v["labelledUntilS"]
        for ch in v.get("challenges", []):
            assert ch["askS"] <= ch["answerS"] <= ch["endS"]
