Import `PracticePanel` and `Badge` from their named modules. Import
`src/ui/theme.css` once in the WXT content entrypoint using `cssInjectionMode: 'ui'`.
Props match `contracts/README.md`; `PracticePanel` imports `Breakpoint` and
`SubmissionResponse` types from `src/contracts.ts`.

The caller owns docking, playback, attempt cancellation and route lifetime.
Unmount on close/navigation and focus the badge or player after automatic closes.
The panel focuses its heading on mount and restores the previously focused control
on unmount. Mount in an open shadow root so CodeMirror receives that root.
Draft keys are `videoId/exerciseId/revision`; writes debounce for 350 ms and flush
on close, Skip and teardown. Storage failure never delays Skip.

Standalone acceptance preview (after E1 dependencies are installed):

```sh
node node_modules/@playwright/test/cli.js test --config tests/e2e/preview.config.ts
```

This preview runs the real panel in a shadow root with localStorage standing in
for Chrome storage. It captures editing, failed and passed screenshots at both
required viewport sizes. It does not validate extension loading, Chrome storage,
the service worker, automatic pause/resume or real YouTube placement; U4 must test
those against the built MV3 extension once E4 lands.

T6 exports `TestMeControls` from `src/ui/TestMeControls.tsx`. It consumes
`TestMeContext`; a null context renders nothing. The content-script owner must
import it and render `<TestMeControls />` inside the existing provider and
`.breakpoint-shell`, **outside** the `session.route !== 'unsupported'` badge
condition and before the practice-panel wrapper. No props or contract changes
are required. This mounting change landed in `9e2448a`. Build with
`WXT_TESTME_ENABLED=true` to enable it; the component preview alone does not
validate playback or worker integration. See `tests/e2e/test-me.spec.ts` for the
opt-in built-extension checks.

Loading and error panels keep Close/Resume available; retryable errors offer
Try again. The shared `PracticePanel` reads `aiGenerated` from the same context
and labels editing, results, and Solved. `SET_EXPIRED` retains the editable draft
and disables both grading buttons and editor grading shortcuts; Close and Skip
remain available. Playback and late-result cancellation remain caller-owned.
