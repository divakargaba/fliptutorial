# Lane B2 · UI: every learner-facing view (@reyanshBadhwar26, Reyansh)

Branch `lane/b2-ui`. Contracts: `extension/src/v2/types.ts`, fixtures in `contracts/v2/`. Polish comes last; function first.

## Owns
`extension/src/ui/` (incl. new `src/ui/v2/`), `extension/src/profile-ui/`, `extension/entrypoints/popup/`, `extension/src/drafts.ts`,
`extension/tests/e2e/`, `extension/tests/showcase/`, `extension/assets/`, `extension/playwright.config.ts`.

## Goal
1. `src/ui/v2`: `ConceptQuestionPanel` (multiple choice, short answer, predict output) with feedback; `FeedbackCard` showing concept + level, success explanation, optimization (only when `show`), and the misconception with **line highlights in the editor** from `diagnosis.lines`; `TopicNotAvailable`.
2. Level display in the panel (concept chip with "Beginner II"), and a level-up moment.
3. Profile page in the toolbar popup (`entrypoints/popup` + `src/profile-ui`): per-concept levels Beginner I → Expert X with progress bars, strength/decay, highlights ("Python loops · 5 challenges passed across 3 tutorials"), top 3 in-demand skills with video links, complementary teammates, test-account switcher.
4. Refresher prompt: a small card on YouTube when `refresherDue` is non-empty.
5. Learner settings UI for lane A3's controls (frequency, auto-pause off, never on this video).
6. Showcase states for every new view; screenshots at 1440×900 and 1024×768, light and dark.

## Proof
Preview/MV3 Playwright against the v2 fixtures; contrast check on new views.

## Status
- [x] Implemented concept questions (all three formats), feedback and exact-line CodeMirror diagnosis snapshots, unavailable topic, level chips/level-up, refresher and controlled settings views in `extension/src/ui/v2/`.
- [x] Implemented real local-profile popup with account selection, XP progress, strength/decay, highlights, up to three recommendations and complementary profiles. Fixture-only data stays in the showcase/tests.
- [x] Added optional `conceptLevels`, `levelUp`, `feedback: {result, submittedCode}` and `manualResume` to `PracticePanel`; concept questions accept optional API-shaped `error` and `canResume` per A3 request #6716380716.
- [x] Aligned settings with lead #6716393647: `breakpoint:learner-settings` stores `{frequency,autoPause,disabledVideos}`, `breakpoint:active-account` stores an account id. Popup writes serialize; errors preserve controls. A3 helper import remains pending its files being synced by the runner.
- [x] Added fixture showcase and preview/MV3 popup browser coverage in owned E2E paths. See `extension/src/ui/v2/README.md` for stable props, callbacks and reproduction commands.
- [ ] Integration blocked on the runner syncing lead contract clarification `5874edc` and A3's published runtime/preferences implementation into this lane. This checkout started at `d8c5b2f`; `extension/src/plan/` still contains only the stub `index.ts`. After sync: call A3 preference helpers, import frozen settings constants, implement the lead-assigned `tests/e2e/plan.spec.ts` coverage (planning→ready, coding/concept pauses, unavailable/no-captions, settings/account changes), and add the permanent long-hint→Next hint regression against the merged fix.

Validation: final typecheck, 45/45 Vitest, default production build and 26/26 focused browser checks passed (24 v2 plus desktop/narrow TOO_EARLY recovery). The broader default run printed 106/107 passes before cleanup; its preview failure and a subsequent screenshot navigation interruption occurred while source/docs were being edited. Both cleared in the final frozen-source run. Sampled new primary/secondary text meets 4.5:1 in both themes and viewports. Preserved 68 showcase screenshots (17 states × 2 themes × 2 viewports) plus 2 built-popup screenshots in `extension/assets/ui-checks/v2/`; representative question, diagnosis, profile, coding-level and deliberate-resume captures were visually inspected.

No provider calls, backend edits, shared-contract edits, git mutations or board posts were made. Board whoami/unread succeeded via a temporary script with its cursor outside `.git`; authenticated login was `reyanshBadhwar26`. Windows later rejected ordinary command creation with error 1909; final checks ran through the available Node runtime. Final browser run used a temporary port-4174 config, removed afterward. No test listeners remained on ports 4173/4174 after cleanup. Runner handoff is in `.autopilot/post.md`.
