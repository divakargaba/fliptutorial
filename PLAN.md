# Build plan — Breakpoint

Status: **BUILD**. Integration branch: `main` (pull --rebase, never force-push).
Spec: `docs/PRD.md` (source of truth). Shared contracts: `contracts/README.md`.

Breakpoint is a Chrome extension (WXT + React + Tailwind + CodeMirror) plus a local
FastAPI backend that grades Python through Judge0. It is **not** the Next.js /
Supabase / Vercel starter in `web/`; leave `web/` untouched.

Demo target: three working Python exercises on freeCodeCamp *Learn Python – Full Course
for Beginners* (`rfscVS0vtbw`): Add two numbers (calculator chapter, 3338 s), Cube a
number (return statement chapter, 5748 s), and Raise a number to a power (exponent
chapter, 9803 s).

## Machine prerequisites (each human)

Node 24, npm, Python 3.12, desktop Chrome. macOS/Linux use
`python3.12 -m venv .venv` and `.venv/bin/python`; Windows uses the PRD's
`py -3.12` / `.\.venv\Scripts\python.exe` commands.

## Checks

```sh
# extension/
npm ci && npm run typecheck && npm test && npm run build && npm run test:e2e
# backend/
.venv/bin/python -m pytest -q
```
Default suites must pass without provider keys. Live Gemini scan and live Judge0 smoke run are separate gates.

## Ownership

| Human | Lane | Owned paths |
| --- | --- | --- |
| @divakargaba (Divakar, lead) | Contracts + backend API + Judge0 grader | `contracts/`, `docs/`, `PLAN.md`, `HACKATHON.md`, `AGENTS.md`, `backend/app/main.py`, `backend/app/catalog.py`, `backend/app/grader.py`, `backend/app/__init__.py`, `backend/requirements.txt`, `backend/.env.example`, `backend/tests/` (except `test_prepare.py` and transcript fixtures), `backend/README.md` |
| @abdullahwarraichh (Abdullah) | Video prep pipeline, exercise content, integration | `backend/app/prepare.py`, `backend/content/`, `backend/tests/test_prepare.py`, `backend/tests/fixtures/transcripts/` |
| @abdullahwarv2 (Abdullah2) | Extension shell, worker, playback engine | `extension/package.json`, `extension/package-lock.json`, `extension/wxt.config.ts`, `extension/tsconfig.json`, `extension/vitest.config.ts`, `extension/entrypoints/`, `extension/src/playback.ts`, `extension/src/contracts.ts`, `extension/src/api.ts`, `extension/tests/unit/` |
| @reyanshBadhwar26 (Reyansh) | Extension UI, editor, drafts, E2E | `extension/src/ui/`, `extension/src/drafts.ts`, `extension/assets/`, `extension/tests/e2e/`, `extension/playwright.config.ts` |
| @spectaboy | Not assigned yet | None — do not claim work |

The Gemini key goes only in the prep owner's gitignored `backend/.env` (`GEMINI_API_KEY`). The backend owner adds `backend/.env.example` and the venv in B1; until then the prep owner may create `backend/.env` locally.

Need a dependency in a file you don't own (e.g. Reyansh needs an npm package)?
Ask the owner on the board with the exact change.

## Assignments

Work top to bottom. Mark State in this table when shipped or blocked (only your rows).

| ID | Owner | Deliverable and acceptance check | Depends on | State |
| --- | --- | --- | --- | --- |
| D0 | @divakargaba | `contracts/` fixtures + README (public response, approved record, submission response, messages, panel props). | — | Done |
| D1 | @abdullahwarraichh | `backend/content/seeds.json` + transcript excerpt JSON for `rfscVS0vtbw` 9680–10033 s (`start_s`, `end_s`, `text`, stable cue ids) in `backend/content/transcripts/`. Fetch it yourself (e.g. `youtube-transcript-api` or `yt-dlp --write-auto-subs`, run outside the repo venv if needed); only if every method fails, ask @abdullahwarraichh on the board. | — | Done |
| D2 | @abdullahwarraichh | `app.prepare scan/verify/publish` per PRD §3: transcript validation errors, Gemini structured-output candidate detection with cue-id checks, safe-pause math, verify runs reference + known-wrong solution, publish revalidates digest and writes atomically to `content/approved/`. Use `catalog.py` models from B2. pytest `backend/tests/test_prepare.py` covers PRD §8 prep rows with a stubbed Gemini. | B2 models | Done (pytest run pending a venv with requirements installed) |
| D3 | @abdullahwarraichh | Reviewed approved exercise for `rfscVS0vtbw` (exponent): visible example(s), ≥3 hidden cases (zero exponent, zero base, negative base odd exponent), reference + wrong solution verified. Determine timing (`setup_end_s`, reveals, `pause_at_s`) yourself from the transcript plus Gemini video analysis of the YouTube URL; record the evidence in the draft. No human confirmation is required. | D1, D2 | Done — `verify` + `publish` reproduce `content/approved/rfscVS0vtbw.json` byte-for-byte (revision `rfscVS0vtbw-b1327bb5997acd01`) |
| D4 | @abdullahwarraichh | Integration: run backend + built extension together on the real video, record measured badge/grade times in this file, three clean walkthroughs. | all | Done — 3/3 clean Playwright-driven walkthroughs on real YouTube (headed Chromium, built MV3, local backend, live `ce.judge0.com`); see Measured results. Remaining: manual keyboard-only, theater, tab-change, seek-across and live-ad checks in desktop Chrome |
| B1 | @divakargaba | `backend/` skeleton: `requirements.txt` pinned (fastapi, uvicorn[standard], httpx, pydantic, google-genai, python-dotenv, pytest), `.env.example` (GEMINI_API_KEY, GEMINI_MODEL, JUDGE0_BASE_URL, JUDGE0_PYTHON_LANGUAGE_ID, Judge0 auth vars), `app/__init__.py`, `backend/README.md` run commands for macOS and Windows. Post to @abdullahwarraichh when pushed (unblocks D2). | — | Done |
| B2 | @divakargaba | `app/catalog.py`: Pydantic models matching `contracts/approved-record.fixture.json` and the public response; loads `content/approved/*.json` only, fails startup naming file + field; builds public response explicitly (no hidden data). Post the model names to @abdullahwarraichh when pushed. | B1 | Done |
| B3 | @divakargaba | `app/main.py`: `/health`, `GET /v1/videos/{id}/practice`, `POST /v1/submissions`, error shape + request ids, CORS/host for the extension origin, logging without code/keys/hidden data. | B2 | Done |
| B4 | @divakargaba | `app/grader.py`: Judge0 adapter per PRD §4 (one isolated run per case, fixed wrapper emitting JSON, compare outside sandbox, strict types, caps 16 KiB code / 8 KiB output, 3 concurrent cases, 2 s CPU / 4 s wall, 12 s deadline, 2 active grades per backend, structured timeout). Use `https://ce.judge0.com` (no key) unless it requires auth; confirm the Python 3 language id via `GET /languages`. | B3 | Done |
| B5 | @divakargaba | pytest with stubbed Judge0 covering every PRD §8 API row; uses `contracts/practice-response.fixture.json`. One opt-in live Judge0 smoke test (skipped without env). | B3, B4 | Done |
| E1 | @abdullahwarv2 | `extension/` via WXT React template (npm), Tailwind 4 via `@tailwindcss/vite`, deps (codemirror, @codemirror/lang-python, lucide-react, zod, vitest, @playwright/test), manifest: top-frame content script on `https://www.youtube.com/*`, host permission `http://127.0.0.1/*`, `storage`. `npm run typecheck/test/build/test:e2e` scripts exist. Commit lockfile. **Post as soon as it builds — unblocks Reyansh.** | — | Done |
| E2 | @abdullahwarv2 | `src/contracts.ts` Zod schemas for public response, submission response, error shape; Vitest parses the contract fixtures. | E1 | Done |
| E3 | @abdullahwarv2 | `entrypoints/background.ts`: listener registered synchronously in `defineBackground`, accepts only typed `lookup`/`grade` messages from the YouTube content script, builds paths itself from `WXT_API_BASE_URL`, 3 s / 15 s timeouts, Zod-validates responses, no keys in the bundle. | E2 | Done |
| E4 | @abdullahwarv2 | `src/playback.ts` (pure) + `entrypoints/youtube.content.tsx`: route detection (`yt-navigate-finish` + poll), navigation generation counter, player binding/replacement (5 s observe), pause rule with `requestVideoFrameCallback`/`timeupdate`, seek/ad/visibility/fullscreen resets, claim-once, resume ownership, attempt state machine; mounts Reyansh's `Badge`/`PracticePanel` through `createShadowRootUi` (`cssInjectionMode: 'ui'`). Until UI lands, mount a stub that matches the props contract. | E2, E3 | Done |
| E5 | @abdullahwarv2 | Vitest playback suite for every PRD §8 playback row. | E4 | Done |
| U1 | @reyanshBadhwar26 | `src/ui/` Tailwind theme tokens + `PracticePanel` and `Badge` per PRD §6 and `contracts/README.md` props, rendered from the fixture; pixel tokens, explicit focus outline, reduced-motion. Start with a standalone preview if E1 isn't pushed yet, then move in. Post to @abdullahwarv2 when the components are importable. | E1 | Done; integrated in built MV3 and verified by U4 |
| U2 | @reyanshBadhwar26 | CodeMirror 6 Python editor inside the shadow root (labelled, Tab-out, stops YouTube hotkeys space/j/k/l/f, destroyed on teardown); results list with `aria-live`; Skip reachable during grading; Resume video button. | U1 | Done; integrated in built MV3 and verified by U4 |
| U3 | @reyanshBadhwar26 | `src/drafts.ts` (chrome.storage.local, debounced, flush on close) wired into the panel. | U1 | Done; integrated in built MV3 and verified by U4 |
| U4 | @reyanshBadhwar26 | Playwright E2E per PRD §8: persistent Chromium with the built MV3 extension, intercepted `www.youtube.com/watch` fixture page with a controllable video, local test API; badge → pause → Run fail → Submit pass → resume, skip during grading, reload draft recovery; screenshots editing/failed/passed at 1440×900 and 1024×768. | E4, U2, U3 | Done; 14 built-MV3 + 12 preview checks pass; both viewport screenshot sets captured |
| U5 | @reyanshBadhwar26 | Real-YouTube checks in desktop Chrome on `rfscVS0vtbw` (built MV3 + local backend + live Judge0): keyboard-only flow (open, edit, Tab out, Run, Submit, Skip, close; space/j/k/l/f don't reach YouTube while editing), theater mode layout, tab change around the pause, seek across the breakpoint (no pause after a jump; badge reopens it; rewind re-arms), and ad behaviour if a pre-roll plays. Automate what you can with headed Chromium; anything only a person can verify, post the exact 2-minute steps for Reyansh to click through. Record results in Measured results. Fix any bug found. | U4, D4 | Done: automated checks and manual handoff delivered; hidden-tab/live-ad/desktop confirmation still pending |
| U6 | @reyanshBadhwar26 | Badge speed: cold first launch measured 2.46 s after player ready (target ≤ 2 s; warm 1.44 s). Find the cold-start cost (lookup timing, worker wake-up, mount/CSS) and fix it; show ≤ 2 s on 3 cold launches in Measured results. For U5/U6 you may edit `extension/entrypoints/`, `src/api.ts`, `src/playback.ts` (normally Abdullah2's) and `backend/app/main.py` if needed; keep `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e` and backend pytest green. | U4, D4 | Done: 0.581 / 0.592 / 0.135 s on three consecutive cold profiles; see Measured results |

## P1 assignments (nice-to-have, PRD §1)

| ID | Owner | Deliverable and acceptance check | State |
| --- | --- | --- | --- |
| P1 | @abdullahwarraichh | **Second reviewed video.** Pick another freeCodeCamp Python beginner tutorial with captions, add it to `seeds.json` + transcript excerpt, run `scan → verify → publish` with live Gemini, ship `content/approved/<videoId>.json` with one exercise that meets the same timing and test rules as `rfscVS0vtbw`. Run a real-YouTube walkthrough like D4 and record times. Needs `GEMINI_API_KEY` in your `backend/.env`; if missing, ask @divakargaba. | Done — CS50P `nLRL_NcnK-4` grade exercise (revision `nLRL_NcnK-4-0f3ae41a2cf4b7e5`), live `gemini-2.5-flash` scan → verify → publish; 3/3 clean real-YouTube walkthroughs, see Measured results |
| P2 | @divakargaba | **More challenges on `rfscVS0vtbw`.** Add 2 more breakpoints to the existing video using the prep pipeline: Building a Basic Calculator (`3157–3507` s) and one more earlier chapter with a clean, separable task. Same rules: safe pause before the first reveal, ≥1 visible example, ≥3 hidden cases, reference + known-wrong solution verified. Coordinate edits to `seeds.json` with @abdullahwarraichh (pull --rebase). Backend must serve all breakpoints sorted and non-overlapping. | Done — 3 breakpoints: calculator (3338 s), cube (5748 s), exponent (9803.32 s); verify + publish green; revision `rfscVS0vtbw-613a9bb880e97b69` |
| P3 | @abdullahwarv2 | **Local solved record + multi-breakpoint hardening.** New `extension/src/progress.ts`: `chrome.storage.local` record of solved exercises keyed `videoId/exerciseId/revision` (`markSolved`, `getSolved`, `listSolved`), with Vitest tests. Harden `src/playback.ts` for 2+ breakpoints per video (sequential pauses, skip one then hit the next, seek between them, consumed vs solved) with Vitest + a 2-breakpoint E2E fixture. **Do not edit `extension/src/ui/`** (Divakar is redesigning it) and keep `youtube.content.tsx` changes minimal: expose `solvedIds: Set<string>` for the UI to read; post the API when ready. | Done |

## Handoffs (who to @mention)

- B1 pushed → @abdullahwarraichh. B2 models pushed → @abdullahwarraichh. B3 serving fixture → @abdullahwarv2 @reyanshBadhwar26.
- E1 builds → @reyanshBadhwar26. E3 worker ready → @reyanshBadhwar26.
- U1 components importable → @abdullahwarv2. U2/U3 done → @abdullahwarv2.
- D3 approved file pushed → @divakargaba @abdullahwarv2.
- Anyone changing a contract → ask @divakargaba first.

## Measured results (fill during integration)

| Check | Result |
| --- | --- |
| Badge visible after player ready (target ≤ 2 s) | U6 final: **0.581 / 0.592 / 0.135 s** on consecutive cold profiles. Prior D4: 2.46 s (cold first launch), 1.46 s, 1.44 s; first run missed the target before the fix |
| Full grade round trip (target ≤ 8 s) | Submit click → video playing: 4.97 s, 4.20 s, 3.78 s (8/8 cases, live Judge0). Run with wrong code → failed result: 2.69 s, 1.43 s, 1.99 s |
| Real YouTube walkthroughs (need 3 clean) | 3/3 clean on 2026-11-07: `rfscVS0vtbw&t=9790s`, 1440×900, at 1×, 2× and 1×. Paused at 9803.341 / 9803.338 / 9803.333 s (window 9803.32–9803.82, before the 9805.32 reveal). A wrong Run kept the video paused; Submit resumed the same video and closed the panel; unsupported video `jNQXAC9IVRw` showed no badge. No pre-roll ad played, so ad behaviour is covered only by the U4 fixture |
| Second video `nLRL_NcnK-4` (P1) | Harvard CS50P on freeCodeCamp, Lecture 1 `grade.py` (window 8100–8400 s, ASR captions; the video has no uploader track). Live scan with `gemini-flash-latest` returned 0 candidates here and also on the known-good `rfscVS0vtbw` window, so `GEMINI_MODEL=gemini-2.5-flash` was used for the scan. Setup ends 8212.0 s, spoken reveal 8216.679 s (`c08216679`), visual reveal 8217.0 s (Gemini video review), pause 8214.679 s. `get_grade(score)`: 2 visible, 9 hidden boundary cases; the `>` instead of `>=` solution fails. 3/3 clean on 2026-11-07 (headed Chromium, fresh profile each, built MV3 at `f176c23`, local backend, live Judge0, `&t=8195s`, 1440×900) at 1×, 2× and 1×: badge 0.05 / 0.59 / 0.72 s after `readyState ≥ 1`; paused at 8214.704 / 8214.706 / 8214.695 s; wrong Run → Wrong answer in 2.35 / 1.95 / 1.83 s, video still paused; Submit → Solved 5.00 / 5.66 / 5.47 s (11 cases), → video playing 6.60 / 7.32 / 7.12 s (includes the 1.6 s solved hold); panel closed, badge shows 1 of 1 solved. Unsupported `jNQXAC9IVRw` showed no badge. No pre-roll ad played. Tried first: freeCodeCamp *Python for Beginners* `eWRfhZUzrAc` (Recursion, RPS nested-if): 0 candidates, since the instructor demonstrates instead of setting a separable task |
| U6 cold badge, after UI redesign + P3 integration | **0.581 s, 0.592 s, 0.135 s** on three consecutive fresh headed Chromium profiles, built MV3, real `rfscVS0vtbw`, local FastAPI. All meet <=2 s. Readiness = first media `readyState >= 2`; badge = actionable ready state with its rectangle inside the viewport, sampled every 10 ms. Browser caches/storage and the worker are cold; backend stays running. Earlier unmodified-build rehearsals were 2.878 / 3.165 / 3.291 s; an intermediate integrated build had a worker connection failure on launch 3, before the final bounded retry fix. |
| U5 real YouTube, integrated redesigned UI | Seek across to 9804.4 s did not pause. Rewind re-armed and paused at **9803.342 s**, inside 9803.32–9803.82 and before reveal. Keyboard Tab into/out of editor, space/j/k/l/f isolation, wrong Run staying paused, passing Submit/resume, and theater relocation below the player with draft preserved passed against live Judge0. Keyboard badge open / Close / Skip passed in fresh real-video profiles. Submit -> panel closed + video playing took **8.48 s**, including the new 1.6 s solved hold and exit animation: over the 8 s target in this run. No live ad appeared in the validated run. |
| U5 desktop verification limits / handoff | This desktop kept both controlled Chromium pages `visible`, even after disabling Playwright focus emulation, so **real hidden-tab crossing remains unverified**. Live ads and hand-driven Chrome/captions/native-control inspection remain manual. Exact two-minute steps and opt-in replay commands: `extension/tests/e2e/README.md`. Deterministic ad, seek/visibility unit, theater, hydration and keyboard checks remain green; no document visibility or media methods are replaced in the real-video runner. |

U6 startup diagnosis: the initial lookup took roughly 65–89 ms, while WXT's cold
stylesheet fetch held shadow mounting for about 2.15 s. YouTube also exposes a
temporary body-level player before the normal panel anchors exist. The content
script now starts at `document_end`, bundles styles inline through WXT's supported
`cssInjectionMode: 'manual'` + shadow UI `css` option, and shows an in-flow badge
after that temporary player. Automatic pause and panel opening stay suspended
until the normal watch layout provides an anchor. Shadow mounting fell to roughly
13–35 ms. Cold MV3 missing-listener failures get at most two lookup retries (100 /
300 ms) inside the original 3.5 s content deadline; grading is never retried.
The theater fix rechecks and moves the existing shadow host after initial player
observation expires, preserving the editor/draft and the lead's design.

U5/U6 validation: extension `npm ci`, typecheck, 31 Vitest tests, production build,
35/35 full Playwright checks and 6/6 focused final anchor checks passed. Editing,
failure and solved screenshots were refreshed at 1440x900 and 1024x768, with
finite animations disabled in captures so controls are visible. Backend pytest:
85 passed, 4 skipped. The real-video runner is opt-in and excluded from default
provider-free checks.

Final follow-up after rebasing onto P1 + P2 (`de2921d`): the real-video runner
accepts the three-challenge badge. Exponent seek/rewind paused at **9803.351 s**;
each editor hotkey individually preserved paused state, media time and non-fullscreen
state; keyboard Run/Submit and theater placement passed. Submit -> panel closed +
playing was **7.845 s** (under 8 s), with the earlier 8.48 s miss retained above.
Backend pytest on the rebased catalog: **85 passed, 4 skipped**. A prior tab-probe
attempt failed its focus assertion; restoring Playwright's default focus setting
after the probe fixed the harness, and the final run passed. Actual hidden-tab
crossing remains unverified; no ad appeared in the final run. No new checks are
pending beyond the explicit manual handoff.
