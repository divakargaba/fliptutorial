# Lane A3 · Runtime: the extension follows the plan (@abdullahwarv2, Abdullah2)

Branch `lane/a3-runtime`. Contracts: `contracts/v2/README.md` §1 (consume plan), §2 (consume feedback), §3 (emit events). Types: `extension/src/v2/types.ts`.

## Owns
`extension/entrypoints/youtube.content.tsx`, `extension/entrypoints/background.ts`, `extension/src/playback.ts`, `extension/src/api.ts`,
`extension/src/contracts.ts`, `extension/src/progress.ts`, `extension/src/plan/` (new), `extension/tests/unit/`.

## Goal
1. On any watch page: request `/v2/plan`, start playback immediately, auto-pause only at `ready` pauses (poll while `planning`).
2. Learner controls (stored locally): pause frequency few / normal / many (via `rank`), turn off auto-pause, "never on this video".
3. `not_coding` / `no_captions` → mount lane B2's `TopicNotAvailable` instead of a badge.
4. Coding pauses → existing panel + `/v2/submit`; concept pauses → B2's `ConceptQuestionPanel` + `/v2/answer`; pass FeedbackResult to B2's `FeedbackCard` (line highlights come from `diagnosis.lines`).
5. Honest watch time: count only real playback segments; emit PracticeEvents (`watched`, `failed`, `passed`, `skipped`, `hint_used`) to `/v2/events` with the active local test account; queue offline.
6. Send the learner's level for each concept (from `/v2/profile/{id}/level/{concept}`, default beginner-1) with plan, submit, answer and hint requests.
Keep today's prepared-video flow and Test me working.

## Proof
Vitest for scheduling by rank/frequency, controls, watch-time segments and event queueing; MV3 E2E against `exercise-plan.fixture.json` and `exercise-plan-not-coding.fixture.json` through a fixture API.

## Status
- [ ] Not started
