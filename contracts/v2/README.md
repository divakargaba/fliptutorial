# Contracts v2: any-video practice + profile (frozen; owner @divakargaba)

Roadmap: `docs/ROADMAP.md`. Lanes and owners: `PLAN.md` → "Roadmap v2". Build against these
fixtures, not against another lane's running code. Field changes go through the lead only.

## Shared vocabularies
- `levels.json`: per-concept level scale, `beginner-1` (Beginner I) … `expert-10` (Expert X), 25 ranks with XP
  thresholds. Everyone starts at `beginner-1` on every concept. Optimization feedback is shown only from tier
  `intermediate` upward.
- `concepts.json`: stable concept ids (`loops`, `recursion`, `sql-joins`, `react-state`, …). Every exercise,
  question, feedback result and event is tagged with these ids.
- Languages: `python`, `javascript`, `typescript`, `java`, `cpp`, `c`, `csharp`, `go`, `rust`, `sql`, `pseudocode`, `unknown`.

## 1. Exercise plan (lane A1 produces, A3 consumes): `exercise-plan*.fixture.json`
- `status`: `planning` (still working; poll) | `ready` | `not_coding` (show "topic not available") | `no_captions` | `error`.
- `verdict`: whole-video decision with `reason` and timestamped `evidence` lines.
- `sections[]`: `{ id, startS, endS, title, qualifies, format: code|theory|mixed|off_topic, language, concepts[], evidence[] }`.
- `pauses[]`: `{ id, sectionId, pauseAtS, revealAtS|null, kind: coding|concept, rank, ready, exercise|question }`.
  - Auto-pause only when `ready: true` and the exercise/question is present ("pause only when ready").
  - `rank` drives the learner's frequency setting: few = rank 1, normal = rank ≤ 2, many = all.
  - `exercise` (coding): `{ id, revision, title, language, statement, starterCode, examples[], concepts[], level, aiGenerated }`.
  - `question` (concept): `{ id, revision, title, style: multiple_choice|short_answer|predict_output, prompt, choices[]?, concepts[], level, aiGenerated }`.
  - Answers, reference solutions and hidden tests never appear in the plan.
- Endpoints (A1): `POST /v2/plan { videoId, learnerLevel?, learnerLevels? }` → plan (may be `planning`); `GET /v2/plan/{videoId}` → latest plan.
  `learnerLevel` is the default level (omit → `beginner-1`); `learnerLevels` is an optional map `{ conceptId: levelId }` the
  planner uses once a section's concepts are known. A3 sends the active account's known concept levels in this map.
  Plans are cached per video so the next viewer gets it instantly.

## 2. Feedback result (lane A2 produces, A3/B2 consume): `feedback-result.*.fixture.json`
- `{ exerciseId, outcome: passed|failed, concept {id,name}, assessedLevel, summary, success|null, diagnosis|null, aiGenerated }`.
- `success`: `{ explanation, optimization: { show, learner {time,space}, best {time,space}, tip, betterSolution|null } }`.
  `show` is false for beginner tiers even when a faster solution exists.
- `diagnosis`: `{ misconception {id,name,explanation}, lines [{line, note}], failingCase {args, expected, actual, error}|null }`
  (1-based line numbers into the learner's code, for highlighting).
- Endpoints (A2): `POST /v2/submit { exerciseId, revision, language, code, mode: run|submit, learnerLevel }`
  → `{ grade: <v1 submission response>, feedback: FeedbackResult }`;
  `POST /v2/answer { questionId, revision, answer, learnerLevel }` → `{ correct, feedback: FeedbackResult }`;
  `POST /v2/hint { exerciseId, revision, code, hintLevel, learnerLevel, lastResult? }` → v1 hint response.

## 3. Practice event (A3 emits, B1 consumes): `practice-events.fixture.json`
- `{ id, accountId, at, type, videoId?, exerciseId?, concepts[]?, level?, attempts?, hintsUsed?, hintLevel?, optimal?, misconception?, correct?, watchedS? }`.
- `type`: `watched` (with `watchedS: [start, end]`, actual playback only) | `practiced` | `passed` | `failed` | `skipped` | `hint_used` | `refresher_answered`.
- Endpoint (B1): `POST /v2/events { events: [...] }` (idempotent by `id`).

## 4. Public profile (B1 produces, B2 consumes): `public-profile.fixture.json`
- `{ accountId, displayName, public, skills [{concept, level, levelName, xp, strength 0..1, lastPracticedAt, passed, tutorials}], highlights[], refresherDue[{concept, reason}], topInDemand[{concept, reason, videoUrl}], complements[{accountId, displayName, why}] }`.
- `GET /v2/profile/{accountId}/level/{concept}` → `{ accountId, concept, level, levelName, rank, xp, strength }`
  (unknown concept → `beginner-1`, rank 1, xp 0, strength 0). `GET /v2/profile/{accountId}/levels` → `{ accountId, levels: { conceptId: levelId } }`.
- Endpoints (B1): `GET /v2/accounts` (local test accounts), `GET /v2/profile/{accountId}`, `GET /v2/profile/{accountId}/level/{concept}`,
  `GET /v2/refresher/{accountId}` → one refresher question or 204, `GET /v2/skills/in-demand`, `GET /v2/matches/{accountId}`.

Accounts are local test accounts (`test-ana`, `test-ben`, …); there is no sign-in and no hosting in this release.

## 5. Extension local storage (A3 owns reads/writes; B2's popup/settings UI uses A3's helpers)
- `breakpoint:learner-settings` → `{ frequency: 'few'|'normal'|'many', autoPause: boolean, disabledVideos: string[] }`
  (default `{ frequency: 'normal', autoPause: true, disabledVideos: [] }`).
- `breakpoint:active-account` → account id string (default `test-ana`).
