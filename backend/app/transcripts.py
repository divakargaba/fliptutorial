"""Runtime YouTube caption fetch, clip and cache for "Test me" (docs/TEST-ME.md).

Built from the D1/P1 draft scripts (``content/drafts/fetch_transcript.py``,
``to_excerpt.py``, ``asr_clip.py``), made async and safe to call per request:

* ``TranscriptFetcher.get(video_id)`` fetches the English caption track once
  (uploader track preferred, else auto-generated ASR), converts the json3
  payload to cues with stable ids, clips overlapping ASR cue ends, and caches
  the result in memory (6 h for hits, 10 min for "no captions"). Concurrent
  requests for the same video share one fetch.
* ``clip(transcript, timestamp_s)`` returns only what was said before
  ``timestampS`` (bounded lookback and size) or raises ``TOO_EARLY``.

Errors are ``TranscriptError`` with a stable code: ``NO_CAPTIONS`` (no usable
English track), ``TOO_EARLY`` (under 180 s of transcript before the moment),
``CAPTIONS_UNAVAILABLE`` (YouTube unreachable / unexpected reply; retryable,
the endpoint maps it to ``GENERATOR_UNAVAILABLE`` 503) and ``INVALID_REQUEST``.
Caption text is never logged.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from .catalog import VIDEO_ID_RE

logger = logging.getLogger("breakpoint.transcripts")

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)
PLAYER_CLIENTS = (
    {"clientName": "ANDROID", "clientVersion": "20.10.38"},
    {"clientName": "WEB", "clientVersion": "2.20250101.00.00"},
)
FETCH_TIMEOUT_S = 8.0
MAX_PAYLOAD_BYTES = 8 * 1024 * 1024

HIT_TTL_S = 6 * 3600.0
MISS_TTL_S = 600.0
MAX_CACHED_VIDEOS = 64

MIN_TRANSCRIPT_S = 180.0
LOOKBACK_S = 900.0
MAX_CLIP_CHARS = 12_000


class TranscriptError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.retryable = retryable


@dataclass(frozen=True)
class Cue:
    id: str
    start_s: float
    end_s: float
    text: str


@dataclass(frozen=True)
class Transcript:
    video_id: str
    kind: str  # "manual" | "asr"
    language: str
    title: str
    cues: tuple[Cue, ...]


@dataclass(frozen=True)
class Clip:
    video_id: str
    kind: str
    title: str
    timestamp_s: float
    start_s: float
    cues: tuple[Cue, ...]

    @property
    def last_cue_id(self) -> str:
        return self.cues[-1].id


def cue_id_for(start_s: float) -> str:
    """Stable cue id derived from the start time in ms (same as app.prepare)."""
    return f"c{round(start_s * 1000):08d}"


# ---------------------------------------------------------------------------
# Pure parsing helpers
# ---------------------------------------------------------------------------


def pick_track(tracks: list[dict]) -> dict | None:
    """Prefer an English uploader track, then English ASR. Never translate."""
    en = [t for t in tracks if str(t.get("languageCode", "")).lower().startswith("en") and t.get("baseUrl")]
    manual = [t for t in en if t.get("kind") != "asr"]
    return (manual or en or [None])[0]


def parse_json3(payload: Any) -> list[Cue]:
    """Convert a YouTube json3 caption payload into ordered, non-overlapping cues."""
    events = payload.get("events") if isinstance(payload, dict) else None
    if not isinstance(events, list):
        return []
    raw: list[tuple[float, float, str]] = []
    for ev in events:
        if not isinstance(ev, dict) or "segs" not in ev or "tStartMs" not in ev:
            continue
        text = " ".join("".join(str(s.get("utf8", "")) for s in ev["segs"] if isinstance(s, dict)).split())
        if not text:
            continue
        start_ms, dur_ms = ev.get("tStartMs"), ev.get("dDurationMs", 0)
        if not isinstance(start_ms, (int, float)) or not isinstance(dur_ms, (int, float)):
            continue
        s = start_ms / 1000
        e = (start_ms + max(dur_ms, 0)) / 1000
        if not (math.isfinite(s) and math.isfinite(e)) or s < 0:
            continue
        raw.append((round(s, 3), round(e, 3), text))
    raw.sort(key=lambda c: c[0])

    cues: list[Cue] = []
    seen: set[str] = set()
    for i, (s, e, text) in enumerate(raw):
        # Rolling ASR (and some uploader) cues overlap the next one; clip the end.
        if i + 1 < len(raw) and e > raw[i + 1][0]:
            e = raw[i + 1][0]
        cid = cue_id_for(s)
        if cid in seen:  # two events at the same ms: merge text into the first
            prev = cues[-1]
            cues[-1] = Cue(prev.id, prev.start_s, max(prev.end_s, e), f"{prev.text} {text}")
            continue
        seen.add(cid)
        cues.append(Cue(cid, s, max(e, s), text))
    return cues


def clip(
    transcript: Transcript,
    timestamp_s: float,
    *,
    min_transcript_s: float = MIN_TRANSCRIPT_S,
    lookback_s: float = LOOKBACK_S,
    max_chars: int = MAX_CLIP_CHARS,
) -> Clip:
    """Return the cues spoken before ``timestamp_s`` (most recent ones kept).

    Raises TOO_EARLY when fewer than ``min_transcript_s`` seconds of captions
    precede the moment. The clip keeps at most ``lookback_s`` seconds and
    ``max_chars`` characters, trimming the oldest cues first.
    """
    if not isinstance(timestamp_s, (int, float)) or isinstance(timestamp_s, bool) or not math.isfinite(timestamp_s) or timestamp_s < 0:
        raise TranscriptError("INVALID_REQUEST", "timestampS must be a finite, non-negative number")
    before = [c for c in transcript.cues if c.start_s < timestamp_s]
    if not before:
        raise TranscriptError("TOO_EARLY", "no captions before this moment yet")
    spoken_until = min(timestamp_s, before[-1].end_s)
    if spoken_until - before[0].start_s < min_transcript_s:
        raise TranscriptError(
            "TOO_EARLY", f"needs at least {int(min_transcript_s)} s of transcript before this moment"
        )
    # Never hand over speech after the moment: trim the last cue's end.
    last = before[-1]
    if last.end_s > timestamp_s:
        before[-1] = Cue(last.id, last.start_s, float(timestamp_s), last.text)

    floor = timestamp_s - lookback_s
    kept: list[Cue] = []
    chars = 0
    for c in reversed(before):
        if c.end_s < floor and kept:
            break
        chars += len(c.text) + 1
        if chars > max_chars and kept:
            break
        kept.append(c)
    kept.reverse()
    return Clip(
        video_id=transcript.video_id,
        kind=transcript.kind,
        title=transcript.title,
        timestamp_s=float(timestamp_s),
        start_s=kept[0].start_s,
        cues=tuple(kept),
    )


# ---------------------------------------------------------------------------
# Fetcher with cache
# ---------------------------------------------------------------------------


@dataclass
class _Entry:
    expires_at: float
    transcript: Transcript | None = None
    error: TranscriptError | None = None


@dataclass
class TranscriptFetcher:
    """Fetches and caches caption transcripts. Inject ``client`` in tests."""

    client: httpx.AsyncClient | None = None
    hit_ttl_s: float = HIT_TTL_S
    miss_ttl_s: float = MISS_TTL_S
    max_entries: int = MAX_CACHED_VIDEOS
    clock: Any = time.monotonic
    _cache: dict[str, _Entry] = field(default_factory=dict)
    _inflight: dict[str, asyncio.Future] = field(default_factory=dict)
    fetch_count: int = 0

    def __post_init__(self) -> None:
        self._owns_client = self.client is None
        if self.client is None:
            self.client = httpx.AsyncClient(
                timeout=httpx.Timeout(FETCH_TIMEOUT_S), follow_redirects=True, trust_env=False
            )

    async def close(self) -> None:
        if self._owns_client and self.client is not None:
            await self.client.aclose()

    async def get(self, video_id: str) -> Transcript:
        if not isinstance(video_id, str) or not VIDEO_ID_RE.match(video_id):
            raise TranscriptError("INVALID_REQUEST", "malformed video id")
        now = self.clock()
        entry = self._cache.get(video_id)
        if entry and entry.expires_at > now:
            if entry.error:
                raise entry.error
            assert entry.transcript is not None
            return entry.transcript
        if video_id in self._inflight:
            return await asyncio.shield(self._inflight[video_id])

        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._inflight[video_id] = fut
        try:
            transcript = await self._fetch(video_id)
        except TranscriptError as exc:
            if exc.code == "NO_CAPTIONS":
                self._store(video_id, _Entry(self.clock() + self.miss_ttl_s, error=exc))
            fut.set_exception(exc)
            fut.exception()  # mark retrieved so waiters-less futures don't warn
            raise
        except asyncio.CancelledError:
            fut.cancel()
            raise
        except Exception as exc:
            err = TranscriptError("CAPTIONS_UNAVAILABLE", f"caption fetch failed: {type(exc).__name__}", True)
            fut.set_exception(err)
            fut.exception()
            raise err from exc
        else:
            self._store(video_id, _Entry(self.clock() + self.hit_ttl_s, transcript=transcript))
            fut.set_result(transcript)
            return transcript
        finally:
            self._inflight.pop(video_id, None)

    def _store(self, video_id: str, entry: _Entry) -> None:
        self._cache.pop(video_id, None)
        self._cache[video_id] = entry
        while len(self._cache) > self.max_entries:
            self._cache.pop(next(iter(self._cache)))

    async def _get_text(self, url: str, *, json_body: dict | None = None) -> str:
        headers = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
        assert self.client is not None
        try:
            if json_body is None:
                resp = await self.client.get(url, headers=headers)
            else:
                resp = await self.client.post(url, headers=headers, json=json_body)
        except httpx.HTTPError as exc:
            raise TranscriptError("CAPTIONS_UNAVAILABLE", f"YouTube unreachable: {type(exc).__name__}", True) from exc
        if resp.status_code >= 400:
            raise TranscriptError("CAPTIONS_UNAVAILABLE", f"YouTube returned {resp.status_code}", True)
        if len(resp.content) > MAX_PAYLOAD_BYTES:
            raise TranscriptError("CAPTIONS_UNAVAILABLE", "YouTube reply too large", True)
        return resp.text

    async def _fetch(self, video_id: str) -> Transcript:
        self.fetch_count += 1
        started = time.monotonic()
        html = await self._get_text(f"https://www.youtube.com/watch?v={video_id}")
        key_match = re.search(r'"INNERTUBE_API_KEY":"([^"]+)"', html)

        tracks: list[dict] = []
        title = ""
        if key_match:
            for client in PLAYER_CLIENTS:
                body = {"context": {"client": client}, "videoId": video_id}
                try:
                    data = json.loads(
                        await self._get_text(
                            f"https://www.youtube.com/youtubei/v1/player?key={key_match.group(1)}", json_body=body
                        )
                    )
                except (TranscriptError, json.JSONDecodeError):
                    continue
                title = title or str((data.get("videoDetails") or {}).get("title") or "")
                tracks = (
                    (data.get("captions") or {}).get("playerCaptionsTracklistRenderer") or {}
                ).get("captionTracks") or []
                if tracks:
                    break
        if not tracks:
            m = re.search(r'"captionTracks":(\[.*?\])', html)
            if m:
                try:
                    tracks = json.loads(m.group(1))
                except json.JSONDecodeError:
                    tracks = []
        if not title:
            tm = re.search(r"<title>(.*?)(?: - YouTube)?</title>", html, re.S)
            title = " ".join(tm.group(1).split()) if tm else ""

        track = pick_track(tracks if isinstance(tracks, list) else [])
        if track is None:
            raise TranscriptError("NO_CAPTIONS", "this video has no English captions")

        url = str(track["baseUrl"]).replace("\\u0026", "&")
        url = re.sub(r"&fmt=[^&]*", "", url) + "&fmt=json3"
        raw = await self._get_text(url)
        if not raw.strip():
            raise TranscriptError("NO_CAPTIONS", "the caption track is empty")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise TranscriptError("CAPTIONS_UNAVAILABLE", "caption payload is not json3", True) from exc
        kind = "asr" if track.get("kind") == "asr" else "manual"
        cues = parse_json3(payload)
        if not cues:
            raise TranscriptError("NO_CAPTIONS", "the caption track has no cues")
        logger.info(
            "captions video=%s kind=%s cues=%d ms=%d",
            video_id, kind, len(cues), int((time.monotonic() - started) * 1000),
        )
        return Transcript(
            video_id=video_id,
            kind=kind,
            language=str(track.get("languageCode") or "en"),
            title=title,
            cues=tuple(cues),
        )
