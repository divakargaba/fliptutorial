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

## Status
- [ ] Not started
