# Extension acceptance checks

From `extension/`, install dependencies and Chromium once:

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

The existing npm command and `npx playwright test --config playwright.config.ts`
both run the preview checks and built MV3 checks. The suite builds the production
extension with the loopback test API origin before starting the preview server.
Keep ports 4173 and 8000 free; stop the development backend first. A port conflict
fails the suite rather than sending test submissions to a running backend.

MV3 checks use a fresh persistent Chromium profile per test and load
`.output/chrome-mv3` through browser CDP `Extensions.loadUnpacked`. The intercepted
YouTube watch page has a real canvas MediaStream, media clock, play/pause events,
desktop and narrow anchors, and an ad class. The extension's worker, validation,
shadow root, editor and Chrome storage run unchanged. A local HTTP server supplies
contract fixtures and controlled failed, successful, delayed and unavailable grades.
No provider credentials or provider requests are used.

T6 component checks (`test-me.preview.spec.ts`) use `?testme=on` in the shadow-root
preview with the real `TestMeContext`, controls and practice panel. They cover the
off/disabled states, loading cancellation, eight generation errors and explicit
retry, labels through Run and Solved, and expired-set draft recovery with disabled
grading in dark/light themes. These tests simulate the caller callbacks; they do
not prove worker requests, player pause/resume or mounting on an unprepared video.

T6 integration checks (`test-me.spec.ts`) exercise the mounted controls through
the production content script and service worker on an unprepared watch fixture:

```powershell
$env:WXT_TESTME_ENABLED = 'true'
npm.cmd run test:e2e -- --project mv3-desktop --project mv3-narrow --grep 'Test me through'
Remove-Item Env:WXT_TESTME_ENABLED
```

These opt-in checks cover generation pause/loading, setId grading, generated labels
through failure and Solved, rejected-resume recovery, six API generation errors,
explicit retries, cancellation/navigation/native playback during generation, and
expired-set draft recovery through Chrome storage. They use a local fixture API,
not FastAPI, captions, the Anthropic API or Judge0. The normal suite skips these opt-in cases
and checks that the default build hides Test me. T7 owns live provider validation.

The already-paused cases start real media, pause it with the native media method,
then open Test me and pass Submit. Both efficient and inefficient reviews must
request analysis with the generated exercise id and setId, show the verdict, and
keep the same paused frame beyond the solved hold. They require no countdown or
automatic-resume wording, the message "Video stayed paused where you left it",
and a primary **Resume video** button alongside Close. Clicking Resume video must
play the media. A cache-reopen case returns the same generated exercise twice
and requires a fresh review instead of the previous attempt's verdict, then
checks explicit resume too.

The previous review-only checks passed against `f6abdf1` at 1440×900 and 1024×768.
Following the lead's explicit-play decision (#6716127037), the UI now accepts
required `ownsPause: boolean` separately from `canResume` (play rejection).
Native-pause efficient/inefficient screenshots are refreshed in
`assets/ui-checks/hints-efficiency/{desktop,narrow}-test-me-native-pause-*.png`.
Integrated validation against `9c02edb`: all six checks pass at desktop 1440×900
and narrow 1024×768, including the final explicit-click playback assertion.
The refreshed four screenshots show the integrated learner-paused solved states;
the narrow captures scroll to keep Resume video visible. All 45 Vitest tests pass,
and the opt-in production build passes. Playwright exited 0 after stopping only
its leftover Vite server (PID 33344) during Windows cleanup.
Typecheck still fails at the lead-owned `tests/showcase/showcase.tsx:118`: its
ordinary panel caller must supply `ownsPause: true`. The production content-script
caller is integrated. No live providers, backend tests, full browser regression
or manual Chrome checks were run for this evidence/documentation update.

```powershell
$env:WXT_TESTME_ENABLED = 'true'
$env:WXT_API_BASE_URL = 'http://127.0.0.1:8019'
npm.cmd run test:e2e -- --project mv3-desktop --project mv3-narrow --grep 'already-paused|reopening a cached'
Remove-Item Env:WXT_TESTME_ENABLED, Env:WXT_API_BASE_URL
```

The rejected-resume case injects a rejected `play()` only in the content script's
isolated world, then restores it before checking the Resume video button. Other
flows use the browser's normal media methods.

Artifacts under `test-results/` include editing, failed and passed screenshots
from the actual unpacked extension at 1440×900 and 1024×768. The narrow fixture
asserts mounting below the player; desktop asserts the right-column anchor.

For just the built extension checks:

```sh
npm run test:e2e -- --project mv3-desktop --project mv3-narrow
```

These deterministic checks do not replace the real YouTube and live Judge0
walkthroughs owned by the integration lane in `PLAN.md`.

## Hint coach and efficiency review

`hints.spec.ts` runs the built MV3 extension at both viewport sizes, with local
`POST /v1/hints` and `POST /v1/analysis` routes based on the shared contract fixtures:

```sh
npm run test:e2e -- --project mv3-desktop --project mv3-narrow --grep "wrong Run explains|inefficient Submit|efficient Submit"
```

It checks failing-case feedback, hint levels 1–3 with prior-hint history and
official-doc links, no fourth hint, analysis only after a passed Submit, paused
playback while analysis is pending and after an inefficient verdict, the faster
solution disclosure, manual resume, and automatic resume after an efficient
verdict. Existing grading tests default to an efficient fixture verdict.
No Anthropic or Judge0 requests are made. The analysis fixture is an illustrative
pair-search result, not a correctness claim about the exponent exercise.

`ui.preview.spec.ts` also captures the existing showcase states `failed`, `solved`,
`solved-slow` and `solved-checking` in dark/light themes at both viewport sizes:

```sh
npm run test:e2e -- --project preview-desktop --project preview-narrow --grep "hint and efficiency showcase"
```

Reviewed captures live in `assets/ui-checks/hints-efficiency/`; regenerate them
from the matching Playwright PNG artifacts in `test-results/`. Showcase captures
use component stubs; the `mv3-` captures exercise the real extension messaging.

## Release failure matrix and contrast regression

`release.spec.ts` runs against the built MV3 worker at both viewport sizes:

```sh
npm run test:e2e -- --project mv3-desktop --project mv3-narrow --grep "draft survives|panel meets"
```

The local API returns real HTTP errors for `GRADER_UNAVAILABLE` (503),
`GRADER_TIMEOUT` (504), `BUSY` (429), `STALE_EXERCISE` (409) and
`INVALID_CODE` (422). The network timeout case withholds the HTTP response until
the production worker's 15-second fetch deadline; timers and worker replies are
not replaced. Every case checks the exact multiline draft, re-enabled grading
controls, unchanged paused media time, Tab from the editor through the hint button to Skip, Enter to
resume, and draft recovery from Chrome storage after reload. The stale case
also changes the catalog revision/title, observes another lookup and verifies
the next request uses the new revision with the original code.

The theme tests use `panel-audit.ts` to inspect rendered text in the actual shadow
root, including syntax highlighting, examples and results. It composites CSS
background colors and applies WCAG AA text thresholds (4.5:1 for normal text,
3:1 for large text), checks control names/tab eligibility and result announcements,
and verifies keyboard entry/exit plus the visible two-pixel Skip focus outline.
Editing, wrong-answer, API-error and solved states run in both YouTube themes.
JSON reports are attached to Playwright test results; screenshots are saved in
`test-results/`. Reviewed release evidence is copied to `assets/ui-checks/release/`.

This focused regression audit is not a full WCAG conformance certification or an
axe run. It does not assess every assistive technology, forced colors, zoom,
or every possible submitted program. Manual desktop checks remain in M1.

## Opt-in real YouTube rehearsal

Start the real backend on port 8000, then from `extension/`:

```sh
npm run build
node tests/e2e/real-youtube.mjs
node tests/e2e/real-youtube.mjs --checks
node tests/e2e/real-youtube.mjs --controls
```

The first `node` command launches three fresh headed Chromium profiles, each with the
production MV3 extension, empty browser caches/storage and a new worker. It samples
player readiness (`readyState >= 2`) and the enabled badge's viewport rectangle
every 10 ms, prints stage timings and asserts at most 2 seconds. The backend stays
running between launches; this measures browser/extension cold starts, not Python
process startup. `breakpoint-debug=1` enables performance marks without code or
exercise data. No YouTube requests are intercepted or media methods replaced.

`--checks` runs keyboard editing and hotkey isolation, live Judge0 Run/Submit,
theater placement, a seek across the threshold, hidden-tab crossing and rewind.
It disables Playwright's focus emulation to observe actual tab visibility.
If the desktop still keeps both pages visible, it reports the tab check as manual
instead of claiming a pass or replacing the document visibility property.
`--controls` checks keyboard badge opening, Skip and Close in fresh profiles.
These opt-in checks require network access and use the existing
public Judge0 service. They are excluded from the provider-free default suite.

### Two-minute desktop Chrome click-through for Reyansh

With the backend running, load `extension/.output/chrome-mv3` using **Load unpacked**
at `chrome://extensions` (Developer mode), then open
`https://www.youtube.com/watch?v=rfscVS0vtbw&t=9798s`.

1. Let the video play through 2:43:23.32. Check that it pauses and focus moves to
   the exercise heading. Tab into the editor, select all and type
   ` jklf`. Video stays paused; no seek or fullscreen occurs. Tab must reach
   Stuck? Get a hint, then Skip, Run and Submit. Shift+Tab from the heading must reach Close practice.
2. Toggle theater with the native player control during the open panel; the panel
   belongs below the player and never covers captions or the scrub bar. Check native
   controls with the mouse as well. Tab to Skip and press Enter to resume. Use Skip
   until the final submission below: successful solves now persist across reloads.
3. Reload at 2:43:18, play, and switch to a different tab until 2:43:26. Return:
   there should be no late pause. Rewind to 2:43:21 and play: it should pause once
   in the 2:43:23.32–2:43:23.82 window. Tab to Skip and press Enter to resume.
4. Reload, seek directly from before 2:43:23 to 2:43:26: no automatic pause. Tab to
   the badge and Enter should open practice. Close using the keyboard. If YouTube
   serves an ad, confirm no exercise interrupts it; check the normal pause after
   the ad ends. Report “no ad served” if none appears; do not claim a live-ad pass.

Finally reload at 2:43:18 and let the exponent challenge pause automatically. Enter
`def raise_to_power(base, exponent):` plus
an indented `return base ** exponent`. Tab to Submit and press Enter. Confirm all
tests pass, the solved moment appears, and the same video resumes. To repeat after
a successful solve, use a fresh test profile (saved progress suppresses it).

Repeat step 1 at 2× playback before the final Submit. These steps cover hand-driven
desktop Chrome and visual checks that automated Chromium assertions alone cannot certify.
