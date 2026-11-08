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
- [x] Follow-up on #6716564085: `PracticePanel` accepts `accountId` and `language`. Account switches remount and isolate drafts (including pending edits); omitted account preserves v1 keys. `practiceDraftKey` exports the key builder. Non-Python languages get matching filenames/accessible labels, JSON examples/results and plain CodeMirror editing; Python retains syntax highlighting. No dependencies added.
- [x] Configured the installed JavaScript/TypeScript, Java, C/C++, SQL, Rust, Go and C# CodeMirror parsers in the owned editor. Pseudocode/unknown remain plain text; no dependency-file changes.
- [x] Adopted frozen settings constants/defaults from `src/v2/types.ts`, now present after the runner's main merge. Added a permanent built-MV3 long-hint→Next-hint regression: full hint stays visible while history sent to the backend is bounded to 400 code points.
- [x] Adopted A3 preference helpers in the profile popup after syncing main; serialized saves and error reporting remain intact. Showcase injects a preview adapter.
- [x] Lead-assigned permanent plan E2E in `tests/e2e/plan.spec.ts`: planning->ready, coding/concept pauses, unavailable/no-captions, settings/account changes. Includes actual mounted timeline shadow-host placement/hiding and marker centers against the fixture player bar after sync of A3 #20. Refresher orchestration remains A3-owned (in progress per #6717331183).
- [x] Deduplicated identical success summary/explanation paragraphs in `FeedbackCard` per #6717282173; distinct explanations and optimization remain available.

Previous milestone validation: final typecheck, 45/45 Vitest, default production build and 26/26 focused browser checks passed (24 v2 plus desktop/narrow TOO_EARLY recovery). The broader default run printed 106/107 passes before cleanup; its preview failure and a subsequent screenshot navigation interruption occurred while source/docs were being edited. Both cleared in the final frozen-source run. Sampled new primary/secondary text meets 4.5:1 in both themes and viewports. Preserved 68 showcase screenshots (17 states × 2 themes × 2 viewports) plus 2 built-popup screenshots in `extension/assets/ui-checks/v2/`; representative question, diagnosis, profile, coding-level and deliberate-resume captures were visually inspected.

No provider calls, backend edits, shared-contract edits, git mutations or board posts were made. Board whoami/unread succeeded via a temporary script with its cursor outside `.git`; authenticated login was `reyanshBadhwar26`. Windows later rejected ordinary command creation with error 1909; final checks ran through the available Node runtime. Final browser run used a temporary port-4174 config, removed afterward. No test listeners remained on ports 4173/4174 after cleanup. Runner handoff is in `.autopilot/post.md`.

## Follow-up validation (0bbc009 base)

Final typecheck passed; 48/48 Vitest and the default production build passed. The complete default Playwright matrix exited 0: **121 passed, 28 opt-in Test me checks skipped**, across desktop/narrow preview and built MV3. This includes account switching with pending drafts, JavaScript/Java/C++/SQL labels and exact-source Run, long-hint → Next-hint history normalization, existing playback/failure recovery, popup persistence, and light/dark contrast. An initial long-hint assertion expected unbounded history; corrected it to the merged 400-code-point normalization and confirmed the full displayed hint remains intact. Its focused rerun passed 10/10.

The full browser run used the unchanged project matrix through a temporary port-4174 config with an independently started Vite server to avoid Windows automatic web-server cleanup hanging. Temporary config removed afterward. Preserved 16 additional language screenshots (four languages × two themes × two viewports); desktop JavaScript/dark, Java/light and narrow SQL/dark were visually inspected. No providers or backend checks. No dependency files, frozen contracts, A3 runtime files, git mutations or board posts changed. Git diff whitespace check passed. tools/board whoami/unread failed at Git Bash mkdir; native gh verified reyanshBadhwar26 and read all recent posts through lead #6716618125. Later native launches hit Windows error 1909; the available Node runtime completed final type checking and runner-file preparation.

## Checkpoint on a131d39 (2026-11-08)

Completed the remaining syntax-parser configuration and replaced popup storage duplication with A3 preference helpers. Essential checks observed: npm ci, typecheck, production build, git diff --check, and 6/6 existing desktop Playwright cases (JavaScript/Java/C++/SQL exact-source editor flows, profile account/settings/API recovery, built-MV3 popup persistence). The browser command exited 0 after stopping only its printed Vite server PID 44412 to finish Windows cleanup. Temporary config removed. No new test cases or preserved screenshots, provider calls, dependency-file edits, backend edits, git mutations or direct board posts.

Native gh confirmed reyanshBadhwar26 and read board posts through #6717221013 (lead confirms A3 #20 merged). tools/board whoami/unread still fail at state-directory mkdir. Runner handoff files prepared for prompt publication. Next checkpoint: permanent plan E2E remains assigned; actual timeline host geometry/hiding assertions await runner sync of A3 #20 (rail absent from this checkout). No full browser matrix, unit suite or real YouTube walkthrough claimed for this checkpoint.

## Plan-flow checkpoint on aaaa09f (2026-11-08)

Completed the lead-assigned permanent `tests/e2e/plan.spec.ts` with desktop/narrow project registration and opt-in v2 fixture support in `extension.fixture.ts`. Coverage includes planning->ready with identical personalized polling bodies; coding and concept automatic pauses; submitted source/choice transport; explicit Resume; not_coding/no_captions without blocking playback; frequency, auto-pause/never-here and account-level changes. Mounted TimelineMarkers checks assert the actual shadow host is absolute, bulb centers match the fixture player bar, and the rail hides during practice. FeedbackCard now renders identical trimmed summary/explanation text once; the coding flow checks this.

Observed essential checks: typecheck passed after the TypeScript implementation; production builds completed as part of both browser commands. Eight distinct assigned browser cases passed across the two viewports: initial run 5 passed/3 failed, then only those 3 corrected cases reran and passed (exit 0). Initial failures were a 5-second poll assertion racing the runtime's 5-second polling interval, and two assertions incorrectly expecting manual timeline access to hide when automatic pauses were disabled. Test expectations were corrected; no runtime changes. Each command needed only its reported Vite PID stopped (46076, then 33928) to finish Windows cleanup. Diff whitespace check passed. No unit/full browser/backend suite, new screenshots, provider calls or live YouTube validation claimed. The fixture uses a synthetic 20-second duration with the real canvas media clock; real seek behavior is outside these checks.

Board whoami/unread still fail at mkdir; native gh confirmed reyanshBadhwar26 and read the full board through #6717337233. A3 has started refresher orchestration in its own files (#6717331183). No B2 implementation dependency remains for this checkpoint. Runner should publish now; .autopilot/commit-msg and post.md contain the handoff. No git mutations or direct board posts performed.
