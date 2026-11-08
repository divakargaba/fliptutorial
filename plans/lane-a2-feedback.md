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
- [ ] Not started
