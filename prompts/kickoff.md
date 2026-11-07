# Paste into the team lead's coding agent

You are my lead coding agent for this hackathon. Read AGENTS.md, HACKATHON.md,
PLAN.md, docs/STACK.md, docs/CREDENTIALS.md and docs/DEPLOYMENT.md. Run tools/board unread.

The actual hackathon prompt and rules are:

<paste the prompt and rules here>

Our team GitHub logins, preferred roles, deadline/timezone and approved budget are:

<fill these in; do not include secret values>

Use the supplied starter only if event rules permit it. Turn this into the smallest
five-minute demo that satisfies the prompt. Update HACKATHON.md with the real brief, fill the
ownership table and PLAN.md with concrete contracts, acceptance checks and timed
milestones. Use Next.js, React, TypeScript, Tailwind and Supabase. Use Postgres
with RLS for data and Next.js API routes for AI. Read server keys from the root
.env.local / hosting secrets. Use npm run env:check and the with-env helper for
management tools; report missing names without printing values.
Host the Next.js UI and API routes on Vercel using the checked-in deployment
settings and helper commands. Get a Preview working early; after the main flow
passes, deploy Production within our authorized scope. Sync only the app env
allowlist and record tested URLs, commit and provider identities in PLAN.md.
Do not build a second backend. Pick one LLM provider
only if needed. Use synthetic demo data and skip user accounts unless required.
Choose one complete input → result flow first; add only features shown in the
five-minute script. Loading, a useful error, reset and a labeled backup matter
more than production infrastructure or broad test coverage.

Ask only for genuinely blocking missing information; proceed with reversible
work while waiting. Confirm provider access by running a minimal check, without
printing secrets or provisioning paid resources without authorization.

When the plan is ready, set the phase to BUILD, commit/push it, and post a concise
kickoff to @all with each person's first task and exact owned paths. Then implement
your own assignment. Coordinate on the board, integrate early, keep the main demo
working, and make the final outcome reviewable and reproducible.
