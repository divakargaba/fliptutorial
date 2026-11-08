# Lane A2 · Feedback: teach around the result (@divakargaba's agent)

Branch `lane/a2-feedback`. Contract: `contracts/v2/README.md` §2 (feedback result). Roadmap: Component 1 (steps 5–7).

## Owns
`backend/app/feedback/`, `backend/app/runners/`, `backend/tests/test_feedback*.py`, `backend/tests/test_runners*.py`,
plus the existing `backend/app/grader.py`, `hints.py`, `analysis.py`, `backend/content/docs/`.

## Goal
1. `POST /v2/submit`: grade (any supported language) and return a FeedbackResult.
   - Success: name the concept tested and the assessed level; show the optimization (with verified faster solution) **only from Intermediate up**; Beginners get no optimization nag.
   - Failure: diagnose the thinking, not just the failing test: the misconception (e.g. "base case missing", "loop condition never changes") and the exact 1-based lines involved.
2. `POST /v2/answer`: grade concept questions (multiple choice, short answer via Claude rubric, predict-output) and return a FeedbackResult.
3. `POST /v2/hint`: hint depth by level (stronger skill → fewer, vaguer hints), grounded in docs; add docs for each new language (JavaScript, Java, C++, SQL first).
4. `backend/app/runners/`: per-language Judge0 wrappers with the same safety rules as Python (one isolated run per case, compare outside the sandbox, strict types). Python, JavaScript, Java, C++ first; SQL via Judge0's SQLite.
5. Grading quality: richer per-case output and clear time/memory limits; document what self-hosting Judge0 would change (dedicated Docker instance, no shared queue).
Model default `claude-opus-5-5` for diagnosis, `claude-haiku-5-5` where speed matters (budget ≈ $100).

## Proof
A labelled set (`backend/tests/fixtures/submissions/`) of ≥30 right/wrong submissions across ≥3 languages with expected misconception ids; report how often the diagnosis names the right misconception and lines. Offline pytest with stubbed Claude/Judge0.

## Status
- [x] Multi-language Judge0 runners: Python, JavaScript, Java, C++, SQL (`backend/app/runners/`)
- [x] `POST /v2/submit` with FeedbackResult: grading + diagnosis (failure) + optimization (success, Intermediate+ only)
- [x] `POST /v2/answer` for concept questions: multiple choice, predict-output (deterministic), short answer (Claude rubric)
- [x] `POST /v2/hint` with level-aware depth: beginner=full hints, advanced=-1, expert=-2; reuses v1 RAG hint service
- [x] Exercise store for server-side full exercise data (hidden tests, reference solutions)
- [x] 35 labelled submissions across 4 languages (10 Python, 10 JS, 10 Java, 5 C++) + 5 concept questions
- [x] 103 offline pytest tests: 45 runner tests + 58 feedback tests (all passing, stubbed Claude/Judge0)
- [x] Planner integration: `/v2/submit`, `/v2/answer`, `/v2/hint` resolve exercises/questions from A1's `find_exercise`/`find_question`
- [x] Refresher integration: `/v2/answer` resolves refresher questions from B1's `lookup_refresher`
- [ ] Language-specific docs for hints (JS, Java, C++, SQL) — currently all use Python docs
- [ ] Live integration test with real Judge0 + Anthropic key

## Architecture

### Runners (`backend/app/runners/`)
- `base.py`: Abstract `Runner` base class, shared Judge0 submit/poll/parse logic, registry
- `python_runner.py`: Python 3 (Judge0 id 71), same wrapper as v1 grader
- `javascript_runner.py`: Node.js 18 (Judge0 id 93), normalizes JS number→int
- `java_runner.py`: Java OpenJDK 13 (Judge0 id 62), wraps user's `Solution` class
- `cpp_runner.py`: C++ GCC 10.2 (Judge0 id 54), auto-types args from Python values
- `sql_runner.py`: SQLite (Judge0 id 82), `.mode json` output, row-based comparison

### Feedback (`backend/app/feedback/`)
- `__init__.py`: Router with `/v2/submit`, `/v2/answer`, `/v2/hint`; exercise resolution from store → v1 catalog → A1 planner → B1 refresher
- `diagnosis.py`: Claude-powered misconception analysis with static fallback
- `optimization.py`: Success feedback with complexity analysis; `show=false` for beginners
- `concepts.py`: Deterministic MC/predict-output grading + Claude rubric for short answers
- `exercise_store.py`: In-memory TTL cache for server-side exercise data

### Labelled fixtures (`backend/tests/fixtures/submissions/`)
- `python_submissions.json`: 10 submissions (3 pass, 7 fail with misconception ids)
- `javascript_submissions.json`: 10 submissions (4 pass, 6 fail)
- `java_submissions.json`: 10 submissions (3 pass, 7 fail)
- `cpp_submissions.json`: 5 submissions (2 pass, 3 fail)
- `concept_questions.json`: 5 questions (MC + predict-output) with test vectors
