# R3 release evidence

Captured from checkpoint `d056427`, using the production MV3 extension in fresh
persistent Chromium profiles and a loopback fixture API on port 8019. No external
provider calls. Desktop is 1440×900; narrow is 1024×768.

- Six failure screenshots per viewport: five real HTTP API errors plus the actual
  worker's 15-second network timeout. Each test verifies unchanged draft and
  paused media time, enabled Run/Submit, keyboard Skip, resume and draft recovery
  after reload. STALE_EXERCISE also reloads the catalog and uses its new revision.
- Eight theme screenshots per viewport: dark/light editing, wrong answer, API
  error and solved with browser resume rejected so the solved state stays visible.
  The fixture page background remains dark; the panel uses YouTube's theme flag.
- All 16 release checks passed. `panel-audit.ts` checks rendered text (including
  Python highlighting) against WCAG AA contrast thresholds and checks control
  names, tab eligibility, heading/result announcements and keyboard focus.
  Contrast fixes for muted text, light success text and light comments are in
  `d056427`.

This is a focused automated audit, not axe or full WCAG certification. Manual
desktop Chrome, screen reader, forced-color and zoom checks are not certified by
these images. The Playwright assertions cover draft persistence and playback;
screenshots show the rendered failure states.

Reproduce from `extension/` with port 8019 and 4173 free:

```powershell
$env:WXT_API_BASE_URL = 'http://127.0.0.1:8019'
npm.cmd run test:e2e -- --project mv3-desktop --project mv3-narrow --grep 'draft survives|panel meets'
```

Windows sandbox note: all 16 assertions passed, but Playwright's web-server
cleanup waited until its own leftover Vite process was stopped; the command then
reported `16 passed` and exited 0. No application/backend process was stopped.
