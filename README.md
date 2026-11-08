# Breakpoint

A Chrome extension that adds coding practice directly to YouTube programming
tutorials. Before the instructor reveals a solution, the video pauses and a
practice panel opens. Write your answer, run examples, submit — a correct
submission resumes playback so you can compare your approach with the instructor's.

**Stack:** Chrome extension (WXT + React + Tailwind + CodeMirror) with a local
FastAPI backend that grades Python through Judge0 CE.

## Demo breakpoints

The extension ships with four exercises across two freeCodeCamp videos:

| # | Video | Exercise | Pause at | Link |
|---|-------|----------|----------|------|
| 1 | Learn Python – Full Course for Beginners (`rfscVS0vtbw`) | Add two numbers | 55:38 | [youtube.com/watch?v=rfscVS0vtbw&t=3330s](https://www.youtube.com/watch?v=rfscVS0vtbw&t=3330s) |
| 2 | Learn Python – Full Course for Beginners (`rfscVS0vtbw`) | Cube a number | 1:35:42 | [youtube.com/watch?v=rfscVS0vtbw&t=5742s](https://www.youtube.com/watch?v=rfscVS0vtbw&t=5742s) |
| 3 | Learn Python – Full Course for Beginners (`rfscVS0vtbw`) | Raise a number to a power | 2:43:17 | [youtube.com/watch?v=rfscVS0vtbw&t=9797s](https://www.youtube.com/watch?v=rfscVS0vtbw&t=9797s) |
| 4 | CS50P – Full University Course (`nLRL_NcnK-4`) | Turn a score into a letter grade | 2:16:49 | [youtube.com/watch?v=nLRL_NcnK-4&t=8209s](https://www.youtube.com/watch?v=nLRL_NcnK-4&t=8209s) |

Start a few seconds before the pause time so the extension can arm the breakpoint.

## Prerequisites

- **Node.js 24** and npm
- **Python 3.12**
- **Desktop Chrome**
- Internet access (for YouTube and the Judge0 CE grading API)

## Setup

### Backend (FastAPI)

#### macOS / Linux

```sh
cd backend
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env   # fill in keys if needed (Judge0 CE works without auth)
```

#### Windows (PowerShell)

```powershell
cd backend
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env   # fill in keys if needed
```

### Extension

```sh
cd extension
npm ci
npx playwright install chromium   # needed for E2E tests
npm run build
```

## Run

### 1. Start the backend

#### macOS / Linux

```sh
cd backend
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --env-file .env
```

#### Windows (PowerShell)

```powershell
cd backend
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --env-file .env
```

Verify: `curl http://127.0.0.1:8000/health` should return `{"status":"ok"}`.

### 2. Load the extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (toggle in the top right).
3. Click **Load unpacked** and select `extension/.output/chrome-mv3`.
4. Open one of the demo links above and watch the video — it pauses automatically
   at the breakpoint.

For development iteration, use `npm run dev` in `extension/` and reload the
extension after changes.

## Tests

### Backend

```sh
# macOS / Linux
cd backend && .venv/bin/python -m pytest -q

# Windows
cd backend && .\.venv\Scripts\python.exe -m pytest -q
```

Default tests run without provider keys. A live Judge0 smoke test is skipped
unless `JUDGE0_BASE_URL` is set in the environment.

### Extension

```sh
cd extension
npm run typecheck      # TypeScript check
npm test               # Vitest unit tests
npm run build          # production build
npm run test:e2e       # Playwright E2E (preview + built MV3)
```

## Troubleshooting

- **Badge doesn't appear:** make sure the backend is running on port 8000 and
  the extension is loaded from `extension/.output/chrome-mv3`. Refresh the
  YouTube tab after loading.
- **Grading hangs:** Judge0 CE (`ce.judge0.com`) is a free shared service; it
  may be slow or rate-limited. The extension times out after 15 s and lets you
  retry or skip.
- **Extension build fails:** ensure you're on Node 24 (`node -v`) and ran
  `npm ci` in `extension/`.
- **Python version mismatch:** the backend requires Python 3.12. Check with
  `python3.12 --version` (macOS/Linux) or `py -3.12 --version` (Windows).
- **Port conflict:** if port 8000 is in use, stop the other process or change
  the uvicorn `--port` flag and set `WXT_API_BASE_URL` to the new origin before
  building the extension.


### Optional extra practice: Test me

Normal builds include **Test me** beside the lesson's challenge status. It creates
one checked coding exercise from captions leading up to the current video position,
including before three minutes and after the video ends. At the start or during an
intro with nothing codeable yet, it explains that more taught material is needed.
The local backend needs its existing provider and grader configuration. No special
flag is required; `WXT_TESTME_ENABLED=false` (extension build) and
`BREAKPOINT_TESTME=false` (backend) are explicit opt-outs only. Run `npm run build`
in `extension/`, reload the unpacked extension, then refresh the YouTube tab.
