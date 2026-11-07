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
