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
- [ ] Not started
