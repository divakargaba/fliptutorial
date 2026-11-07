# Build plan — fill at kickoff

Status: PREP. No product work is assigned yet.
Integration branch: `main`.

## Runtime and checks (starter)

Node 24, npm. From repo root:

```sh
npm run setup         # installs dependencies and creates root .env.local if missing
npm run env:check     # redacted presence check; missing required values exit nonzero
npm run dev           # http://127.0.0.1:3000; Next.js UI + API routes
npm run demo          # same app command, for rehearsal
npm run with-env -- <command> [args]  # local env for agent tools
npm run typecheck
npm test              # board/runner regression tests + web unit/component tests
npm run build
npm run test:e2e      # browser smoke, after Playwright browser installation
npm run vercel:check  # verifies the configured Vercel project/owner and settings
npm run vercel:configure
npm run vercel:env -- preview
npm run deploy:preview
```

Record any additional project commands here when needed. Do not assume a command
exists just because another team's project used it.

## Architecture decision

Next.js + React + TypeScript + Tailwind, with Supabase Postgres and Next.js API
routes for LLM calls. Use one LLM provider if needed. Read docs/STACK.md.
Vercel hosts both UI and API functions; follow docs/DEPLOYMENT.md. Node 24,
project root `web`, outside-root source access enabled, standard Next.js output.
Aim for one real user journey that demonstrates well in five minutes. No separate
backend/API server, AWS setup or account system by default.

## Contracts — agree before parallel implementation

Replace these with concrete definitions, examples and owners:

- Pages and the one primary user journey: TBD
- Tables, fields, RLS access and API route names / arguments / result / error: TBD
- Minimal data needed by this demo; synthetic seed/reset: TBD
- LLM input/output, selected provider/model, timeout/output limit, fallback: TBD
- Shared TypeScript types and the owner of changes: TBD
- Environment variable **names**, who supplies them, where they run: docs/CREDENTIALS.md

## Event deployment record — fill with identifiers and results, never secrets

| Item | Event value |
| --- | --- |
| Event GitHub repo | TBD |
| Vercel project name / project ID / owner-team ID | TBD; credential values stay in local env |
| Production branch | main |
| Verified Production URL / commit / check time | TBD |
| Latest tested Preview URL / commit | TBD |
| Supabase project ref / region / Postgres version | TBD |
| Selected model provider / model | TBD |
| Required runtime env names beyond the default allowlist | None until a feature needs them |
| Auth redirect URLs, if Auth is used | TBD |
| Resource/deployment owner and approved spend | TBD |

## Assignments

| ID | Owner login | Owned paths | Deliverable and acceptance check | Depends on | State |
| --- | --- | --- | --- | --- | --- |
| K0 | @divakargaba | HACKATHON.md, PLAN.md, AGENTS.md | Record prompt, roster, architecture, contracts and first assignments | Actual prompt | Waiting |

Each task must name a real owner, exact paths, a demonstrable outcome and a check.
Post the kickoff tasks on the board; do not make teammates discover assignments
only by reading a changed file. Update State when work is shipped or blocked.

## Delivery milestones

Use percentages of the actual available event time, then replace with timestamps:

1. **First 10%:** choose one user journey, agree the Supabase schema, access rules and function contracts, prove the connection.
2. **By 35%:** complete one thin UI → server → data/LLM → UI flow using explicit mocks only where necessary.
3. **By 65%:** replace critical mocks, integrate all must-haves, test access and provider failures.
4. **By 85%:** freeze features; fix the demo, phone layout, loading/error/empty states and costs.
5. **Final 15%:** rehearse from a clean session, capture a fallback demo, finish submission and cleanup notes.

## Ship gate

- [ ] Main journey and error path work with the actual selected providers.
- [ ] Auth and row ownership are tested when the product has private/user data.
- [ ] Typecheck, tests, production build and browser smoke pass.
- [ ] Try a few real AI inputs if needed; mocks/fallbacks are labeled.
- [ ] No client/admin key leaks; spending controls and teardown owner are recorded.
- [ ] Another teammate can run the README instructions and demo it.
- [ ] Vercel Production URL, actual Supabase/model flow and any Auth redirects are verified.
- [ ] Lead posts DONE with the demo URL, commit and known limitations.

## Five-minute presentation

- **0:00–0:30:** who has the problem and what the demo does.
- **0:30–3:30:** run the one main input → result journey with the actual backend.
- **3:30–4:30:** show the useful outcome and one differentiating feature.
- **4:30–5:00:** impact, limits and wrap-up. Keep reset/backup data ready.

Five minutes is the presentation length, not the build deadline. Cut features
that do not help this story; spend saved time making the main flow reliable.
