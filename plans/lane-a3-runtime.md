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
- [x] Merged B2/B1 main through ba1666e. Runtime uses B2's `conceptLevels`, `feedback: {result, submittedCode}`, and `manualResume`; removed the duplicate adjacent FeedbackCard. Concept errors/rejected resume and TopicNotAvailable use the real components.
- [x] Watch-page Practice settings mounts B2's controlled settings view with videoId, enabling Never pause on this video. Writes use A3's preference helper and report storage errors; the shared storage observer enforces changes across tabs.
- [x] Eight additional isolated built-MV3 desktop/narrow probes passed: coding and concept submission, exactly one feedback view, explicit Resume, passed-event emission, not-coding dismissal, and per-video opt-out. 74 unit tests, typecheck, default build and diff check pass after integration. The temporary probes were removed; permanent plan E2E remains B2-owned.
- [x] Merged main through 2bd68c4 per lead request 6716821430, including A1 planner registration/languages and B2 account-aware drafts/language labels. The wired accountId/language props now reach those components. Rechecked 74 unit tests, typecheck, default build, ten desktop/narrow account-draft and language presentation checks, and 51 planner tests (one skipped).
- [ ] B2 still configures the installed non-Python parser modes and fixes editor collapse. Refresher orchestration and timeline markers remain separate follow-up work; timeline work starts after PR #5 lands (6716740412).
- [x] Added B2-requested pinned JavaScript/Java/C++/SQL/Rust/legacy CodeMirror parser dependencies (6716718913) to the owned package/lockfile and wired the optional exercise.language prop. B2 configures parser modes in its editor; no B2 files changed.
- [ ] User's hint/editor-collapse bug is confirmed in live Edge and reported in 6716739252: on the prepared exponent challenge at 2:43:23, three hints reduce the editor card from 211.33px to 1.33px (scrollHeight 210px). B2 owns the CSS fix. Before/after screenshots captured; no user code/draft changed and no grading performed. This is Edge evidence, not manual Chrome acceptance or full live v2 acceptance.

The long-hint fix shipped separately as 02172aa (PR #2), merged by Divakar with green CI. The app watcher is the sole listener, explicitly authorized by the human; no CLI watcher is needed.

## Timeline follow-up (lead assignment 6716886899)
- [x] PR #5 merged as 7392da8. Runtime baseline after sync: 74 Vitest and typecheck passed.
- [x] Timeline model filters to current ready/frequency-eligible content and finite video duration, exposes coding/concept metadata and upcoming/attempted/passed states, and supports deliberate reopening of consumed tasks. Previously passed tasks are marked review-only and do not emit practice progress events.
- [x] Marker seek waits for paused media at the requested timestamp; native play, source replacement, timeout, navigation and account changes cancel it. Selection revalidates the current plan/route/player before opening. A separate shadow rail aligns above YouTube's native seekbar and is removed on navigation. No native controls are replaced.
- [x] Fourteen new unit tests pass (88 total), plus two isolated built-MV3 desktop/narrow probes with a temporary presentation fixture: coding/concept selection, correct seek, completed-review no duplicate passed events, native controls intact, route cleanup. Temporary probe files removed. This validates runtime wiring, not B2's final visuals or real YouTube timeline acceptance.
- [ ] B2 TimelineMarkers export/interface handoff requested in 6716896022; lead reiterated in 6716931587. The optional export is absent on the current main, so the production build deliberately renders no rail until B2 provides it (build currently warns about the absent export). Do not mark timeline complete or the follow-up PR ready before integrating/testing the real component. B2 owns clustering, keyboard list, lightbulb appearance and quieter Practice later.
- [ ] After timeline presentation and editor-collapse fix land, run the main build on real YouTube: coding pause, concept question, unavailable topic, refresher and profile popup. Refresher orchestration remains unwired in A3; report/fix that owned gap during the walkthrough. Existing Edge evidence only covers the prepared exponent pause and collapse reproduction.
