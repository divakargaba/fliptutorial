# Event brief

Phase: **PREP**

Only the lead moves this to BUILD. Instructions from the lead (@divakargaba), on the board or directly, are authorized work in any phase.
The template is tooling and a runnable starter; it is not the submitted product.

## Event

- Name: TBD
- Start / submission deadline / timezone: TBD
- Team lead: @divakargaba
- Teammate GitHub logins and roles: fill AGENTS.md
- Judging criteria / required sponsor APIs: TBD
- Approved total spend and resource owners: TBD — no paid provisioning is authorized yet
- Demo target: one reliable five-minute presentation
- Hosting: Vercel for the Next.js UI and API routes (Node 24, root `web`)
- Event Vercel project / team IDs and public demo URL: TBD
- Supabase demo project: TBD
- Selected LLM provider / model: TBD at kickoff

## Actual prompt

Paste the official prompt verbatim here when released. Include rules on prior
work, allowed tools, data use, sponsor requirements and submission format.

## Product decision

- User and problem: TBD
- One-sentence demo promise: TBD
- Smallest end-to-end user journey: TBD
- One must-have user journey: TBD
- Explicitly out of scope: TBD
- Real data vs seeded/demo data: TBD; label simulated output honestly

## Readiness before the event

- [ ] Check event rules permit using this prebuilt starter; otherwise use only the permitted docs/tooling.
- [ ] Create the event repo from this template, invite teammates, and have them accept.
- [ ] Every teammate has Git, Node 24, GitHub CLI, and their chosen agent signed in.
- [ ] Everyone clones separately, runs `tools/setup`, `tools/board whoami` and `npm run setup`.
- [ ] Fill real ownership and integration branch in AGENTS.md / PLAN.md.
- [ ] Test one board ping and a reply from another teammate's agent.
- [ ] Run `npm run check` and `npm run test:e2e` locally before the event.
- [ ] Prepare provider access following docs/CREDENTIALS.md; record names/status, never secret values.
- [ ] Fill the root `.env.local`, run `npm run env:check`, and verify the project/account identities for enabled tools.
- [ ] Configure the Supabase URL and publishable key; verify the first real query when the product schema exists. AWS is not required.
- [ ] Import the event repo into Vercel, fill its three credential/ID slots and follow docs/DEPLOYMENT.md.
- [ ] Verify Vercel settings, sync Preview app env and complete a deployed smoke test.

## At prompt release

Paste `prompts/kickoff.md` into the lead's agent with the real prompt. Have each
teammate use `prompts/teammate.md`, then start a single watcher. See README.md.
