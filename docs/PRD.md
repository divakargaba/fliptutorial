# Breakpoint product requirements and implementation plan

## 1. Product and release scope

Breakpoint is a Chrome extension that adds coding practice directly to YouTube. A learner opens a supported freeCodeCamp tutorial normally. Before the instructor reveals a solution, the video pauses and a practice panel opens on the same page. The learner can run examples, submit their code, or skip and continue watching. A correct submission resumes playback from the paused position, so the learner can compare their approach with the instructor’s.

**Demo target.** Ship one fully working Python challenge on freeCodeCamp’s *Learn Python – Full Course for Beginners* (`rfscVS0vtbw`). Start by scanning the timestamped transcript around **Exponent Function** (`2:41:20–2:47:13`, or `9680–10033` seconds). The chapter range is a convenient test window. The transcript identifies the challenge and the video confirms when the answer first appears. The instructor introduces Python’s exponent operator early, so verify the pause before the first applicable reveal. If that window has no safe pause, scan **Building a Basic Calculator** (`52:37–58:27`) from the same video. Add a second video after the first passes the release checks. [freeCodeCamp video and chapter list](https://www.youtube.com/watch?v=rfscVS0vtbw) · [Exponent Function transcript excerpt](https://2outube.com/watch?v=rfscVS0vtbw#:~:text=2%3A41%3A29)

| Priority | Deliverable |
| --- | --- |
| P0 | Automatic watch-page detection, a reviewed video-to-exercise pipeline, safe pause and resume, Tailwind practice panel, Python grading, recoverable errors, and the tests in §8. |
| P1 | A second reviewed video, additional challenges using the same contract, and a local record of solved exercises if time permits. |
| Last | Matching, after the video and practice flow is reliable. Live preparation of arbitrary videos, additional runtimes, accounts, and public portfolios are outside this release. |

## 2. Architecture and setup

```text
Timestamped transcript → Python prep command → Gemini detects challenge candidates
  → inspect the source video near each candidate → human timing review + verified tests → approved JSON

YouTube watch page → content script → extension service worker → FastAPI → approved JSON
  → local playback clock crosses saved time → pause and show CodeMirror
  → Run or Submit → FastAPI → Judge0 → backend grades → panel updates or resumes
```

The learner never enters a URL. The extension reads `v` from the current YouTube watch page. The team’s prep command uses an internal catalog of video IDs and transcript files. It constructs the video URL for reviewing candidate moments. Exercise data is available at page load, before the learner reaches the pause. Gemini is needed only for preparation. [Gemini video input](https://ai.google.dev/gemini-api/docs/video-understanding#youtube)

| Area | Build choice | Setup |
| --- | --- | --- |
| Extension | Manifest V3, TypeScript, React, WXT with Vite, Tailwind CSS 4, CodeMirror 6, Lucide icons | Node.js 24 LTS, npm, desktop Chrome. Use WXT’s React template and load the built extension unpacked. |
| API and grading | Python 3.12, FastAPI, Pydantic, HTTPX, hosted Judge0 CE | Python virtual environment and one Judge0 endpoint with Python 3 enabled. Use one local FastAPI process on the demo machine. |
| Video prep | Python CLI, timestamped transcript JSON, Google Gen AI SDK, Pydantic | One Gemini API key and a transcript excerpt for the prep machine. Approved JSON files are enough to run the watch experience. |
| Tests | Vitest, Playwright with bundled Chromium, pytest | Install Chromium once with Playwright. Test the real YouTube experience separately in desktop Chrome. |

**Setup checklist for the first implementation commit**

1. From the workspace root, run `npx wxt@latest init extension` and select React and npm. In `extension/`, install `tailwindcss`, `@tailwindcss/vite`, `codemirror`, `@codemirror/lang-python`, `lucide-react`, and `zod`. Add `vitest` and `@playwright/test` as development dependencies. Add the Tailwind Vite plugin through `wxt.config.ts` and commit `package-lock.json`. Use `npm ci` after the first checkout. [WXT installation](https://wxt.dev/guide/installation) · [Tailwind Vite setup](https://tailwindcss.com/docs/installation/using-vite)
2. In `backend/`, create `.venv` with `py -3.12 -m venv .venv`. Create and pin `requirements.txt` for `fastapi`, `uvicorn[standard]`, `httpx`, `pydantic`, `google-genai`, `python-dotenv`, and `pytest`. Install with `.\.venv\Scripts\python.exe -m pip install -r requirements.txt`.
3. Add `backend/.env.example` with `GEMINI_API_KEY`, `GEMINI_MODEL`, `JUDGE0_BASE_URL`, `JUDGE0_PYTHON_LANGUAGE_ID`, and the auth variables required by the selected Judge0 host. Copy to a gitignored `.env`. Choose a Gemini model that accepts public YouTube input and structured output and verify it against the lead clip. Call Judge0’s `GET /languages` and confirm the Python 3 language ID. Run real correct, syntax error, and infinite loop samples before building against the provider. [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output) · [Judge0 CE API](https://ce.judge0.com/)
4. Run the API from `backend/` with `.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --env-file .env`. In `extension/`, set `$env:WXT_API_BASE_URL = 'http://127.0.0.1:8000'` in PowerShell, run `npm run build`, and load `.output/chrome-mv3` at `chrome://extensions` using **Load unpacked**. Use `npm run dev` for iteration. After rebuilding an unpacked extension, reload it and refresh the YouTube tab.
5. Declare `https://www.youtube.com/*` for the top-frame content script, `http://127.0.0.1/*` for the local backend host permission, and `storage` for drafts. The service worker reads the public API origin from `import.meta.env.WXT_API_BASE_URL`. It accepts only typed lookup and grading messages from the YouTube content script and builds paths itself. Register the message listener synchronously inside the WXT `defineBackground` callback. Keep provider keys server-side and verify the built extension contains none. [Chrome cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests) · [Chrome message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging) · [WXT extension APIs](https://wxt.dev/guide/essentials/extension-apis)

The demo needs a laptop, Chrome, a local API, the two provider credentials, and internet access for YouTube and grading. Files hold the approved exercises and Chrome local storage holds drafts. This keeps the release independent of a database, deployed website, background queue, OAuth, or Chrome Web Store review.

```text
extension/
  entrypoints/youtube.content.tsx  # navigation, player binding, shadow UI
  entrypoints/background.ts      # validated API messages and timeouts
  src/playback.ts                # pure pause decisions and attempt state
  src/contracts.ts               # Zod response schemas
  src/ui/                        # panel, buttons, badges, editor, results, CSS
  tests/                         # Vitest and Playwright fixture
backend/
  app/main.py                    # API routes and error responses
  app/catalog.py                 # Pydantic models and approved catalog
  app/prepare.py                 # transcript scan, draft generation, review checks
  app/grader.py                  # sandbox adapter and result comparison
  content/seeds.json             # source video IDs, transcript paths, optional scan windows
  content/drafts/                # generated output awaiting review
  content/approved/              # reviewed exercises and private tests
  tests/                         # provider fixtures and API tests
```

## 3. Prepare the video before playback

1. **Load a timestamped transcript.** For the prototype, use YouTube’s **Show transcript** and save the selected excerpt as local JSON with `start_s`, `text`, and `end_s` when available. Assign stable cue IDs during ingestion. Timestamps are relative to the full video. Reject missing, empty, or nonmonotonic input. YouTube’s official caption download endpoint requires permission to edit the video, so the prototype uses a team-prepared excerpt. Chapter markers can bound the first scan. For longer scans, use overlapping five-minute transcript windows and deduplicate by overlapping setup and reveal times. [YouTube transcript help](https://support.google.com/youtube/answer/15930243?hl=en) · [YouTube caption download API](https://developers.google.com/youtube/data/reference/rest/v3/captions/download)
2. **Detect candidates from the transcript.** Ask Gemini for a self-contained task, its inputs and expected output, a proposed setup-end cue, the earliest spoken reveal cue, a language guess with evidence, and concept tags. Require valid cue IDs from the supplied excerpt so the timestamps trace back to the transcript. If the transcript shows a demonstration without a separable task, return zero candidates. Keywords and chapter titles are hints to the model. A valid candidate needs enough context for a learner to attempt it.
3. **Confirm the language and topics separately.** Use actual code syntax plus course context for language evidence. Allow `python`, `java`, `javascript`, `other`, and `unknown` in detection. Publish only Python in this release. Use a fixed list of tags such as `arrays`, `strings`, `binary-search`, `hash-map`, `two-pointers`, and `recursion`. When evidence conflicts, hold the candidate for review. Keep approach tags such as `hash-map` internal when displaying them would spoil the challenge.
4. **Check the video and calculate a safe pause.** Review the original video around the candidate. Check audio, captions, and on-screen code or diagrams. Gemini video analysis can help narrow this review. If using a clipped video input, require a timestamp basis and normalize relative times to the full YouTube timeline exactly once. Record the reviewed `setup_end_s`, `first_spoken_reveal_s`, and `first_visual_reveal_s`. A reveal channel may be null if reviewed and absent. Set `reveal_s` to the earliest applicable reveal. Prefer `pause_at_s = reveal_s - 2.0` and require `window_start_s <= setup_end_s <= pause_at_s <= reveal_s - 1.0` and `reveal_s <= window_end_s`. Reject missing or nonfinite times, invalid bounds, overlaps, and candidates with no safe window. Check the approved pause in the original video at 1× and 2×. [Gemini video timestamps and clipping](https://ai.google.dev/gemini-api/docs/video-understanding)
5. **Draft and verify the exercise.** Use the detected task to produce a plain-text statement, fixed Python function name, starter stub, and examples. Restrict the first exercise to JSON-friendly positional arguments and an exact integer result. Write or review a reference solution, execute it on candidate cases, and manually check the expected outputs. Use one or two visible examples and at least three hidden cases that catch likely wrong solutions. For the exponent exercise, cover a zero exponent, a zero base with a positive exponent, and a negative base with an odd exponent. Verify that a correct solution passes and a plausible wrong solution fails before publishing.
6. **Publish only reviewed files.** The command writes drafts and exits with a clear error on provider failure, invalid JSON, or no usable candidate. Only a deliberate approval step writes to `content/approved/`. Validate the complete record and write atomically. A failed rerun leaves the prior approved file usable. Fail startup on an invalid approved file with its filename and validation field. Ignore draft files in the runtime catalog.

Implement these commands in `backend/` after defining `seeds.json`.

```powershell
.\.venv\Scripts\python.exe -m app.prepare scan --video-id VIDEO_ID
.\.venv\Scripts\python.exe -m app.prepare verify --video-id VIDEO_ID
.\.venv\Scripts\python.exe -m app.prepare publish --video-id VIDEO_ID
```

`scan` creates a reviewable draft. `verify` checks the edited draft and runs the reviewed solution and a known-wrong solution against the cases. `publish` revalidates and records explicit approval of that exact draft, including its test cases. Use a digest or rerun verification during publish to avoid approving edits made after verification.

## 4. API and grader contract

| Request | Response and rules |
| --- | --- |
| `GET /health` | `200` when the catalog loaded. Provider smoke checks run separately. |
| `GET /v1/videos/{video_id}/practice` | `200` with `schemaVersion`, `videoId`, `revision`, `status: ready`, and sorted `breakpoints`. Each breakpoint has `id`, `pauseAtS`, `revealAtS`, and `exercise` with `id`, `title`, `statement`, `language`, `starterCode`, and visible `examples`. Unknown video returns `200` with `status: unsupported` and an empty list. A malformed ID returns `422`. |
| `POST /v1/submissions` | Request has `exerciseId`, `revision`, `mode: run \| submit`, and `code`. `run` checks visible examples. `submit` checks visible and hidden cases. A completed grade returns `200` with `outcome`, `passedCount`, `totalCount`, and `results`. Visible rows can show input, expected, and actual. Hidden cases return aggregate counts only. Only `submit` with `outcome: passed` can resume the video. |

Validate server data with Pydantic and browser responses with Zod. Use a checked-in public response fixture in both test suites. Construct the public response explicitly from approved records. The private record also carries the reviewed function name, concept tags, reference, and tests. Use a stable exercise ID and a revision that changes when an approved package changes. A stale submission returns `409`. Preserve the learner’s draft, reload the exercise, and ask for a new submission. Render model output and diagnostics as plain text.

Example response fixture with illustrative timestamps and a sample video ID.

```json
{
  "schemaVersion": 1,
  "videoId": "samplevid01",
  "revision": "demo-1",
  "status": "ready",
  "breakpoints": [
    {
      "id": "exponent-breakpoint",
      "pauseAtS": 72,
      "revealAtS": 74,
      "exercise": {
        "id": "samplevid01-exponent",
        "title": "Raise a number to a power",
        "statement": "Given an integer base and a nonnegative integer exponent, return the base raised to that power.",
        "language": "python",
        "starterCode": "def raise_to_power(base, exponent):\n    pass\n",
        "examples": [{ "args": [2, 3], "expected": 8 }]
      }
    }
  ]
}
```

**Grading.** Keep expected outputs in FastAPI. Send one input per isolated Judge0 run with a fixed wrapper that calls the exercise function and emits a JSON result. The expected result and a pass flag never enter the sandbox. Accept exactly one parseable result in the agreed format, enforce its type (`true` must not match `1`), and compare outside the sandbox. For hidden tests, suppress input, output, and raw runtime diagnostics. Test printing forged pass markers, extra output, and oversized output. Keep useful, capped syntax and runtime diagnostics for visible tests. [Judge0 CE API](https://ce.judge0.com/)

Use Judge0’s submission token and poll it to a fixed deadline. Start with up to three concurrent cases per request, 2 seconds CPU time and 4 seconds wall time per case, and a 12-second grading deadline including queueing. Check the chosen host’s limits and confirm sandbox networking is disabled. Cap code at 16 KiB and parsed output at 8 KiB. Keep one grading request active per panel and two per local backend. Return a structured error and release the concurrency slot on timeout. Use a 15-second extension fetch timeout for grading and 3 seconds for lookup. Retry only from an explicit user action, so a timed-out request does not silently create extra provider jobs. [Judge0 CE API](https://ce.judge0.com/) · [Chrome service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)

## 5. YouTube integration

**Route and player.** Accept desktop `/watch?v=<id>` with a valid video ID. Recheck the URL on YouTube’s `yt-navigate-finish` event and on a small URL poll as a fallback. On a video ID change, invalidate the old attempt, remove its listeners, cancel the frame callback, unmount its panel, and discard late lookups or grading responses using a navigation generation counter. Bind the main video within `#movie_player`. If the player is missing or gets replaced, observe for it for up to five seconds, then leave playback alone and offer a retry when possible. A new route must bind to ready content for that route before arming a pause, especially when YouTube reuses its video element.

**Pause rule.** Load and validate the complete exercise before arming. Evaluate each sample while the document is visible, normal content is playing, and the practice panel can mount. Prefer `requestVideoFrameCallback` with `timeupdate` as a fallback. Claim an eligible breakpoint synchronously when `previousTime < pauseAtS <= currentTime` and `currentTime < revealAtS`. Recheck the active video, ad state, fullscreen state, and actual `video.currentTime`, then pause and open the panel. A claim can happen once per breakpoint per watch session. If rendering fails after the pause, release the claim and resume only if the extension still owns that pause. Use the native player as the fallback if playback cannot resume. [Video frame callback](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)

**Seeks and interruptions.** Reset the baseline on seeks, ad transitions, hidden-tab transitions, and player replacement. Never pause on an ad, in fullscreen, or on the first sample after a jump. A learner who jumps past a breakpoint can open it from the badge. Rewinding before a missed breakpoint lets it trigger during normal playback. Solved and skipped breakpoints stay consumed for the current watch session. If exercise data arrives after the pause time, make practice available from the badge. Leave the playback position alone.

**Attempt and playback ownership.** Keep route state (`loading`, `ready`, `unsupported`, `unavailable`) separate from attempt state (`idle`, `editing`, `checking`, `failed`, `passed`). Store drafts under `videoId/exerciseId/revision` in `chrome.storage.local`. Debounce writes and flush when the panel closes. A wrong result or provider error leaves the learner at the pause with their draft. On a passing submission or explicit **Skip and watch**, resume from the paused frame if the extension still owns that pause. If the learner uses native play, seeks away, or changes videos, close the active attempt and ignore outstanding results. If `video.play()` rejects, keep a **Resume video** button visible and return focus to a reachable control.

## 6. Tailwind UI inside YouTube

Use T3 Code’s desktop screenshot as the visual reference. Its near-black canvas, thin borders, restrained status colors, compact icon buttons, and one clear composer action translate well to a narrow practice panel. Its source uses Tailwind utilities on owning components, shared control primitives, semantic theme variables, and Lucide icons. For Breakpoint, implement a small set of local components with that same organization. [T3 Code desktop preview](https://t3.codes/) · [T3 Code UI conventions](https://github.com/pingdotgg/t3code/blob/25bf84ab07f53f141c20239c63e383823a9d5ea0/docs/internals/web-ui.md) · [T3 Code theme CSS](https://github.com/pingdotgg/t3code/blob/25bf84ab07f53f141c20239c63e383823a9d5ea0/apps/web/src/index.css)

| Part | Specification |
| --- | --- |
| Placement | A quiet **Breakpoint · 1 exercise** badge near the player. At desktop widths, dock in YouTube’s right column when at least 360 px is available. Target 420 px. At narrower widths or in theater mode, mount in flow below the player. Keep the video, captions, controls, and scrub bar clear. If neither anchor is reliable, suspend auto-pause. |
| Theme | Proposed tokens `canvas #0B0B0C`, `panel #121214`, `editor #0E0E10`, `border #2B2B30`, `text #F4F4F5`, `muted #A1A1AA`, `accent #93C5FD`, `success #86EFAC`, `error #FCA5A5`. Use accent as the primary button background with dark text. Use status color with a label and icon. Verify contrast in the actual Chrome build. |
| Layout | 44 px header with label, Python badge, and named close button. Use 16 px padding, 8 px gaps, and 8–12 px radii. Show the title and concise problem first. Put examples in a disclosure, editor at roughly 220–280 px on desktop, and results below it. Keep **Skip and watch**, **Run**, and **Submit** visible in the footer. Put **Submit** at the far right as the single primary action. |
| Type and motion | System sans at 14 px for reading, 12 px for secondary labels, system mono at 13–14 px for code and test values. Use restrained hover states and an explicit two-pixel focus outline. Use a short panel transition and disable it for `prefers-reduced-motion`. Success is a compact inline banner that never blocks playback. |
| Input and feedback | Label the editor, expose a way to Tab out, and prevent YouTube hotkeys while editing. Test space, `j`, `k`, `l`, and `f`. Move focus to the panel heading on automatic open, announce results through `aria-live`, and restore focus to the badge or player after closing. Use real buttons and a reachable Skip control during grading. |

```text
YOUTUBE PLAYER                       BREAKPOINT             Python  [×]
Video paused at the exercise         Raise a number to a power
                                     Problem statement
                                     ▸ Example
                                     ┌─ main.py ───────────────────────┐
                                     │ 1  def raise_to_power(base, n):  │
                                     │ 2      pass                     │
                                     └─────────────────────────────────┘
                                     Results · Example 1 failed
                                     Skip and watch     [Run]  [Submit]
```

Mount the React UI through WXT `createShadowRootUi` with `cssInjectionMode: 'ui'`. Scope the Tailwind stylesheet and theme variables to the shadow UI. Use explicit pixel-based tokens for critical layout measurements because page-level `rem` can affect the panel. Use a normal CSS outline and border for essential states so they do not depend on Tailwind utility defaults that may fail in a shadow root. Pass the shadow root to CodeMirror, destroy the editor on teardown, and keep any floating UI within that root. Verify computed padding, borders, focus outline, and font sizes in the built extension before expanding the UI. [WXT Shadow Root UI](https://wxt.dev/guide/essentials/content-scripts#shadow-root) · [Tailwind Shadow DOM issue](https://github.com/tailwindlabs/tailwindcss/issues/15005)

## 7. Error checking and recovery

Use a stable API error shape `{ error: { code, message, retryable }, requestId }`. Log the request ID, stage, elapsed time, and relevant internal status. Keep keys, submitted code, and hidden test data out of logs. A debug-only playback trace should include the expected pause, observed media time, and the reason it paused or skipped.

| Condition | Required behavior |
| --- | --- |
| Transcript is missing, empty, or has invalid timestamps | CLI exits nonzero with `TRANSCRIPT_UNAVAILABLE` or `INVALID_TRANSCRIPT`. No candidate proceeds to publishing. |
| Gemini unavailable or returns malformed data | CLI exits nonzero with `PREP_PROVIDER_ERROR` or `INVALID_DRAFT`. Previous approved data stays usable. |
| No supported language, unclear challenge, or unsafe timing | Mark the candidate as held or unsupported with a reason. Publish zero breakpoints for it. |
| Unsupported video, player absent, or invalid response | Unsupported is normal playback. Player/response failure shows a discreet unavailable state where possible. No auto-pause without a ready panel and valid exercise. |
| Video changes or user skips while a result is pending | Invalidate the active attempt immediately. An old result cannot change the new panel or resume a different video. |
| Empty/oversized code, unknown exercise, or stale revision | `422 INVALID_CODE`, `404 EXERCISE_NOT_FOUND`, or `409 STALE_EXERCISE`. Preserve the draft and present the next action. |
| Incorrect, syntax error, exception, time limit, or malformed sandbox output | A completed grade returns `wrong_answer`, `syntax_error`, `runtime_error`, `time_limit`, or `invalid_output`. Keep playback paused and the editor usable. |
| Judge0 down, queue deadline exceeded, or capacity reached | `503 GRADER_UNAVAILABLE`, `504 GRADER_TIMEOUT`, or `429 BUSY`. Re-enable controls, keep the draft, and offer retry or skip. Never turn a missing result into a pass. |
| Chrome refuses to resume | Show **Resume video** and allow native Play. Keep the solved or skipped state so it cannot trigger the same breakpoint again. |

## 8. Test plan and release gates

| Layer | Required checks | Pass condition |
| --- | --- | --- |
| Prep unit tests · pytest | Fixture for a valid Python transcript, missing or out-of-order cues, invalid model cue IDs, spoken reveal before visual and vice versa, clipping offset, overlapping setup/reveal, unknown language, missing reveal, invalid structured response, and a failed rerun. | Only safe and reviewed records publish. An invalid rerun leaves the approved file unchanged. |
| API and grading · pytest with stubbed Judge0 | Supported and unknown IDs, malformed request, stale revision, visible vs hidden output, incorrect and correct code, forged verdict text, bool vs int, malformed output, sandbox timeout, upstream error, and concurrency saturation. | Hidden values never appear in browser JSON. Only a full Submit pass is accepted. Error codes and retry flags match §7. |
| Playback unit tests · Vitest | Exact threshold and crossing, two samples around one threshold, 2× timeline, seek forward/back, ad and visibility resets, data arriving late, fullscreen, player replacement, delayed response from prior video, and play rejection. | Exactly one eligible pause. No pause after reveal or during suppressed playback. No stale response can control a new session. |
| Extension end to end · Playwright | Load built MV3 extension in persistent Chromium. Serve a small watch-page fixture at an intercepted `www.youtube.com/watch` URL with a controllable video and fake navigation. Point the worker at a local test API. Cover badge → pause → Run fail → Submit pass → resume, skip during grading, and browser reload with draft recovery. | Same extension build path as the demo. An API failure never traps playback. Screenshot dark panel in editing, failed, and passed states at 1440×900 and narrow layout at 1024×768. [Playwright extension testing](https://playwright.dev/docs/chrome-extensions) |
| Real YouTube · desktop Chrome | Use the exact lead video with captions, at 1× and 2×. Check normal/theater layout, keyboard-only use, tab change, a seek across the breakpoint, and navigation between a prepared and unsupported video. Check ad behavior when available and cover it deterministically in the fixture. | Three clean foreground walkthroughs. Pause occurs from `pauseAtS` through `pauseAtS + 0.5` video seconds and before either reveal. Native playback controls stay usable and the intended video resumes. |

Add `npm run typecheck`, `npm test` (Vitest), `npm run test:e2e` (Playwright), and `npm run build` in the extension. Run `npx playwright install chromium` once. From `backend/`, run `.\.venv\Scripts\python.exe -m pytest -q`. Run the default suites without external provider keys. Keep one separately invoked live Gemini scan and one live Judge0 smoke run as integration gates. On the demo connection, target a prepared badge within two seconds of player readiness and a full grade within eight seconds. Log measured times during rehearsals, including slow or failed runs.

## 9. Build order

1. **First integration.** Agree on the public JSON fixture. Mount one Tailwind panel in a real YouTube watch page. Use fixture timing to prove automatic detection, pause, and Skip. In parallel, test Gemini on the freeCodeCamp transcript excerpt and Judge0 on three known inputs.
2. **Complete the core loop.** Serve the reviewed exercise through FastAPI. Connect the editor, draft recovery, and real grader. Prove Run failure, Submit pass, and automatic resume on the original video. Record a clean backup take once this works.
3. **Lock the demo.** Run the failure matrix, verify UI screenshots and keyboard behavior, and rehearse three times. Keep the reviewed exercise files and the unpacked build on the demo laptop.
4. **Extend after the release gates pass.** Prepare the second video with the same CLI. Put matching at the end of the backlog.
