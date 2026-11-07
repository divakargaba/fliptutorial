# Shared contracts (owner: @divakargaba)

Change these only through the lead. Post on the board, mentioning everyone affected, when a contract changes.
Full product spec: `docs/PRD.md`.

## Files
- `practice-response.fixture.json` — public `GET /v1/videos/{videoId}/practice` body. Used by backend pytest (Pydantic) and extension Vitest (Zod). Never contains hidden tests, reference code or functionName-only fields.
- `approved-record.fixture.json` — private file shape for `backend/content/approved/{videoId}.json`. Written only by `app.prepare publish`, read by `app.catalog`.
- `submission-response.fixture.json` — completed-grade body of `POST /v1/submissions`.
- `testme-response.fixture.json` — public `POST /v1/test-me` body. Has the exercise shape plus `setId`, `generated: true`, `aiGenerated: true`. Used by extension Zod (T5). Never contains hidden tests, reference code or functionName.

## API (backend, local FastAPI on http://127.0.0.1:8000)
- `GET /health` → `200 {"status":"ok"}` when the catalog loaded.
- `GET /v1/videos/{videoId}/practice` → fixture shape; unknown id → `200 {"schemaVersion":1,"videoId":..,"revision":null,"status":"unsupported","breakpoints":[]}`; malformed id (not `[A-Za-z0-9_-]{11}`) → `422`.
- `POST /v1/submissions` body `{ "exerciseId", "revision", "mode": "run"|"submit", "code" }`.
  - `outcome`: `passed | wrong_answer | syntax_error | runtime_error | time_limit | invalid_output`.
  - `results[]` rows: `{ kind: "visible"|"hidden", index, passed, args?, expected?, actual?, diagnostic? }`. Hidden rows carry only `kind`, `index`, `passed`.
  - Only `mode: submit` + `outcome: passed` may resume the video.
- `POST /v1/test-me` body `{ "videoId", "timestampS" }` — generates a coding exercise from the transcript up to `timestampS`. Returns the same exercise shape as a breakpoint exercise, plus `"generated": true` and `"setId"` for cache lookups. Grading reuses `/v1/submissions`. Generated exercises carry an `"aiGenerated": true` flag. The set expires after a TTL; submitting against an expired set returns `SET_EXPIRED` 410.
- Errors: `{ "error": { "code", "message", "retryable" }, "requestId" }`.
  Codes: `INVALID_CODE` 422, `EXERCISE_NOT_FOUND` 404, `STALE_EXERCISE` 409, `BUSY` 429, `GRADER_UNAVAILABLE` 503, `GRADER_TIMEOUT` 504.
  Test-me codes: `NO_CAPTIONS` 404, `NOT_PYTHON` 422, `TOO_EARLY` 422 (under 180 s of transcript), `GENERATOR_UNAVAILABLE` 503, `GENERATOR_TIMEOUT` 504 (20 s), `SET_EXPIRED` 410.

## Extension messages (content script → background service worker)
- `{ type: "lookup", videoId }` → `{ ok: true, data: PracticeResponse } | { ok: false, error }` (3 s timeout).
- `{ type: "grade", exerciseId, revision, mode, code }` → `{ ok: true, data: SubmissionResponse } | { ok: false, error }` (15 s timeout).
- `{ type: "testMe", videoId, timestampS }` → `{ ok: true, data: TestMeResponse } | { ok: false, error }` (20 s timeout). Response includes exercise + `setId` + `aiGenerated: true`.
- `error` uses the API error shape; network/timeout failures use code `NETWORK` or `TIMEOUT` with `retryable: true`.

## Panel component (owner of UI: @reyanshBadhwar26; caller: @abdullahwarv2)
`extension/src/ui/PracticePanel.tsx` exports `PracticePanel` with props:
```ts
{
  videoId: string;
  revision: string;
  breakpoint: Breakpoint;              // from src/contracts.ts
  attempt: "idle" | "editing" | "checking" | "failed" | "passed";
  result: SubmissionResponse | null;
  error: { code: string; message: string; retryable: boolean } | null;
  canResume: boolean;                  // show "Resume video" when play() rejected
  onRun(code: string): void;
  onSubmit(code: string): void;
  onSkip(): void;
  onResume(): void;
  onClose(): void;
}
```
Optional panel props: `index`, `total` ("Challenge 2 of 3"), `leaving` (exit animation), `holdMs` (solved moment before auto-resume; caller waits `SOLVED_HOLD_MS`).
Also `Badge` (`extension/src/ui/Badge.tsx`): `{ state: "loading"|"ready"|"unavailable"; total; remaining; solved; active: boolean; nextAtS: number|null; onOpen(): void }`. Always one `<button>`; non-actionable states use `aria-disabled`.
Drafts: `extension/src/drafts.ts` (UI owner) exports `loadDraft(key)`, `saveDraft(key, code)` (debounced), `flushDraft(key)`; key = `${videoId}/${exerciseId}/${revision}`.
