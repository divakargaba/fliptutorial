# "Test me" — spec (stretch scope, off by default)

Status: approved by @divakargaba on 2026-11-07 (board #6714669105). Tasks T1–T9 and
owners are in `PLAN.md` → "Test me" feature; wire contract in `contracts/README.md`.

## What it is

A **Test me** button next to the Breakpoint badge on any captioned Python tutorial,
including videos we never prepared. Pressing it pauses the video. The backend takes
the captions spoken up to that moment, has Gemini write one coding exercise about
what was just taught, checks it, and serves it in the same practice panel. Grading
reuses `POST /v1/submissions` and Judge0. Phase 1 is a coding exercise only; a short
quiz is phase 2 (T8/T9) and starts only after T7 passes.

## Decisions

1. Stretch scope beyond the PRD's "live preparation of arbitrary videos" exclusion,
   behind a setting that is **off by default**.
2. A generated exercise is served only if its reference solution passes **every**
   test and its known-wrong solution fails **at least one**. Both checks run in
   Judge0, never on our machine (generated code is untrusted).
3. Every generated screen says **"AI-generated practice"**.
4. Captions are fetched and cached at runtime (`backend/app/transcripts.py`), built
   from the D1/P1 draft scripts.
5. Uses the team Gemini key (`GEMINI_API_KEY` in `backend/.env`), capped at
   **10 sets per minute**, with a cache in front. Cache hits are free.
6. Enters the demo only after **3 clean runs on a video we never prepared** (T7).

## Request flow

```
content script ──testMe{videoId,timestampS}──▶ background (20 s timeout)
  │ pauses video, shows loading                       │
  │                                                   ▼
  │                                  POST /v1/test-me (setting must be on)
  │                                                   │
  │              transcripts.get(videoId)  ── cache (6 h hit / 10 min no-captions)
  │                     │  innertube player → English track (uploader > ASR) → json3
  │                     ▼
  │              transcripts.clip(t, timestampS)  ── only speech before the moment,
  │                     │                           ≥180 s, ≤900 s / 12k chars lookback
  │                     ▼
  │              testme.generate(clip, verify)   ── set cache (videoId + last cue id)
  │                     │  rate limit 10/min → Gemini structured output
  │                     │  → rule + concept checks → verify in Judge0 (grader, T3)
  │                     │  → one retry on a failed check if time remains
  │                     ▼
  ◀──── { exercise, setId, generated: true, aiGenerated: true } ─────
  panel opens ("AI-generated practice") → Run/Submit via /v1/submissions (setId's exerciseId)
```

## API (owner: @divakargaba, T4)

`POST /v1/test-me` body `{ "videoId": "<11 chars>", "timestampS": <number ≥ 0> }`.
Response: the same exercise shape as a breakpoint exercise in the practice response
(`id`, `title`, `statement`, `language`, `starterCode`, `examples`), plus
`"generated": true`, `"aiGenerated": true` and `"setId"`. `revision` is the `setId`,
so `/v1/submissions` with `{exerciseId, revision: setId}` grades it (catalog fallback
to the set cache). Hidden tests, reference and wrong solutions never leave the backend.
A set expires after its TTL (30 min); grading an expired set returns `SET_EXPIRED`.

Errors (API error shape `{ error: { code, message, retryable }, requestId }`):

| Code | HTTP | Retryable | When |
| --- | --- | --- | --- |
| `NO_CAPTIONS` | 404 | no | No English caption track, or it is empty |
| `NOT_PYTHON` | 422 | no | The tutorial so far is not Python code |
| `TOO_EARLY` | 422 | no | Under 180 s of transcript before `timestampS` |
| `GENERATOR_UNAVAILABLE` | 503 | yes | No key, Gemini/YouTube error, no valid exercise after retry, Judge0 check unavailable |
| `GENERATOR_TIMEOUT` | 504 | yes | The whole generation (Gemini + Judge0 checks) exceeded its budget |
| `SET_EXPIRED` | 410 | no | `/v1/submissions` for a set past its TTL |
| `BUSY` | 429 | yes | Over 10 new sets in the last 60 s (existing code) |

Module error codes map to these: `transcripts` raises `NO_CAPTIONS`, `TOO_EARLY`,
`INVALID_REQUEST` (→ 422 request validation) and `CAPTIONS_UNAVAILABLE`
(→ `GENERATOR_UNAVAILABLE`). `testme` raises `NOT_PYTHON`, `GENERATOR_UNAVAILABLE`,
`GENERATOR_TIMEOUT` and `BUSY`.

Time budget: the extension waits 20 s, so the backend budget is 18 s end to end
(caption fetch ≈1–2 s cold, Gemini ≈3–8 s, Judge0 checks ≈2–5 s).

## Transcripts (`backend/app/transcripts.py`, T1)

- `TranscriptFetcher.get(videoId)`: watch page → `INNERTUBE_API_KEY` → `youtubei/v1/player`
  (ANDROID, then WEB client), falling back to `captionTracks` in the page; picks an
  English uploader track, else English ASR (never a translation); downloads `fmt=json3`.
- Cues get stable ids `c<ms:08d>` (same as `app.prepare`); overlapping (rolling ASR)
  cue ends are clipped to the next start; same-ms events are merged.
- Cache in memory: 6 h for transcripts, 10 min for `NO_CAPTIONS`, 64 videos (oldest
  evicted). Network failures are not cached. Concurrent requests share one fetch.
- `clip(transcript, timestampS)`: cues starting before the moment, last cue end trimmed
  to the moment; `TOO_EARLY` under 180 s; keeps the most recent ≤900 s / 12,000 chars.
- Caption text is never logged.

## Generator (`backend/app/testme.py`, T2)

- Prompt: the clipped cues with ids, video title, and rules: one self-contained
  beginner Python function exercise using only concepts already taught in the clip;
  say `language` + evidence; return `notPython` / `noExercise` instead of inventing.
- Structured output (Gemini `response_schema`): title, statement, functionName,
  starterCode, referenceSolution, knownWrongSolution, examples/hiddenTests as JSON
  strings (`argsJson`, `expectedJson`), conceptTags, conceptEvidenceCueIds.
- Rule checks (no code is executed locally): Python only; identifier function name;
  starter, reference and wrong solution compile (`compile()` only) and define the
  function; starter ≠ reference ≠ wrong; 1–2 visible examples, 3–8 hidden tests, no
  duplicate inputs, same argument count in every case; args/expected are int/str/bool/None (no floats, ≤200-char
  strings); code ≤4 KiB; no `input(`, `open(`, `eval(`, `exec(`, `__import__`,
  `import os|sys|subprocess|socket`; title ≤80 and statement ≤600 chars.
- Concept checks: ≥1 concept tag from the PRD list; ≥1 evidence cue id, all present
  in the clip (the concept was taught before the moment).
- Then `verify(exercise)` (T3 Judge0 method): reference passes all, wrong fails ≥1.
  A failed rule/concept/verify check gets one retry when ≥8 s of budget remain;
  otherwise `GENERATOR_UNAVAILABLE`.
- Cache: key = `videoId` + last cue id of the clip + prompt version, TTL 30 min; the
  `setId` is `tm-<16 hex>` of that key. Only verified sets are cached. In-flight
  requests for the same key share one generation. `get_set(setId)` returns the
  private set or `None` after expiry (→ `SET_EXPIRED`).
- Rate limit: 10 new sets per rolling 60 s (cache hits don't count) → `BUSY`.
- Model: `GEMINI_TESTME_MODEL`, default `gemini-2.5-flash`, temperature 0.2, thinking
  budget `GEMINI_TESTME_THINKING` (default 1024; -1 leaves it to the model). With
  thinking off, live runs gave wrong solutions with syntax errors, or ones that
  passed every test. `gemini-2.5-flash` on the free tier is 5 req/min, 20 req/day;
  cache hits are free, so 20/day covers T7's ~6-12 generations.
- Live results 2026-11-08 (`eWRfhZUzrAc`, never prepared): Judge0-verified sets in
  13.1 s and 18.4 s (2.5-flash). `gemini-flash-latest` latency varied from 3.1 s to
  over 200 s with 503 "high demand" errors, so many requests end in
  `GENERATOR_TIMEOUT`. This latency is the main risk for T7.
- The output also names the wrong solution's mistake (`wrongMistake`) and a hidden
  test it fails (`wrongFailsOnArgsJson`, which must match one of the hidden tests).
- A provider 429 (quota) maps to `BUSY`. The team key's free tier allows **5
  requests/min per model** on `gemini-2.5-flash`, which is below the 10 sets/min cap.

## UI (T5 @abdullahwarv2, T6 @reyanshBadhwar26)

"Test me" button near the badge, shown only when the setting is on and no prepared
breakpoint is active. Press → pause → loading state in the panel → exercise with the
"AI-generated practice" label on every generated screen (statement, results, solved).
Error states for every code above keep playback paused with Close/Resume reachable;
retryable codes offer "Try again".

## Test plan

- T1 `backend/tests/test_transcripts.py` (offline, `httpx.MockTransport`): json3
  parsing, ids, overlap clipping, track choice, HTML fallback, `NO_CAPTIONS` (no
  track, non-English only, empty), retryable network/malformed errors not cached,
  TTLs, eviction, shared in-flight fetch, clip bounds, `TOO_EARLY`, invalid input.
- T2 `backend/tests/test_testme.py` (stubbed Gemini + stubbed verify): valid set,
  every rule and concept check, `NOT_PYTHON`, timeout, provider error, retry then
  success, verify failure, cache hit without a model call, TTL expiry, rate limit,
  hidden data absent from the public shape.
- T3/T4 (@divakargaba): Judge0 check method, endpoint error codes, `SET_EXPIRED`,
  setting off by default, fixture.
- T7: real YouTube, 2 unprepared videos, 1× and 2×, 3 clean runs, times in
  PLAN.md Measured results.
