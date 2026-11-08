# Breakpoint Roadmap: From Demo to Any-Video Learning Platform

Nov 7, 2026 · @Shush

## North star

The end product turns any coding video on YouTube into hands-on practice, then turns that practice into a verified skill profile that organizations can recruit volunteers from. Priority #1 is the first part: it must work on any coding video, properly, before the profile or networking pieces matter.

Three components, each owned by its own lane:

1. **Practice engine (core, priority #1).** Any coding video qualifies section by section. Breakpoint pauses at the right moments, asks a question pitched at the learner's level, grades it, and explains the result. On success it names the concept tested and suggests optimizations. On failure it diagnoses the thinking behind the mistake.
2. **Profile.** Records what you watched, practiced and passed per skill. Skills decay without practice and trigger a refresher question next time you open YouTube. Shows the top 3 in-demand skills and links each to a video.
3. **Networking and teams.** Nonprofits, communities and companies post volunteer tasks. They find people by verified skills. Completed tasks add to the volunteer's profile and resume. (DONT ACTUALLY IMPLEMENT)

The pitch opens with research evidence that practice during video learning improves retention (to be sourced, see Things not yet decided).

## What we have today

The prepared-video demo works end to end and is well tested; "Test me" (any video) exists but is unproven live. Nothing for profile or networking exists yet.

| Piece | State | Limits |
| --- | --- | --- |
| Chrome extension (WXT + React + Tailwind + CodeMirror) | Done | Python only; desktop Chrome only. needs to be every damn language/concept |
| Prepared breakpoints, 4 exercises on 2 videos | Done, 3/3 clean real-YouTube runs | Every exercise is hand-prepared offline per video; calculator pause already shows the answer on screen |
| Grading via Judge0 (public ce.judge0.com) | Done, \~4–5 s round trip | Shared public server; slow takes reach 8–10 s, its very mid grading right now and not actually somethign that would benefit student. |
| Prep pipeline (scan, verify, publish with Gemini) | Done | Offline, run by a person per video |
| Test me: generate exercise from captions up to now | Code done (T1–T6), off by default | Needs ≥180 s of transcript; 18 s budget; Gemini free tier is 20 requests/day; live runs (T7) not yet done. shouldnt&#32; |
| Solved progress | Done | Stored only in that browser (`chrome.storage.local`); no accounts |
| Backend | Local FastAPI on 127.0.0.1:8000 | No hosting, no database, no user accounts |
| Success explanation, failure diagnosis, level adaptation | Not started | Today: pass/fail per test case only |
| Profile, decay, in-demand skills | Not started | — |
| Networking, organizations, volunteer tasks | Not started | — |

Open task for Omar today: M1 manual desktop-Chrome checks.

## Component 1: practice on any coding video (priority #1)

The goal is to replace hand-prepared breakpoints with an automatic exercise plan built from any video's captions, ready before the learner reaches each pause. Today's Test me generates one exercise on demand; the gap is planning ahead, judging when to pause, and teaching around the result.

### How it should behave

1. **Qualify the video, section by section.** A section qualifies when it teaches or demonstrates something concrete you can do or reason about in code (writing, reading, debugging, testing, explaining behavior). A career vlog or AI news video that only mentions code does not qualify (Make an additional case where that comes in, the user should see something saying like topic not available or something if they are on a video like that). When evidence is weak, leave playback alone and keep the timestamped lines that justify every decision.
2. **Detect format and language per section.** Theory, Python, then SQL can all appear in one video. Captions give the concept; readable on-screen code helps identify the language. Language unclear but concept clear → offer a concept question instead of a coding one. (e.i Pseudocode, etc.)
3. **Plan pauses from the transcript.** Split captions into concepts and find where each explanation is complete. Instructor poses a question → pause before the answer. Instructor only demonstrates → generate a new problem using the same idea (loop summing prices → count scores above a threshold).
4. **Pause only when ready.** Playback starts immediately. An automatic pause happens only if a checked exercise is already ready ahead of that timestamp. Cache the plan so the next viewer gets it instantly.
5. **Pitch to the learner's level.** Difficulty, hint depth and explanation wording follow the learner's profile level for that concept (beginner, intermediate, advanced.). We are having these profiles/progress saved locally. as soon as you get the extension for hte first time you start as beginner. as you use it and stuff and you progress you can go to beginner II or smth and it progresses gamified duolingo style or something (no assessment for now). also should be based on the level for each skills/concepts. also if you are a beginner and u do solution but it is not optimized at all,  u dont need to add the optimization thing, but if ur intermediate so like as an intermediate u should have more optimized solution and u should mention it.
6. **On success:** name the concept tested and the level of assessment. If the solution works but is poor (slow, redundant, unidiomatic), show the optimization.
7. **On failure:** diagnose the thinking behind the mistake, not just the failing test. Point to the lines involved (for example a loop that never ends) and name the misconception (for example a base case missing from recursion).
8. **Frequency.** Today pauses come from keyword/candidate detection. Target: a set number of pauses per concept boundary, capped per video length, with a learner setting (few, normal, many).

### What we must build

| Capability | Builds on | New work |
| --- | --- | --- |
| Video/section classifier with evidence | Prep pipeline candidate detection | Classifier prompt, labelled test set of tutorials, theory, mixed and code-mentioning videos |
| Automatic exercise plan (timestamped) | Test me generator + prepared pause logic | Background planning job, plan cache, "ready before pause" rule |
| Retrieval of prerequisite context | Transcript clip in Test me | Timestamped chunks; only material taught before the pause |
| Level-aware generation and hints | Test me prompt | Level input from profile, hint ladder |
| Success explanation + optimization | Judge0 results | Second LLM pass over the passing code |
| Failure diagnosis | Judge0 results per test | LLM pass over code + failing tests + concept; line highlights in the panel |
| Concept (non-coding) questions | T8 quiz plan | Quiz generation and quiz view (T8, T9) |
| Language beyond Python | Judge0 supports many languages | Per-language wrappers and safety checks |
| Keep accounts local  for now |  |  |

The first thing to build is the classifier and its test set: prove it picks the right sections with good evidence before it is allowed to interrupt anyone's video.

## Component 2: profile and progression

The profile turns practice events into a per-skill level that rises with passes, decays with time, and feeds back into how hard Component 1's questions and hints are. It only needs a stream of events from Component 1, so it can be built in parallel against fake events.

- **Connection logic.** Each exercise is tagged with concepts (loops, recursion, dictionaries). Each outcome (passed, failed, skipped, hints used, attempts) updates those concepts. Track watched, practiced and passed separately.
- **Honest watch time.** Count actual playback time toward video completion, so jumping to the end does not count as watching.
- **Progression and decay.** A skill's strength drops after a period without practice. When it falls below a threshold, the next time you open YouTube Breakpoint offers a short refresher question on that skill.
- **Level feeds back.** The skill level sets question difficulty and hint depth in Component 1 (stronger skill, fewer and vaguer hints).
- **Public view.** Example: Python loops · 5 challenges passed across 3 tutorials. Public sharing is opt-in; watch history stays private.
- **Top 3 in-demand skills.** Show the three hottest skills and link each to a video that teaches it. Source of demand data is an open decision.
- **Networking/Connecting users matching together**: it addresses the prompt by matching/connecting users to complement each other based on their skills and overall level... this leads to the component 3. E.x if somebody advanced frontend, another advanced backend, and stuff... they can collaborate to be able to build fullstack app/project&#32;

Needs: user accounts (none today), a database (Postgres), and a hosted backend so the profile follows the user across browsers.

## Component 3: networking and teams (dont build yet)

This is the scalability story: organizations come to a platform that already holds people with verified skills and get volunteer work done, while volunteers build a resume. For the hackathon it should be a convincing glimpse (a clickable mock-up, like the Canva idea), not a full system.

- **Organizations** (nonprofits, communities, for-profits) post tasks with required skills and levels.
- **Matching** suggests volunteers whose verified skills fit; volunteers can also browse and apply.
- **Teams** form around a task when it needs several skills.
- **Credit** — completed tasks appear on the volunteer's profile and an exportable resume line.
- **Trust** — organizations need verification; volunteers need consent before their profile is shown to anyone.

Depends on Component 2's public profile shape only, so it can run in parallel against a fixed sample of profiles.

## How 4–5 agents work in parallel without merge conflicts

Conflicts happen because today's tasks (T1 → T9) are a chain that sends several agents into the same files (`main.py`, `youtube.content.tsx`, `PLAN.md`). The fix is lanes: each agent owns a folder outright, lanes talk only through frozen contracts, and each lane chases an outcome instead of waiting on the next task in the chain.

&#91;embedded content: agent lanes · 5 lanes, 1 shared contract layer\]

Component 1 gets three agents because it is priority #1; Profile and Network sit in brand-new folders, so they cannot collide with anyone, instead we will have 2 agents for Component 2 as we are not building Component 3 yet.

### Rules

1. **One owner per file.** Every path belongs to exactly one lane. Need a change elsewhere? Ask that owner with the exact change.
2. **Contracts first, then freeze.** Before coding, the lead writes four schemas with sample files: exercise plan, feedback result, practice event, public profile. Changes go through the lead only.
3. **Build against fakes.** Each lane starts from the sample files, not from another lane's running code. Profile reads fake events; Network reads sample profiles; the extension reads a sample plan.
4. **Branch per lane.** Each agent works on its own branch (or git worktree), opens small pull requests, and rebases daily. Only the lead merges into `main`.
5. **Pre-wire shared entry points once.** The lead adds one router line per lane in `main.py` and one mount point per lane in the extension up front, so lanes never touch them again.
6. **Status in separate files.** One status file per lane (`plans/lane-a1.md` and so on) replaces the shared `PLAN.md` table, which caused rebase conflicts.
7. **Outcome goals, not task chains.** Each lane gets a goal and a test that proves it (for example, "A1: classifier picks the right sections on 20 labelled videos").

## Roadmap

Phase 1 is the one that matters: Breakpoint working properly on videos nobody prepared. Profile and networking run in parallel but are never allowed to delay it.

&#91;embedded content: roadmap · 4 phases, 4 exit gates\]

The hackathon demo likely ends at Phase 2's gate, with Phase 3 shown as the vision (slides and the networking mock-up).

## Hard problems and risks

The biggest risk to "works on any video" is getting reliable captions and fast, cheap generation; everything else is engineering.

| Risk | Why it hurts | Mitigation |
| --- | --- | --- |
| Caption access | YouTube's official caption download needs edit permission on the video; our runtime fetch is unofficial and may break or be blocked | Test fetch across many channels first; start with videos we can reliably read; speech-to-text or code frames only where we have permission. You need to be able to find some workaround around this to be able to&#32; |
| Gemini quota and latency | Free tier is 20 requests/day on 2.5-flash; one set takes up to 18 s | Generate ahead of the pause and cache per video; budget a paid tier before any public demo. We will be using Claude API instead of Gemini API $100 credit. |
| Classifier mistakes | Wrong pauses annoy users more than no pauses | Labelled test set and a precision bar before enabling auto-pause; default to leaving playback alone |
| Bad generated exercises | A wrong reference solution teaches the wrong thing | Keep today's rule: reference passes all tests, known-wrong fails one, checked in Judge0 |
| Public Judge0 | Shared, rate-limited, slow takes reach 8–10 s | Self-host Judge0 or a paid plan for scale. explain exactly what that means. |
| Answer already on screen | Calculator pause shows `result = num1 + num2` | Check the video frame at pause time, or pause earlier |
| Non-Python languages | Each needs a safe runner and test wrapper | Concept questions first; add runners one language at a time.&#32; |
| Theoretical Questions | Need to be able to generate code application questions for Computer Science Theory | Should be also able to relate to real-world |
| Merge conflicts | Several agents edit the same files on `main` | Lanes, contracts and branches below |
| Privacy | Watch history and skill data are personal | Private by default; opt-in public profile; delete-my-data |
| YouTube terms | Overlaying and pausing their player | Review terms before public launch |

## Things not yet decided

These gaps aren't in the vision yet and each one blocks a component, so they need an owner.

- [ ] **Accounts and sign-in.** Profile and networking need them; today there are none, and the PRD lists accounts as out of scope.  → ALL Accounts local. make test accounts that can be used to apply the logic.
- [ ] **Hosting.** Everything runs on 127.0.0.1. Any profile, shared plan cache or organization portal needs a hosted backend and database. → No comment
- [ ] **Budget.** Paid Gemini tier, Judge0 hosting, database. HACKATHON.md says no paid provisioning is authorized yet. → Assume we have $100 Claude API to use x3.
- [ ] **Hackathon scope vs. vision.** Decide what is demoed live, what is a mock-up, and what is a slide. → Component 1+2 is part of the live demo (judges should be able to choose any video they like and see how all the peices fall together). mock-up/slide/future steps would be showcasing the scalability through componenet 3.
- [ ] **Research for the intro.** Pick 2–3 papers on active practice / retrieval practice during video learning, with links.  → ok. will do after
- [ ] **In-demand skills source.** Job-post data, a public survey, or a hand-picked list. → could also be based on twitter, or any sort of compiled news source for the latest tech thigns in demand/constant changing job market.
- [ ] **Evaluation set.** Who labels the 20–30 videos the classifier is tested on, and what pass bar we accept. → i dont know yet, we can get to that when the time comes.
- [ ] **Exercise quality bar.** Rules for difficulty per level and how we know a hint is good. → Levels run with various incremenets and alot fo different small incremenets from Beginner I → Expert X or something like that, and there are lots of stuff in between and it be should be aligned according to that. a hint is considered good if its able to teach understanding of the concept/guide them to think on the right track rather than just giving an answer to them.
- [ ] **Learner controls.** Turn off auto-pause, choose frequency, skip forever on this video. -->All nice.
- [ ] **Accessibility for new UI.** Profile and networking pages must meet the same contrast and keyboard bar as the panel. → dont worry about UI til the end.
- [ ] **Organization trust and safety.** How organizations are verified and how volunteers report abuse. → not needed.
- [ ] **Data deletion and consent.** What is stored, for how long, and how a user deletes it. → not needed
- [ ] **Metrics for the pitch.** For example: share of videos classified correctly, time to first exercise, pass rate. → see at your discretion

## Open decisions and feature wishlist

Add rows here for exact behaviors you want; each row should say what the learner sees, so an agent can build and test it.

| Feature or decision | Component | Exact behavior wanted | Priority | Owner |
| --- | --- | --- | --- | --- |
| Abdul Bari videos pause at selected moments with a question | 1 | Pause at concept boundaries in his algorithms videos; concept question if no code on screen | High |  |
| Explain on success | 1 | Name the concept, the assessment level, and an optimization if the solution is weak | High |  |
| Diagnose on failure | 1 | Highlight the suspect lines and name the misconception | High |  |
| Pause frequency setting | 1 | Few / normal / many | Medium |  |
| Hints by level | 1 + 2 | Hint depth depends on skill level | Medium |  |
| Decay refresher | 2 | Weak skill → one refresher question next YouTube visit | Medium |  |
| Top 3 in-demand skills with video links | 2 |  | Low |  |
| Organization task board mock-up | 3 |  | Low |  |
|  |  |  |  |  |
