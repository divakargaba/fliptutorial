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
- [x] Runtime core implemented on `lane/a3-runtime`: strict v2 validation, ready/rank scheduling, cancellable polling, settings/account observation, per-account solves, honest watch intervals and durable event delivery.
- [x] Level-aware planning uses `/v2/profile/{id}/levels`; polls repeat the exact idempotent POST body (A1 clarification 6716434820), so another account's latest GET cannot replace this learner's map. Submit/answer/hint read the active concept level with beginner fallback.
- [x] Shared popup helpers: `src/plan/preferences.ts` exports `loadLearnerSettings`, `saveLearnerSettings`, `loadActiveAccount`, `setActiveAccount`. Save failures propagate to the UI. Constants follow `src/v2/types.ts`.
- [x] Unit/typecheck validation: 74 Vitest tests pass. Includes scheduler readiness/ranks, controls, navigation cancellation, account/revision storage isolation, watch segments, offline/restart/partial-ACK event delivery, and API identity checks.
- [x] Existing prepared/Test me integration: 54 opt-in MV3 checks passed on desktop/narrow (plus two default-off checks in a separate default build). No live-provider calls or manual Chrome claims.
- [ ] B2 integration and full v2 browser proof: B2 exports are still stubs on this base. Runtime releases an automatic pause if a concept panel renders empty. 14 temporary desktop/narrow fixture probes passed and exercise coding grading/events/resume, persisted solves, polling, controls, and safe playback for unavailable/stub views; they do not establish completed concept or not-available UI.
- [ ] PracticePanel needs B2's `manualResume`, `feedback`, `level`, and account-aware draft props. Current v2 holds success until explicit Resume; the existing v1 visual countdown must be replaced before integration is complete. `canResume` remains reserved for an actual browser play rejection. Runtime currently also mounts FeedbackCard adjacent to the panel; remove that fallback once B2 renders it internally.
- [ ] ConceptQuestionPanel needs B2's optional error/canResume props; line highlights and language-aware editor presentation remain B2-owned. Permanent `tests/e2e/plan.spec.ts` belongs to B2 per lead handoff 6716393647.

The long-hint fix shipped separately as 02172aa (PR #2), merged by Divakar with green CI. The app watcher is the sole listener, explicitly authorized by the human; no CLI watcher is needed.
