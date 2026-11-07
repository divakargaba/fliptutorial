"""Offline tests for app.transcripts (runtime caption fetch, clip, cache)."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from app.transcripts import (
    Cue,
    Transcript,
    TranscriptError,
    TranscriptFetcher,
    clip,
    parse_json3,
    pick_track,
)

VID = "AbCdEfGhIjK"


def _json3(n: int = 60, step_ms: int = 5000, overlap_ms: int = 1500) -> dict:
    events = [{"tStartMs": 0, "dDurationMs": 999999}]  # window event without segs
    for i in range(n):
        events.append({
            "tStartMs": i * step_ms,
            "dDurationMs": step_ms + overlap_ms,
            "segs": [{"utf8": f"line {i} "}, {"utf8": "def  add(a, b):"}],
        })
    events.append({"tStartMs": n * step_ms, "dDurationMs": 100, "segs": [{"utf8": "\n"}]})  # blank
    return {"events": events}


def _transport(*, tracks=None, html_tracks=None, caption=None, fail=None, calls=None, title="Learn Python"):
    if tracks is None:
        tracks = [
            {"languageCode": "en", "kind": "asr", "baseUrl": "https://www.youtube.com/api/timedtext?v=x&lang=en&kind=asr&fmt=srv3"},
        ]
    caption = _json3() if caption is None else caption

    def handler(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(request.url.path)
        if fail and fail in str(request.url):
            raise httpx.ConnectError("boom", request=request)
        path = request.url.path
        if path == "/watch":
            body = '<html><title>Page - YouTube</title><script>{"INNERTUBE_API_KEY":"k123"}</script>'
            if html_tracks is not None:
                body += '"captionTracks":' + json.dumps(html_tracks) + ',"x":1'
            return httpx.Response(200, text=body)
        if path == "/youtubei/v1/player":
            assert request.url.params["key"] == "k123"
            payload = json.loads(request.content)
            assert payload["videoId"] in (VID, "ZZZZZZZZZZZ")
            data = {"videoDetails": {"title": title}}
            if tracks:
                data["captions"] = {"playerCaptionsTracklistRenderer": {"captionTracks": tracks}}
            return httpx.Response(200, json=data)
        if path == "/api/timedtext":
            assert request.url.params["fmt"] == "json3"
            return httpx.Response(200, text=caption if isinstance(caption, str) else json.dumps(caption))
        return httpx.Response(404)

    return httpx.MockTransport(handler)


def _fetcher(**kw) -> TranscriptFetcher:
    clock = kw.pop("clock", None)
    f = TranscriptFetcher(client=httpx.AsyncClient(transport=_transport(**kw)))
    if clock:
        f.clock = clock
    return f


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def test_parse_json3_stable_ids_text_and_no_overlap():
    cues = parse_json3(_json3(n=4))
    assert [c.id for c in cues] == ["c00000000", "c00005000", "c00010000", "c00015000"]
    assert cues[0].text == "line 0 def add(a, b):"
    for a, b in zip(cues, cues[1:]):
        assert a.end_s <= b.start_s
    assert cues[-1].end_s == pytest.approx(21.5)


def test_parse_json3_rejects_garbage_and_merges_same_start():
    payload = {"events": [
        {"tStartMs": "x", "segs": [{"utf8": "bad"}]},
        {"tStartMs": -5, "segs": [{"utf8": "neg"}]},
        {"tStartMs": 1000, "dDurationMs": 500, "segs": [{"utf8": "a"}]},
        {"tStartMs": 1000, "dDurationMs": 800, "segs": [{"utf8": "b"}]},
    ]}
    cues = parse_json3(payload)
    assert len(cues) == 1 and cues[0].text == "a b"
    assert parse_json3({"nope": 1}) == [] and parse_json3([]) == []


def test_pick_track_prefers_english_uploader_track():
    tracks = [
        {"languageCode": "de", "baseUrl": "u-de"},
        {"languageCode": "en", "kind": "asr", "baseUrl": "u-asr"},
        {"languageCode": "en-US", "baseUrl": "u-manual"},
    ]
    assert pick_track(tracks)["baseUrl"] == "u-manual"
    assert pick_track(tracks[:2])["baseUrl"] == "u-asr"
    assert pick_track(tracks[:1]) is None
    assert pick_track([]) is None


# ---------------------------------------------------------------------------
# Clip
# ---------------------------------------------------------------------------


def _transcript(n=120, step=5.0) -> Transcript:
    cues = tuple(Cue(f"c{int(i * step * 1000):08d}", i * step, i * step + step, f"t{i}") for i in range(n))
    return Transcript(VID, "asr", "en", "T", cues)


def test_clip_only_includes_speech_before_timestamp():
    t = _transcript()
    c = clip(t, 302.5)
    assert c.cues[-1].start_s < 302.5
    assert c.cues[-1].end_s == 302.5  # trimmed, nothing after the moment
    assert all(cue.start_s < 302.5 for cue in c.cues)
    assert c.last_cue_id == "c00300000"
    assert c.start_s == 0.0


@pytest.mark.parametrize("ts", [0, 50, 179.9])
def test_clip_too_early(ts):
    with pytest.raises(TranscriptError) as e:
        clip(_transcript(), ts)
    assert e.value.code == "TOO_EARLY"


def test_clip_too_early_when_captions_start_late():
    cues = tuple(Cue(f"c{i}", 500.0 + i, 501.0 + i, "x") for i in range(100))
    with pytest.raises(TranscriptError) as e:
        clip(Transcript(VID, "asr", "en", "", cues), 650.0)
    assert e.value.code == "TOO_EARLY"


@pytest.mark.parametrize("ts", [float("nan"), float("inf"), -1, True, "10"])
def test_clip_invalid_timestamp(ts):
    with pytest.raises(TranscriptError) as e:
        clip(_transcript(), ts)
    assert e.value.code == "INVALID_REQUEST"


def test_clip_bounds_lookback_and_size():
    t = _transcript(n=1000)  # 5000 s of captions
    c = clip(t, 4000.0, lookback_s=900)
    assert c.start_s >= 4000.0 - 900 - 5.0
    c2 = clip(t, 4000.0, max_chars=50)
    assert sum(len(x.text) + 1 for x in c2.cues) <= 50
    assert c2.cues[-1].start_s < 4000.0


# ---------------------------------------------------------------------------
# Fetch + cache (MockTransport; no network)
# ---------------------------------------------------------------------------


def test_fetch_asr_track_and_title():
    f = _fetcher()
    t = run(f.get(VID))
    assert t.kind == "asr" and t.language == "en" and t.title == "Learn Python"
    assert len(t.cues) == 60 and t.cues[1].id == "c00005000"


def test_fetch_prefers_manual_track():
    tracks = [
        {"languageCode": "en", "kind": "asr", "baseUrl": "https://www.youtube.com/api/timedtext?k=asr"},
        {"languageCode": "en", "baseUrl": "https://www.youtube.com/api/timedtext?k=manual"},
    ]
    t = run(_fetcher(tracks=tracks).get(VID))
    assert t.kind == "manual"


def test_fetch_falls_back_to_html_tracks():
    html_tracks = [{"languageCode": "en", "baseUrl": "https://www.youtube.com/api/timedtext?k=h"}]
    t = run(_fetcher(tracks=[], html_tracks=html_tracks).get(VID))
    assert t.kind == "manual" and len(t.cues) == 60


def test_no_captions_is_cached_briefly():
    calls: list[str] = []
    now = [0.0]
    f = _fetcher(tracks=[], calls=calls, clock=lambda: now[0])
    for _ in range(2):
        with pytest.raises(TranscriptError) as e:
            run(f.get(VID))
        assert e.value.code == "NO_CAPTIONS" and not e.value.retryable
    assert f.fetch_count == 1
    now[0] = 601.0
    with pytest.raises(TranscriptError):
        run(f.get(VID))
    assert f.fetch_count == 2


@pytest.mark.parametrize("caption", ["", "   ", json.dumps({"events": []})])
def test_empty_caption_track_is_no_captions(caption):
    with pytest.raises(TranscriptError) as e:
        run(_fetcher(caption=caption).get(VID))
    assert e.value.code == "NO_CAPTIONS"


def test_non_english_only_is_no_captions():
    tracks = [{"languageCode": "es", "baseUrl": "https://www.youtube.com/api/timedtext?k=es"}]
    with pytest.raises(TranscriptError) as e:
        run(_fetcher(tracks=tracks).get(VID))
    assert e.value.code == "NO_CAPTIONS"


def test_network_failure_is_retryable_and_not_cached():
    f = _fetcher(fail="/api/timedtext")
    with pytest.raises(TranscriptError) as e:
        run(f.get(VID))
    assert e.value.code == "CAPTIONS_UNAVAILABLE" and e.value.retryable
    with pytest.raises(TranscriptError):
        run(f.get(VID))
    assert f.fetch_count == 2  # failures are retried, not cached


def test_malformed_payload_is_retryable():
    with pytest.raises(TranscriptError) as e:
        run(_fetcher(caption="<xml/>").get(VID))
    assert e.value.code == "CAPTIONS_UNAVAILABLE"


def test_hit_cache_ttl_and_eviction():
    now = [0.0]
    f = _fetcher(clock=lambda: now[0])
    run(f.get(VID))
    run(f.get(VID))
    assert f.fetch_count == 1
    now[0] = 6 * 3600 + 1
    run(f.get(VID))
    assert f.fetch_count == 2
    f.max_entries = 1
    run(f.get("ZZZZZZZZZZZ"))
    assert list(f._cache) == ["ZZZZZZZZZZZ"]


def test_concurrent_requests_share_one_fetch():
    f = _fetcher()

    async def both():
        return await asyncio.gather(f.get(VID), f.get(VID), f.get(VID))

    a, b, c = run(both())
    assert a is b is c and f.fetch_count == 1


@pytest.mark.parametrize("vid", ["short", "../../etc/pa", "", None])
def test_invalid_video_id(vid):
    with pytest.raises(TranscriptError) as e:
        run(_fetcher().get(vid))
    assert e.value.code == "INVALID_REQUEST"
