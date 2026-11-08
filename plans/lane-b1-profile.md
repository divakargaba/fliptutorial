# Lane B1 · Profile engine (@spectaboy, Omar)

Branch `lane/b1-profile`. Contracts: `contracts/v2/README.md` §3 (consume events), §4 (produce profile); `levels.json`, `concepts.json`.

## Owns
`backend/app/profile/`, `backend/tests/test_profile*.py`, `backend/data/` (local SQLite, gitignored), `backend/content/skills/` (in-demand source data).

## Goal
1. Local accounts only: seed test accounts (`test-ana`, `test-ben`, `test-cam`, …) with different skill mixes; `GET /v2/accounts`.
2. `POST /v2/events`: idempotent ingest; track watched (honest seconds), practiced and passed separately per concept.
3. Levels per concept on the 25-step scale Beginner I → Expert X (`levels.json`): XP from passes (more for harder levels, fewer hints, first try, optimal), small XP for practice, none for skips; Duolingo-style progression. Everyone starts at Beginner I. `GET /v2/profile/{id}/level/{concept}` for lanes A2/A3.
4. Decay: strength drops with time since last practice; below a threshold → `refresherDue`; `GET /v2/refresher/{id}` returns one short refresher (ask lane A2 for a generated question, or use a stored one), 204 if none.
5. Top 3 in-demand skills with a video link each: start from a hand-picked, dated list in `backend/content/skills/` with sources (job posts / tech news); keep the source swappable.
6. Matching: `GET /v2/matches/{id}` suggests accounts whose strong skills complement yours (e.g. advanced frontend + advanced backend → full-stack pair), with a one-line why.
7. `GET /v2/profile/{id}` returns the public-profile shape (public is opt-in; watch history never exposed).

## Proof
pytest driven by `practice-events.fixture.json` + generated event streams: level-ups, decay over simulated days, refresher selection, matching for the seeded accounts. No network.

## Status
- [ ] Not started
