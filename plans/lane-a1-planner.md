# Lane A1 · Planner: any coding video, section by section (@abdullahwarraichh, Abdullah)

Branch `lane/a1-planner`. Contract: `contracts/v2/README.md` §1 (exercise plan). Roadmap: `docs/ROADMAP.md` Component 1 (steps 1–4, 8).

## Owns
`backend/app/planner/`, `backend/tests/test_planner*.py`, `backend/content/plans/` (plan cache), `backend/content/eval/` (labelled videos),
plus the existing `backend/app/testme.py`, `transcripts.py`, `prepare.py`.

## Goal
Any YouTube video id → a cached, timestamped exercise plan before the learner reaches each pause.
1. Qualify the video and each section with timestamped evidence (code / theory / mixed / off_topic). Non-coding videos → `status: not_coding` (the extension shows "topic not available"). When evidence is weak, leave playback alone.
2. Detect format and language per section (captions + on-screen code). Language unclear but concept clear → plan a **concept** question (pseudocode / multiple choice / predict output).
3. Plan pauses from the transcript: instructor poses a question → pause before the answer; instructor only demonstrates → generate a new problem using the same idea. Use only material taught before the pause.
4. "Pause only when ready": `POST /v2/plan` returns quickly (`planning`), generates the earliest pauses first, caches per video so the next viewer gets it instantly.
5. `rank` per pause so the learner's frequency setting (few / normal / many) works; cap pauses per video length.
6. Answer-already-on-screen: pause earlier, or check the frame at pause time (YouTube storyboard thumbnails) before accepting a pause.
7. Caption access: make runtime caption fetching robust across channels, with a documented fallback order; report `no_captions` honestly.
8. Exercises in any language Judge0 runs; every coding exercise keeps today's rule (reference passes all tests, known-wrong fails one), verified via lane A2's runners. Model: `claude-haiku-5-5` by default (budget ≈ $100 of Claude credit for this lane).

## Proof
`backend/content/eval/`: ≥20 labelled videos (tutorials in several languages, theory e.g. Abdul Bari, mixed, and code-mentioning non-tutorials). Report precision/recall of "qualifies" per section and pause correctness; auto-pause enabled only above the bar we post on the board. Offline pytest with stubbed Claude.

## Status (2026-11-08)
- [x] `POST /v2/plan`, `GET /v2/plan/{videoId}?learnerLevel=` (`backend/app/planner/`): returns at once (`planning`), plans in the
  background, earliest ~40-min window first; pause ids stay stable while later windows are classified. 404 `PLAN_NOT_FOUND`,
  422 `INVALID_VIDEO_ID` / `INVALID_LEVEL`.
- [x] `learnerLevels` (contract `5874edc`): `POST /v2/plan { videoId, learnerLevel?, learnerLevels? }` plans each pause at
  `learnerLevels[pause concept]`, else `learnerLevel` (default `beginner-1`). Only the needed (tier, concept) items are generated;
  a wider map later generates just the new items. `GET /v2/plan/{videoId}` uses the latest POST's levels (`?learnerLevel=` overrides
  the default). Bad level values → 422 `INVALID_LEVEL`; concept ids outside `concepts.json` are ignored.
- [x] Goal 1: section classifier (code / theory / mixed / off_topic, `qualifies`, confidence) over ~20 s caption blocks.
  Every block id the model cites is checked; evidence text is copied from the real captions. Low confidence or no
  evidence means the section does not qualify. No qualifying section means `not_coding` (stops after the first window if it is clearly not programming).
  `no_captions` / `error` are reported honestly and not cached to disk.
- [x] Goal 2: language per section; Python code sections get coding pauses, while theory, pseudocode and other languages get concept
  questions (multiple_choice / predict_output / short_answer) until A2's runners land (`vocab.CODING_LANGUAGES`).
- [x] Goal 3: `question_posed` pauses at the end of the asking cue and before `revealAtS`; `demonstration` asks for a NEW problem with
  the same idea. Generation sees only captions before `pauseAtS` (test-enforced).
- [x] Goal 4: cache per video in `backend/content/plans/<videoId>.json` (gitignored; holds private answers), with one item set per level
  tier (beginner / intermediate / advanced / expert). The next viewer gets the plan instantly and a restart resumes unfinished items.
- [x] Goal 5: `rank` 1 = the key pause of each section (≥5 min apart), 2 = good, 3 = minor. Pauses are ≥60 s apart; cap 1 per ~6 min (2..30 per window).
- [x] Goal 8 (Python): coding exercises reuse the Test me checks plus a live Judge0 verify (reference passes, known-wrong fails). If that fails, the
  pause falls back to a concept question. Model is `claude-haiku-5-5` (`ANTHROPIC_PLANNER_MODEL` overrides it). Spend guard: 30 new videos/hour
  (`PLANNER_MAX_NEW_VIDEOS_PER_HOUR`).
- [x] Goal 7 (part): caption fallback order is innertube ANDROID → WEB → watch-page `captionTracks`; English uploader track → English ASR;
  no translation. Payload cap raised 8 → 48 MB (CS50P's 9 h ASR track is 19 MB and failed before).
- [x] For A2: `app.planner.find_exercise(id)` returns the PrivateExercise (`.exercise` is a v1 ApprovedExercise with hidden tests and solutions, plus `.revision`,
  `.concepts`, `.level`), and `find_question(id)` returns the PrivateQuestion (`.answer`, `.explanation`, `.style`, `.choices`, `.revision`).
- [x] A2 grading hand-off (`backend/app/planner/grading.py`): each ready exercise/question goes to `app.feedback.register_exercise` /
  `register_question` when it is generated, and again whenever POST/GET `/v2/plan` serves it. This refills A2's in-memory 2 h TTL store after a
  restart or expiry. It does nothing while `app.feedback` is still the stub. Verified against `lane/a2-feedback` `e62dfc8`: items land in its store.
- Checks: `backend/tests/test_planner.py` passes 23/23 (24 with A2 merged) offline (stubbed Claude/Judge0/captions) and the full backend suite passes. Live smoke on 2026-11-08 (port 8011,
  real Claude + ce.judge0.com): `dQw4w9WgXcQ` gave `not_coding` ("only song lyrics…"). `nLRL_NcnK-4` (CS50P) had 18 sections / 13 pauses after the first windows, and the first
  pause was ready in about 1 min; the 2 coding exercises passed Judge0 verify. No secrets were in the public plan. `python -m app.planner.inspect_plan <videoId> <port> [--wait s]` prints a summary.
- [x] Goal 6: answer-on-screen check (`backend/app/planner/screen.py`). For each `question_posed` pause, before numbering, the planner reads
  the watch page's storyboard spec (largest level, usually 160×90 every 10 s). It sends the sheet with the frames from the asking block's
  start to the first frame after the pause, and asks Claude (same planner model, image input) per frame whether the answer is visible.
  If the answer shows from frame k on, the pause moves to frame k-1 when that frame is clear and inside the asking block (`moved`).
  Otherwise it becomes a NEW problem on the same idea at the same time (trigger `demonstration`, `new_problem`). No storyboard, a failed
  fetch or a failed model call keeps the pause as before (`unchecked`). Sheets come as JPEG or WebP. `PauseSlot.screen` / `ask_start_s`
  are kept in the plan cache only; there is no public contract change. Demonstration / concept_complete pauses already ask a new problem
  and are not checked. Turn it off with `PLANNER_SCREEN_CHECK=0`. Offline: `tests/test_planner_screen.py` 6/6, full backend suite 297 passed / 5 skipped. Live 2026-11-08 on
  `rfscVS0vtbw` (`claude-haiku-5-5`): the calculator pause at 3338 s came back `new_problem` (frames show `result = num1 + num2`), and the
  reviewed exponent pause at 9803.3 s came back `clear` (header and partial body only). Limit: 160×90 frames, so small-font code reads as
  "not visible" and the pause is kept.
- [x] Proof: `backend/content/eval/` has 26 videos labelled by hand from captions and frames: tutorials in 9 languages, theory,
  mixed, code-mentioning talks and non-coding videos. `labels.json`, `README.md` and the generated `REPORT.md` are in that folder.
  Two live runs (`claude-haiku-5-5`, the live classification path): section "qualifies" precision 0.918 / 0.962, recall 0.876 / 0.874,
  and 77/78 pauses inside labelled teaching and before a labelled answer. That meets the bar (precision ≥ 0.9 in every run), so auto-pause
  can be on. Every false positive is a "create project + Hello World" setup boundary. No non-coding video got a qualifying section.
- [x] Setup boundary tightened (lead follow-up): the classifier prompt now puts setup (install tools, create a project, tour files/IDE,
  run the starter Hello World) in its own non-qualifying section with no pauses. Two new live runs: precision **1.000 / 1.000**
  (0 FP, lower bound 0.953), recall 0.830 / 0.782 (was 0.876 / 0.874), pauses 80/80 correct. The earlier runs are kept as `results-v1-run*.json`.
  Harness: `python -m app.planner.evaluate run|score` (`app/planner/evaluate.py`); offline scoring tests are in `tests/test_planner_eval.py` (7/7).
- [x] Classification progress is saved after every ~40-min window (`classifyProgress` in the plan cache: windows done, numberer state, caption digest).
  A restarted backend resumes at the next window with the same section/pause ids and ranks, and reuses items already generated. If the captions changed
  (digest or window boundaries differ) it reclassifies from scratch. An in-memory `error` is never written to disk. Offline: `test_planner.py` 25 passed + 1 skipped until A2 merges; full backend suite 290 passed / 5 skipped.
- [x] Coding exercises in JavaScript, Java and C++ via A2's runners (`app.runners`). `vocab.coding_languages()` turns them on only when
  `app.runners` imports, so before A2 merges they stay concept questions. Each language has a prompt shape that matches A2's wrappers
  (JS `function f(...)`; Java `class Solution { public static T f(...) }`; C++ a free function using the wrapper's std headers),
  plus static checks for required shape, banned I/O/process/includes and no null for Java/C++. Verify (`planner.runner_verify`) needs the
  reference to pass all cases, the known-wrong to compile and fail at least one, and the starter to compile. Otherwise the pause
  falls back to a concept question. `PrivateExercise.exercise` is a `PlannedExercise` (an `ApprovedExercise` subclass with `language: str`), so
  A2's `find_exercise` fallback gets the real language. Offline: `tests/test_planner_languages.py` 26/26. Live 2026-11-08: A2's
  runners at `8a8cacc` on ce.judge0.com verified JS/Java/C++ sum loops, a Java String and a C++ bool exercise; a Java known-wrong
  that does not compile was rejected. SQL is not planned (its exercises have a different shape).
