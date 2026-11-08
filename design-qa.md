# Wide Workbench design QA

Status: PASS for the selected UI scope, 2026-11-08. Review branch only; not merged to main.

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
