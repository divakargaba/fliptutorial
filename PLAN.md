# Build plan — Breakpoint

Status: **BUILD**. Integration branch: `main` (pull --rebase, never force-push).
Spec: `docs/PRD.md` (source of truth). Shared contracts: `contracts/README.md`.

Breakpoint is a Chrome extension (WXT + React + Tailwind + CodeMirror) plus a local
FastAPI backend that grades Python through Judge0. It is **not** the Next.js /
Supabase / Vercel starter in `web/`; leave `web/` untouched.

Demo target: one working Python exercise on freeCodeCamp *Learn Python – Full Course
for Beginners* (`rfscVS0vtbw`), Exponent Function chapter (`9680–10033` s).
Fallback window: Building a Basic Calculator (`52:37–58:27`).

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
| @divakargaba (Divakar, lead) | Contracts, video prep pipeline, exercise content, integration | `contracts/`, `docs/`, `PLAN.md`, `HACKATHON.md`, `AGENTS.md`, `backend/app/prepare.py`, `backend/content/`, `backend/tests/test_prepare.py`, `backend/tests/fixtures/transcripts/` |
| @abdullahwarraich (Abdullah) | Backend API + Judge0 grader | `backend/app/main.py`, `backend/app/catalog.py`, `backend/app/grader.py`, `backend/app/__init__.py`, `backend/requirements.txt`, `backend/.env.example`, `backend/tests/` (except `test_prepare.py` and transcript fixtures), `backend/README.md` |
| @abdullahwarv2 (Abdullah2) | Extension shell, worker, playback engine | `extension/package.json`, `extension/package-lock.json`, `extension/wxt.config.ts`, `extension/tsconfig.json`, `extension/vitest.config.ts`, `extension/entrypoints/`, `extension/src/playback.ts`, `extension/src/contracts.ts`, `extension/src/api.ts`, `extension/tests/unit/` |
| @reyanshBadhwar26 (Reyansh) | Extension UI, editor, drafts, E2E | `extension/src/ui/`, `extension/src/drafts.ts`, `extension/assets/`, `extension/tests/e2e/`, `extension/playwright.config.ts` |
| @spectaboy | Not assigned yet | None — do not claim work |

Need a dependency in a file you don't own (e.g. Reyansh needs an npm package)?
Ask the owner on the board with the exact change.

## Assignments

Work top to bottom. Mark State in this table when shipped or blocked (only your rows).

| ID | Owner | Deliverable and acceptance check | Depends on | State |
| --- | --- | --- | --- | --- |
| D0 | @divakargaba | `contracts/` fixtures + README (public response, approved record, submission response, messages, panel props). | — | Done |
| D1 | @divakargaba | `backend/content/seeds.json` + transcript excerpt JSON for `rfscVS0vtbw` 9680–10033 s (`start_s`, `end_s`, `text`, stable cue ids) in `backend/content/transcripts/`. If the transcript can't be fetched automatically, post exactly what Divakar must paste. | — | Todo |
| D2 | @divakargaba | `app.prepare scan/verify/publish` per PRD §3: transcript validation errors, Gemini structured-output candidate detection with cue-id checks, safe-pause math, verify runs reference + known-wrong solution, publish revalidates digest and writes atomically to `content/approved/`. Use `catalog.py` models from B2. pytest `backend/tests/test_prepare.py` covers PRD §8 prep rows with a stubbed Gemini. | B2 models | Todo |
| D3 | @divakargaba | Reviewed approved exercise for `rfscVS0vtbw` (exponent): visible example(s), ≥3 hidden cases (zero exponent, zero base, negative base odd exponent), reference + wrong solution verified. Timing (`setup_end_s`, reveals, `pause_at_s`) needs Divakar to confirm in the video at 1× and 2× — post the proposed times and ask him. | D1, D2 | Todo |
| D4 | @divakargaba | Integration: run backend + built extension together on the real video, record measured badge/grade times in this file, three clean walkthroughs. | all | Todo |
| B1 | @abdullahwarraich | `backend/` skeleton: `requirements.txt` pinned (fastapi, uvicorn[standard], httpx, pydantic, google-genai, python-dotenv, pytest), `.env.example` (GEMINI_API_KEY, GEMINI_MODEL, JUDGE0_BASE_URL, JUDGE0_PYTHON_LANGUAGE_ID, Judge0 auth vars), `app/__init__.py`, `backend/README.md` run commands for macOS and Windows. Post when pushed (unblocks D2). | — | Todo |
| B2 | @abdullahwarraich | `app/catalog.py`: Pydantic models matching `contracts/approved-record.fixture.json` and the public response; loads `content/approved/*.json` only, fails startup naming file + field; builds public response explicitly (no hidden data). Post the model names to @divakargaba when pushed. | B1 | Todo |
| B3 | @abdullahwarraich | `app/main.py`: `/health`, `GET /v1/videos/{id}/practice`, `POST /v1/submissions`, error shape + request ids, CORS/host for the extension origin, logging without code/keys/hidden data. | B2 | Todo |
| B4 | @abdullahwarraich | `app/grader.py`: Judge0 adapter per PRD §4 (one isolated run per case, fixed wrapper emitting JSON, compare outside sandbox, strict types, caps 16 KiB code / 8 KiB output, 3 concurrent cases, 2 s CPU / 4 s wall, 12 s deadline, 2 active grades per backend, structured timeout). Confirm the Python 3 language id via `GET /languages` and whether the host needs auth; ask Divakar for any key. | B3 | Todo |
| B5 | @abdullahwarraich | pytest with stubbed Judge0 covering every PRD §8 API row; uses `contracts/practice-response.fixture.json`. One opt-in live Judge0 smoke test (skipped without env). | B3, B4 | Todo |
| E1 | @abdullahwarv2 | `extension/` via WXT React template (npm), Tailwind 4 via `@tailwindcss/vite`, deps (codemirror, @codemirror/lang-python, lucide-react, zod, vitest, @playwright/test), manifest: top-frame content script on `https://www.youtube.com/*`, host permission `http://127.0.0.1/*`, `storage`. `npm run typecheck/test/build/test:e2e` scripts exist. Commit lockfile. **Post as soon as it builds — unblocks Reyansh.** | — | Todo |
| E2 | @abdullahwarv2 | `src/contracts.ts` Zod schemas for public response, submission response, error shape; Vitest parses the contract fixtures. | E1 | Todo |
| E3 | @abdullahwarv2 | `entrypoints/background.ts`: listener registered synchronously in `defineBackground`, accepts only typed `lookup`/`grade` messages from the YouTube content script, builds paths itself from `WXT_API_BASE_URL`, 3 s / 15 s timeouts, Zod-validates responses, no keys in the bundle. | E2 | Todo |
| E4 | @abdullahwarv2 | `src/playback.ts` (pure) + `entrypoints/youtube.content.tsx`: route detection (`yt-navigate-finish` + poll), navigation generation counter, player binding/replacement (5 s observe), pause rule with `requestVideoFrameCallback`/`timeupdate`, seek/ad/visibility/fullscreen resets, claim-once, resume ownership, attempt state machine; mounts Reyansh's `Badge`/`PracticePanel` through `createShadowRootUi` (`cssInjectionMode: 'ui'`). Until UI lands, mount a stub that matches the props contract. | E2, E3 | Todo |
| E5 | @abdullahwarv2 | Vitest playback suite for every PRD §8 playback row. | E4 | Todo |
| U1 | @reyanshBadhwar26 | `src/ui/` Tailwind theme tokens + `PracticePanel` and `Badge` per PRD §6 and `contracts/README.md` props, rendered from the fixture; pixel tokens, explicit focus outline, reduced-motion. Start with a standalone preview if E1 isn't pushed yet, then move in. Post to @abdullahwarv2 when the components are importable. | E1 | Todo |
| U2 | @reyanshBadhwar26 | CodeMirror 6 Python editor inside the shadow root (labelled, Tab-out, stops YouTube hotkeys space/j/k/l/f, destroyed on teardown); results list with `aria-live`; Skip reachable during grading; Resume video button. | U1 | Todo |
| U3 | @reyanshBadhwar26 | `src/drafts.ts` (chrome.storage.local, debounced, flush on close) wired into the panel. | U1 | Todo |
| U4 | @reyanshBadhwar26 | Playwright E2E per PRD §8: persistent Chromium with the built MV3 extension, intercepted `www.youtube.com/watch` fixture page with a controllable video, local test API; badge → pause → Run fail → Submit pass → resume, skip during grading, reload draft recovery; screenshots editing/failed/passed at 1440×900 and 1024×768. | E4, U2, U3 | Todo |

## Handoffs (who to @mention)

- B1 pushed → @divakargaba. B2 models pushed → @divakargaba. B3 serving fixture → @abdullahwarv2 @reyanshBadhwar26.
- E1 builds → @reyanshBadhwar26. E3 worker ready → @reyanshBadhwar26.
- U1 components importable → @abdullahwarv2. U2/U3 done → @abdullahwarv2.
- D3 approved file pushed → @abdullahwarraich @abdullahwarv2.
- Anyone changing a contract → ask @divakargaba first.

## Measured results (fill during integration)

| Check | Result |
| --- | --- |
| Badge visible after player ready (target ≤ 2 s) | TBD |
| Full grade round trip (target ≤ 8 s) | TBD |
| Real YouTube walkthroughs (need 3 clean) | TBD |
