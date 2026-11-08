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

## Release round (finish the PRD)

| ID | Owner | Deliverable and acceptance check | State |
| --- | --- | --- | --- |
| R1 | @divakargaba | **Docs + CI for Breakpoint.** Replace the template `README.md` with Breakpoint: what it is, macOS and Windows setup (backend venv + `.env`, `npm ci && npm run build`, Load unpacked), demo links with timestamps for all 4 breakpoints, test commands, troubleshooting. Fill HACKATHON.md "Product decision". Change `.github/workflows/check.yml` to run backend pytest (Python 3.12) and extension typecheck/Vitest/build plus the preview Playwright suite (no provider keys); keep it green on GitHub. Add a five-minute demo script to PLAN.md (what to click, what to say, fallback). | Done |
| R2 | @abdullahwarraichh | **Backup demo recording (PRD §9.2–3).** Use your D5 harness with Playwright `recordVideo` at 1440×900 to record one clean take on real YouTube: badge → auto-pause at the exponent challenge → wrong Run → correct Submit → Solved → resume. Also record a short take of the calculator one. Commit the `.webm` files to `demo/` (Git LFS not needed if < 25 MB each) and link them in PLAN.md. | Done: [`demo/exponent-challenge.webm`](demo/exponent-challenge.webm), [`demo/calculator-challenge.webm`](demo/calculator-challenge.webm); re-record with `node demo/record.mjs`; see Measured results |
| R3 | @reyanshBadhwar26 | **Failure matrix + accessibility (PRD §6–7).** Add MV3 E2E cases with screenshots for every grader/API failure the UI must handle: `GRADER_UNAVAILABLE`, `GRADER_TIMEOUT`, `BUSY`, `STALE_EXERCISE` (draft kept, exercise reloads), `INVALID_CODE`, network timeout. Each must keep the draft, keep playback paused and leave Skip reachable. Run an automated contrast/a11y check (e.g. axe-core in Playwright) on the panel in dark and light themes; fix anything below WCAG AA in `src/ui/`. | Done — 16/16 release MV3 checks; 28 screenshots in `extension/assets/ui-checks/release/`; browser-computed AA text contrast and focused accessibility audit (not axe/full conformance). See Measured results. |
| M1 | @abdullahwarv2 | Manual desktop-Chrome checks (assigned on the board): tab switch before a pause, ads, keyboard-only, light theme. | Todo |

## "Test me" feature (stretch scope, off by default)

Spec: `docs/TEST-ME.md` (Abdullah to export). A "Test me" button on any captioned
Python tutorial, including ones we never prepared. Pressing it pauses the video;
the backend takes the transcript up to that moment, has Gemini write a coding
exercise, checks it, and serves it in the same practice panel. Grading reuses
`/v1/submissions` and Judge0. v1 is coding exercise only; quiz is phase 2.

Rules: generated exercises are allowed only if the reference solution passes every
test and a known-wrong solution fails at least one (checked in Judge0, never on
our machine). Every generated screen says "AI-generated practice". Uses the team
Gemini key, capped at 10 sets per minute, with a cache. Goes in the demo only
after 3 clean runs on a video we never prepared.

New error codes: `NO_CAPTIONS` 404, `NOT_PYTHON` 422, `TOO_EARLY` 422 (under
180 s of transcript), `GENERATOR_UNAVAILABLE` 503, `GENERATOR_TIMEOUT` 504
(20 s), `SET_EXPIRED` 410.

| ID | Owner | Deliverable and acceptance check | Depends on | State |
| --- | --- | --- | --- | --- |
| T1 | @abdullahwarraichh | Runtime transcript fetch, clip and cache: `backend/app/transcripts.py` + tests. | — | Done |
| T2 | @abdullahwarraichh | Exercise generator (prompt, schema, rule and concept checks): `backend/app/testme.py` + tests. | T1 | Done: offline suite green; live generation is limited by Gemini latency and quota, see `docs/TEST-ME.md` |
| T3 | @divakargaba | Reference and wrong-solution checks through Judge0: new method in `grader.py`. Accepts a generated exercise (function name, reference solution, known-wrong solution, test cases), runs both through Judge0, returns pass/fail for each. Must confirm reference passes all tests and known-wrong fails at least one. | — | Done |
| T4 | @divakargaba | `POST /v1/test-me` endpoint in `main.py`: accepts `videoId` and `timestampS`, set cache with TTL, new error codes (`NO_CAPTIONS`, `NOT_PYTHON`, `TOO_EARLY`, `GENERATOR_UNAVAILABLE`, `GENERATOR_TIMEOUT`, `SET_EXPIRED`), catalog fallback for generated IDs, contract + fixture. | T2, T3 | Done (wired to T1; lazy-imports T2 testme.py — returns 503 until T2 lands) |
| T5 | @abdullahwarv2 | Background `testMe` message + Zod schema in `src/contracts.ts` and `entrypoints/background.ts`. | T4 contract | Done — `321936e`; worker accepts `testMe`, Zod validates public response and errors, 20 s timeout, content script pauses player, `TestMeContext` exposed for T6 |
| T6 | @reyanshBadhwar26 | "Test me" button in `src/ui/`, loading and error states, "AI-generated practice" label. | T5 | UI implemented; blocked on @abdullahwarv2 mounting `TestMeControls` inside the existing provider, outside the prepared badge condition. See `extension/src/ui/README.md`. |
| T7 | @abdullahwarraichh | Real-YouTube walkthrough on 2 unprepared videos at 1× and 2×, times in Measured results. 3 clean runs required. | T6 | Todo |
| T8 | @abdullahwarraichh, @divakargaba | Phase 2: quiz generation + `POST /v1/test-me/answer`. | T7 | Todo |
| T9 | @reyanshBadhwar26 | Phase 2: quiz view and score line in `src/ui/`. | T8 | Todo |

### Test-me handoffs

- T1 pushed → @abdullahwarraichh starts T2.
- T3 pushed → @divakargaba ready for T4 once T2 lands.
- T4 contract pushed → @abdullahwarv2 starts T5.
- T5 pushed → @reyanshBadhwar26 starts T6.
- T6 pushed → @abdullahwarraichh starts T7 walkthrough.

### Test-me owned paths (additions)

| Human | New paths |
| --- | --- |
| @abdullahwarraichh | `backend/app/transcripts.py`, `backend/app/testme.py`, `backend/tests/test_transcripts.py`, `backend/tests/test_testme.py` |
| @divakargaba | `backend/app/grader.py` (T3 additions), `backend/app/main.py` (T4 route), `docs/TEST-ME.md` approval |
| @abdullahwarv2 | `extension/src/contracts.ts` (T5 schema), `extension/entrypoints/background.ts` (T5 message) |
| @reyanshBadhwar26 | `extension/src/ui/` (T6 button + states) |

## Handoffs (who to @mention)

- B1 pushed → @abdullahwarraichh. B2 models pushed → @abdullahwarraichh. B3 serving fixture → @abdullahwarv2 @reyanshBadhwar26.
- E1 builds → @reyanshBadhwar26. E3 worker ready → @reyanshBadhwar26.
- U1 components importable → @abdullahwarv2. U2/U3 done → @abdullahwarv2.
- D3 approved file pushed → @divakargaba @abdullahwarv2.
- Anyone changing a contract → ask @divakargaba first.

## Measured results (fill during integration)

| Check | Result |
| --- | --- |
| T6 UI component validation | Typecheck, **38 Vitest**, production build, and **75/75 Playwright** checks passed (24 new T6 component checks + 51 existing preview/MV3 checks), desktop 1440×900 and narrow 1024×768. Tests cover null/disabled context, loading cancellation, eight generation errors and retry, AI-generated labels through Run/Solved, and expired-set draft recovery with disabled grading and dark/light AA text contrast. Final command exited 0 after stopping its own leftover Vite process; Windows sandbox process launches failed with error 1909 during cleanup, so an approved host command stopped only test PID 45208. No provider calls; backend unchanged and not retested. Component preview callbacks are simulated: actual Test me mounting, worker/player integration and live generation remain unverified pending @abdullahwarv2's content-script mount of `TestMeControls` (see `extension/src/ui/README.md`) and T2. T9 remains gated on T8 after T7. |
| R3 release failure matrix + accessibility | Validated checkpoint `d056427`: **16/16 MV3 release checks passed**, desktop 1440×900 and narrow 1024×768. HTTP `GRADER_UNAVAILABLE`, `GRADER_TIMEOUT`, `BUSY`, `STALE_EXERCISE`, `INVALID_CODE`, plus the real 15 s worker network timeout preserve the multiline draft and paused media time, re-enable grading, allow keyboard Skip/resume and recover the draft after reload. Stale revision reload and subsequent request revision are asserted. Dark/light editing, wrong-answer, API-error and solved states pass browser-computed AA text contrast (including Python syntax) and focused accessibility checks (names, tab eligibility, heading/live results, keyboard entry/exit and focus outline). Muted text, light success text and light comment contrast fixes are in the checkpoint. **28 screenshots**: `extension/assets/ui-checks/release/`. Typecheck and **31 Vitest** pass; production build passes through the Playwright web-server command. Tests use a loopback fixture API on :8019, no provider calls. Windows sandbox cleanup required stopping only the test's leftover Vite process before Playwright reported `16 passed` and exited 0. This focused audit is not axe/full WCAG certification; manual desktop Chrome, screen-reader, forced-color and zoom checks remain unverified here. |
| Badge visible after player ready (target ≤ 2 s) | U6 final: **0.581 / 0.592 / 0.135 s** on consecutive cold profiles. Prior D4: 2.46 s (cold first launch), 1.46 s, 1.44 s; first run missed the target before the fix |
| Full grade round trip (target ≤ 8 s) | Submit click → video playing: 4.97 s, 4.20 s, 3.78 s (8/8 cases, live Judge0). Run with wrong code → failed result: 2.69 s, 1.43 s, 1.99 s |
| Real YouTube walkthroughs (need 3 clean) | 3/3 clean on 2026-11-07: `rfscVS0vtbw&t=9790s`, 1440×900, at 1×, 2× and 1×. Paused at 9803.341 / 9803.338 / 9803.333 s (window 9803.32–9803.82, before the 9805.32 reveal). A wrong Run kept the video paused; Submit resumed the same video and closed the panel; unsupported video `jNQXAC9IVRw` showed no badge. No pre-roll ad played, so ad behaviour is covered only by the U4 fixture |
| Second video `nLRL_NcnK-4` (P1) | Harvard CS50P on freeCodeCamp, Lecture 1 `grade.py` (window 8100–8400 s, ASR captions; the video has no uploader track). Live scan with `gemini-flash-latest` returned 0 candidates here and also on the known-good `rfscVS0vtbw` window, so `GEMINI_MODEL=gemini-2.5-flash` was used for the scan. Setup ends 8212.0 s, spoken reveal 8216.679 s (`c08216679`), visual reveal 8217.0 s (Gemini video review), pause 8214.679 s. `get_grade(score)`: 2 visible, 9 hidden boundary cases; the `>` instead of `>=` solution fails. 3/3 clean on 2026-11-07 (headed Chromium, fresh profile each, built MV3 at `f176c23`, local backend, live Judge0, `&t=8195s`, 1440×900) at 1×, 2× and 1×: badge 0.05 / 0.59 / 0.72 s after `readyState ≥ 1`; paused at 8214.704 / 8214.706 / 8214.695 s; wrong Run → Wrong answer in 2.35 / 1.95 / 1.83 s, video still paused; Submit → Solved 5.00 / 5.66 / 5.47 s (11 cases), → video playing 6.60 / 7.32 / 7.12 s (includes the 1.6 s solved hold); panel closed, badge shows 1 of 1 solved. Unsupported `jNQXAC9IVRw` showed no badge. No pre-roll ad played. Tried first: freeCodeCamp *Python for Beginners* `eWRfhZUzrAc` (Recursion, RPS nested-if): 0 candidates, since the instructor demonstrates instead of setting a separable task |
| U6 cold badge, after UI redesign + P3 integration | **0.581 s, 0.592 s, 0.135 s** on three consecutive fresh headed Chromium profiles, built MV3, real `rfscVS0vtbw`, local FastAPI. All meet <=2 s. Readiness = first media `readyState >= 2`; badge = actionable ready state with its rectangle inside the viewport, sampled every 10 ms. Browser caches/storage and the worker are cold; backend stays running. Earlier unmodified-build rehearsals were 2.878 / 3.165 / 3.291 s; an intermediate integrated build had a worker connection failure on launch 3, before the final bounded retry fix. |
| U5 real YouTube, integrated redesigned UI | Seek across to 9804.4 s did not pause. Rewind re-armed and paused at **9803.342 s**, inside 9803.32–9803.82 and before reveal. Keyboard Tab into/out of editor, space/j/k/l/f isolation, wrong Run staying paused, passing Submit/resume, and theater relocation below the player with draft preserved passed against live Judge0. Keyboard badge open / Close / Skip passed in fresh real-video profiles. Submit -> panel closed + video playing took **8.48 s**, including the new 1.6 s solved hold and exit animation: over the 8 s target in this run. No live ad appeared in the validated run. |
| D5 full real-YouTube regression at `953ad44` | **31/31 checks passed** on 2026-11-07: headed Chromium, one persistent profile, built MV3, local FastAPI, live `ce.judge0.com`, 1440×900, 1×. Screenshots: `extension/assets/ui-checks/real/01–19`. In-page seeks (`video.currentTime` and `movie_player.seekTo`) stall in automated Chromium (stuck `seeking` at readyState 1, **also with no extension loaded**), so each breakpoint was reached by a `&t=` load ~6 s before it in the same profile. `rfscVS0vtbw`: calculator paused 3338.021 s (Skip → playing, badge "2 challenges left · at 1:35:48"), new session re-paused 3338.025 s; cube 5748.019 s; exponent 9803.328 s; all before their reveals. Wrong Run → Wrong answer, video still paused: 2.38 / 1.86 / 1.86 s. Submit → Solved: 3.89 / 4.42 / 3.90 s (7 / 7 / 8 tests); Submit → playing + panel closed: 5.13 s (auto) / 4.85 s ("Resume now" → playing in 68 ms) / 5.16 s (auto); Solved seen → auto-resume about 1.25 s after the heading became visible (1.6 s hold starts at the grade reply). Badge: "3 challenges · at 55:38" → "Practicing now · 1 of 3" → "2 challenges left · at 1:35:48" → "Practicing now · 2 of 3" → "1 challenge left · at 2:43:23" → "Practicing now · 3 of 3" → "All challenges solved" (label "3 of 3 solved"). Reload: badge still 3 of 3 solved; playing across 3338 / 5748 / 9803.32 did not pause. `nLRL_NcnK-4`: paused 8214.687 s; the known-wrong `>` solution passes both visible examples (Run → "Examples passed" in 1.86 s, still paused), Submit → Wrong answer 7/11 in 5.92 s, still paused; reference Submit → Solved 4.38 s (11 tests), playing 5.57 s; badge "Challenge solved" (1 of 1). Badge after ready ≤ 0.51 s on every load. **Content issue:** at the calculator pause (55:38) the video frame already shows `result = num1 + num2` (`02-calculator-paused.png`), so the answer is on screen; cube and grade frames show only the `def` line / blank file. No ad played. |
| R2 backup demo recording at `80aed5a` | 2026-11-07, headed Chromium, fresh profile per take, built MV3, local FastAPI, live Judge0, Playwright `recordVideo` 1440×900, 1×, no audio. Recorder: `demo/record.mjs` (loads `&t=` about 6 s before the pause; no in-page seeks). **Exponent** [`demo/exponent-challenge.webm`](demo/exponent-challenge.webm) (58 s, 8.5 MB): badge → paused 9803.455 s (before the 9805.32 reveal) → `return base_num * pow_num` Run → Wrong answer 0/2, video still paused → loop solution Submit → Solved (8 tests) in 5.69 s → playing at 7.61 s, panel closed, badge "2 challenges left · at 55:38". **Calculator** [`demo/calculator-challenge.webm`](demo/calculator-challenge.webm) (59 s, 8.9 MB): paused 3338.018 s → `return a + b` Submit → Solved 8.87 s → playing 10.53 s (Judge0 was slow on this take, so it missed the 8 s target). The first ~18 s of each take is YouTube page load and buffering; trim it when editing. At the pause the calculator frame already shows `result = num1 + num2` (the known D5 content issue). No ad played. |
| U5 desktop verification limits / handoff | This desktop kept both controlled Chromium pages `visible`, even after disabling Playwright focus emulation, so **real hidden-tab crossing remains unverified**. Live ads and hand-driven Chrome/captions/native-control inspection remain manual. Exact two-minute steps and opt-in replay commands: `extension/tests/e2e/README.md`. Deterministic ad, seek/visibility unit, theater, hydration and keyboard checks remain green; no document visibility or media methods are replaced in the real-video runner. |

R3 final regression: **35/35 existing preview + MV3 checks also passed** after
the 16 release cases (51/51 total, split with complementary grep filters).
Both commands rebuilt the production extension and exited 0. Each needed only
its own leftover Vite test server stopped to finish Windows sandbox cleanup.
No tests were skipped. Backend tests were not rerun for this UI/E2E-only work.
T6 consumes the T5 context handoff; the UI is implemented, with the final
content-script mount pending @abdullahwarv2 (see `extension/src/ui/README.md`).
T9 remains gated on T8, which starts only after T7 passes.

Final T6 board check: @abdullahwarraichh announced T2 complete at `03e00f4`;
that commit is not yet in this checkout (runner handles sync). The same post
asks @divakargaba to resolve live model quota/reliability before T7. T6 UI has
not made provider calls or changed provider configuration.

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

## Five-minute demo script

**Before the demo:** backend running on 127.0.0.1:8000, built extension loaded
unpacked in Chrome, a fresh Chrome profile (no prior solved state). Verify
`curl http://127.0.0.1:8000/health` returns `{"status":"ok"}`.

| Time | Action | What to say |
|------|--------|-------------|
| 0:00 | Open Chrome. Show the extension is loaded at `chrome://extensions`. | "Breakpoint is a Chrome extension that adds coding practice to YouTube tutorials. It works with real freeCodeCamp videos." |
| 0:20 | Navigate to `youtube.com/watch?v=rfscVS0vtbw&t=3330s` (calculator chapter). Point at the badge that appears near the player. | "The badge shows three challenges on this video. The video plays normally until it reaches a breakpoint." |
| 0:40 | Let the video play to 55:38. It pauses automatically and the practice panel opens. | "Right before the instructor shows how to add two numbers, the video pauses and this panel opens. The learner hasn't seen the answer yet." |
| 1:00 | Read the problem statement aloud. Expand the example. Type a wrong solution: `return num1 - num2`. Click **Run**. | "You get a code editor right here. Let me try a wrong answer first — Run checks it against the visible examples." |
| 1:20 | Show the failed result. Fix the code to `return num1 + num2`. Click **Submit**. | "It failed. Let me fix it and Submit, which runs all the hidden tests too." |
| 1:50 | Watch the Solved banner appear and the video auto-resume. | "Passed — the video picks up exactly where it paused. Now the learner can watch the instructor's approach and compare." |
| 2:10 | Click **Skip and watch** on the cube breakpoint when it pauses (or let it play to 1:35:42). | "If a learner wants to skip a challenge, they click Skip and the video continues. The badge updates." |
| 2:30 | Navigate to `youtube.com/watch?v=nLRL_NcnK-4&t=8209s` (CS50P grade exercise). Wait for the pause. | "It also works on other freeCodeCamp videos. This is Harvard's CS50P on the same channel — a different exercise." |
| 2:50 | Type the correct solution, Submit, watch it pass and resume. | "Same flow: write code, submit, video resumes." |
| 3:20 | Go back to `rfscVS0vtbw&t=9797s` for the exponent challenge. Show the badge says "1 challenge left." Solve it. | "Back on the first video. The badge tracks progress — one challenge left. Let me solve it." |
| 3:50 | After solving, show badge says "All challenges solved." Reload the page — badge still shows solved. | "All solved. Progress is saved in Chrome's local storage, so it persists across reloads." |
| 4:10 | Open an unsupported video (any non-prepared YouTube video). Show no badge appears. | "On videos without prepared exercises, nothing happens. The extension is invisible." |
| 4:30 | Wrap up. | "Everything runs locally — a FastAPI backend, Judge0 for grading, no database or cloud. The exercises are reviewed and published from real transcripts using a Gemini-powered prep pipeline." |

**Fallback:** if Judge0 is slow or down, show the Run/Submit flow with a timeout
error, demonstrate that the draft is preserved, and click Skip to continue. If
the video has a pre-roll ad, wait for it — the extension does not pause during ads.
