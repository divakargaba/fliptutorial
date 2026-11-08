# Wide Workbench design QA

Status: human-approved learning follow-up implemented and verified locally, 2026-11-08. Prior Option 3 is merged in main 7dffcc6; this follow-up remains on the review branch.

## Learning follow-up and black-style correction

The human rejected the gray cards, decorative color strips and teal tutorial panels. That feedback supersedes the earlier color exploration: the popup now uses a near-black page, black groups, quiet neutral borders and row dividers. Blue progress and meaningful recall/tier colors remain. Solved and XP use separate labeled columns in the shared skill row, including teammate profiles. Expanded demand/tutorial cards are neutral black. The stylesheet is included through the shared theme so preview shadow roots and the real popup receive identical rules.

The follow-up adds Home / Skills / History / Network navigation, skill details and deliberate review, immediate dismissible feedback above the footer, and explicit challenge position versus solved/skipped counts. In demand appears first on Home, not beneath Skills. Each new hint needs two fresh distinct completed edited-code attempts at that stage; previously tried code, blank/starter code and transport errors do not unlock it. Unlocked hints remain readable. The manifest now says “Practice coding and concepts while watching YouTube tutorials.” Long More-menu actions wrap within their button.

Passing Submit captures its exact submitted source into account-scoped browser-local history; Run and failed attempts do not save solutions. History is separate from drafts, bounded to 200 solutions per account / 16 KiB source per solution, with export/delete and timestamped revisit links. Learner/exercise review metadata is carried in the URL fragment, not sent as query parameters to YouTube. Only new submissions are recorded. Legacy exercises without concepts appear in History without inventing skill associations.

The optional backend `concept` query selects a learned active skill for deliberate review. Omission retains due-only behavior. Unknown concepts return 422; unlearned/inactive skills return 204. Existing answer grading is reused; deliberate popup review emits no progress/XP events. Watch-page due refresher event semantics are unchanged. This small API addition is isolated for owner review; no grading, XP computation or frozen response contract changes.

Verified: 118 unit tests, typecheck, default API-8000 build and diff check. The first full default browser run recorded 164 passed / 28 opt-in skipped / 11 failures. Those findings led to viewport/focus corrections, shared preview CSS inclusion and updated assertions for the new controls. The subsequent 70-scenario targeted run (including all 28 opt-in Test me cases) recorded 61 passes / 9 failures; the final corrective run passed all 14 selected cases, covering every remaining failure. This is combined targeted evidence, not a claim of a new single green full-suite run. Black own/teammate rows at 400px/320px, Home-first demand cards, short/150% editor layout, settings, per-hint attempts, held submissions, history export/delete/account isolation, popup review, real-media seek/reopen with preserved drafts and no duplicate pass event all pass. The fixture serves byte ranges for actual seekable WebM; repeated read-only award polling is distinguished from duplicate XP events.

Backend full suite reached 566 passed / 4 skipped / 10 existing Windows `signal.SIGALRM` failures; the same ten Python fixture outcomes passed with an isolated subprocess timeout harness. This is not a claim that native Windows SIGALRM tests passed. B1 owner @spectaboy approved the optional concept filter in board comment 6723502768. The patch is isolated in commit 510b14e.

Visual evidence: `C:/Users/Mico/.codex/visualizations/2026/11/07/01a1b7be-dbf5-75d3-9467-9883587443b4/learning-ui/` contains home-discovery.png, own-black-skills.png, teammate-black-skills.png, teammate-black-skills-narrow.png, popup-demand-expanded.png and the learning/history/drawer evidence. These use synthetic accounts. The default extension is rebuilt. The user stopped desktop Computer Use with Escape; no further desktop input was sent and the final build's loaded Edge state is unverified.

Browser tests now build into `.output/e2e/chrome-mv3`, separately from the user's normal `.output/chrome-mv3`. The fixture checks the configured isolated API origin before launching. Do not run a WXT default build during preview tests: generated type/config changes can trigger a Vite refresh even though extension bundles are isolated.

## Design target and scope

The human selected option 3, Wide Workbench, then approved a remembered Side / Below selector and popup changes. The primary visual target is the approved placement comparison:
`C:/Users/Mico/.codex/generated_images/01a1b7be-dbf5-75d3-9467-9883587443b4/exec-512696d3-ea70-46d5-b84f-a887f890c0bd.png`.
The original option 3 popup reference is `exec-ef468654-ae89-43c4-a6c3-bbe6a450d378.png` in that directory. Both were inspected against rendered component screenshots. App-owned regions were compared; mock browser/video imagery is not part of the implementation.

The repository's React/WXT/CodeMirror/Lucide/Motion stack and existing brand mark are retained. No dependency, backend, grading, planner, XP/event, or frozen contract changes. Layout is a separate local UI preference. Popup changes are a separate review commit because the lead requested review of the existing profile design before any merge; the human explicitly requested this popup work.

## Visual comparison

| Surface | Target and implementation | Evidence |
| --- | --- | --- |
| Below workbench | Flat dark surface, task left, dominant editor right, slim header, persistent footer; amber Submit and placement selection. No settings or practicing badge stacked above the active panel. | [Below](extension/tests/showcase/evidence/workbench/workbench-below.png) |
| Side workbench | Same mounted editor and draft; instructions initially collapsed, single-column workspace. Falls below in small/theater windows. | [Side](extension/tests/showcase/evidence/workbench/workbench-side.png) |
| Hints | One anchored overlay above the footer, bounded content scroll, saved hint history, close and Back to code. Typing dismisses it; no forced reading timeout. Editor geometry stays fixed. | [Hint](extension/tests/showcase/evidence/workbench/workbench-hint.png) |
| Popup | Existing Inter typography, profile hierarchy, and two-level grouping retained. Teal/blue/violet category icons/chips, green Rising text. Pause/frequency/placement settings in the existing sheet. | [Demand](extension/tests/showcase/evidence/workbench/popup-demand.png), [Settings](extension/tests/showcase/evidence/workbench/popup-settings.png) |
| Success and accessibility | Brief check/spark animation; static check for reduced motion. Focus rings and keyboard controls retained. Yellow emoji bulbs use native emoji fonts as explicitly requested. | [Success](extension/tests/showcase/evidence/workbench/workbench-success.png), [320px light](extension/tests/showcase/evidence/workbench/workspace-320-light-hint.png) |

Intentional differences from concept imagery: real exercise text and existing brand assets replace mock content; no invented avatar/video art. Existing popup type sizes and hierarchy take precedence over approximate mock text. The success animation is decorative and cannot trigger playback or scoring.

## Verification and iterations

- Built-MV3 desktop 1440x900 and narrow 1024x768; preview popup 400x600 and workspace 320px content in a 352x600 viewport. Short viewport / 150% zoom long-hint scenarios passed. Screenshots are CSS pixels, captured with animations disabled where needed.
- Checked layout, typography, colors/contrast, assets, copy, primary controls, keyboard focus, console errors, overflow, and placement persistence. Local Edge component previews were also inspected and operated manually through browser controls.
- Fixed: category padding lost to an existing shorthand; a three-column track reused for two placement buttons; settings focus resetting after selection; narrow footer clipping Submit; unmounting the badge removed the return-focus target.
- Replaced a full-page popup screenshot whose sticky header was captured mid-page with a normal viewport capture. This was an evidence artifact, not a product layout change.
- 114 unit tests pass; typecheck and normal API build pass. 90 distinct selected browser scenarios pass across the final targeted runs: 12 hint, 22 built-MV3 integration, and 56 preview cases. Initial failures were corrected and affected cases rerun. A draft-persistence test now waits for the existing debounced save before hard reload instead of racing it.
- Coverage includes same editor node/draft across placement moves, persistent placement, unchanged hint request limits/history, explicit resume, plan/refresher/recovery, account/draft isolation, popup preferences, reduced motion, light/dark states and long code. No remaining actionable P0/P1/P2 visual issue in these checked states.

## Limits and reproducibility

Screenshots use synthetic test accounts and fixture-backed exercises; they are not a new all-video/live-backend acceptance claim. The rebuilt normal local-backend extension was reloaded in Edge. Existing user drafts and backend process were preserved. The prior real YouTube walkthrough remains separate evidence.

Run from `extension/`: `npm.cmd test`, `npm.cmd run typecheck`, `npm.cmd run build`. Browser tests use `node node_modules/@playwright/test/cli.js test --config playwright.config.ts`; set `WXT_API_BASE_URL` to an isolated loopback port for MV3 fixture tests to avoid the user's backend, then restore the normal build before loading Edge. GitHub Actions is affected by the repository's previously reported billing/runner outage; local checks are the validation evidence, not a CI-green claim.

## Default-on Test me follow-up (2026-11-08)

The human requested Test me in normal builds, a quiet Bonus entry matching the approved workbench, and real generation proof. It is now an amber-outline compact action beside the scheduling badge; the toolbar hides while an exercise is open. Existing black/dark styling and the matching YouTube light theme remain intact. There is no fixed three-minute wait; zero/no-context is an honest unavailable state and ended video can request practice.

Validation: 118 unit tests, typecheck and normal production build; 154 focused backend tests; 58 default-build Test me browser scenarios, 2 explicit-opt-out scenarios, 68 affected workbench/learning/hints/release cases, and 14 plan/refresher/preferences cases. These are focused suites, not a full-matrix claim. The initial desktop integration test had obsolete Below-layout expectations; teammate #55 fixed them and both viewport cases pass after integrating that exact change. Plan recovery tests now select the scheduling badge specifically because Test me also uses badge styling.

Actual generation on Bro Code KWgYha0clzw returned verified exercises at 90s, 270s and 305s, with honest TOO_EARLY at 0s. An isolated Chromium profile loaded the normal production MV3 build against real YouTube and the local backend/provider: request at 90s, real generated sum_to task, failed starter Run, passing 6/6 Submit, local history confirmation and explicit Resume all passed. Existing user Edge tabs/drafts were not changed. Screenshot captures were visually inspected: toolbar, generated editor, immediate failure feedback, and success/resume; success capture disables animation to avoid faded transitional text. Fresh YouTube profile uses its light theme. This is selected Python live evidence, not an all-languages guarantee.

Evidence is outside the repository: `C:/Users/Mico/.codex/visualizations/2026/11/07/01a1b7be-dbf5-75d3-9467-9883587443b4/test-me/`, files `01-live-bonus-action.png`, `02-live-generated-at-90s.png`, `03-live-generated-panel.png`, `04-live-starter-feedback.png`, `05-live-generated-solved.png`, `live-browser-proof.json` and `live-0/90/270/305.json`. Initial harness attempts encountered a sleeping service worker and real YouTube ads; the final live run awaited usable main video without changing extension safety checks. GitHub runner/billing outage remains separate from this local validation.
