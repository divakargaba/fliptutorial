# Exact hackathon stack

**Next.js + TypeScript + Tailwind + Supabase + Vercel + one LLM provider.**
Build one reliable five-minute demo. These are the defaults for every team agent.

| Layer | Choice / pinned version | Responsibility |
| --- | --- | --- |
| Runtime | Node.js 24.x, npm | Local, CI and Vercel runtime; `.nvmrc` and package engines agree |
| Full-stack framework | Next.js 16.4.4, App Router | Pages, layouts and server API endpoints |
| UI | React / React DOM 19.3.0 | Interactive screens and result states |
| Types | TypeScript 5.9.3 | App and contract type checks |
| CSS | Tailwind CSS 4.3.4 + standard PostCSS plugin | Styling; use native accessible controls first |
| Data | Supabase managed Postgres; supabase-js 2.118.0 | Tables, SQL, grants and RLS |
| Optional product services | Supabase Auth / Storage / Realtime | Only when the actual demo needs them |
| Hosting | Vercel | Next.js frontend plus Node.js API functions, HTTPS and deployment URLs |
| AI | One of OpenAI, Anthropic, Gemini or DeepSeek | Select one approved model/key at kickoff; no provider-switching framework |
| Unit/component checks | Vitest 5.1.0 + React Testing Library | Important decisions, failures and UI behavior |
| Browser checks | Playwright 1.64.1, Chromium | Desktop/phone UI and real app-server round-trip in dev and production |
| CI and collaboration | GitHub Actions + Message Board issue | Fresh-checkout checks, ownership and agent handoffs |
| Agent management tools | Supabase CLI 3.0.0, Vercel CLI 65.10.0 | Pinned npm commands; credentials loaded from local env |

`web/package-lock.json` is the dependency authority; use `npm run setup` / `npm ci`.
Vercel controls Node 24's minor/patch version. The hosted Supabase Postgres version,
actual model, project IDs and demo URLs are recorded after the event project is chosen.
Vite is an internal test-runner dependency, not the app framework.

## Where work goes

| Need | Path / service |
| --- | --- |
| Pages and layout | `web/src/app/` |
| Interactive UI | `web/src/components/` client components |
| Browser Supabase access | `web/src/lib/supabase/client.ts`, publishable key + RLS |
| Schema and access policies | SQL migrations in `supabase/` |
| LLM and private API calls | Next.js Route Handlers in `web/src/app/api/` |
| Server-only helpers | `web/src/lib/`; keep secret-using helpers server-only |
| Local credentials | Ignored root `.env.local`; template in `.env.example` |
| Cloud app credentials | Vercel Preview / Production env, using the explicit runtime allowlist |
| Hosting settings and runbook | `web/vercel.json`, `tools/vercel-project-settings.json`, docs/DEPLOYMENT.md |

The browser receives only the Supabase URL and publishable key. LLM endpoints use
server-side Node.js execution and validate access and inputs, with a timeout and
output limit. Management/AWS/deployment tokens stay with agent tools unless an
actual product feature explicitly needs a server credential.

## Build the story you will show

1. Pick one user, one problem and one main input → result journey.
2. Make it real with a small synthetic dataset; agree the schema and API contracts.
3. Add loading, one useful error and a reliable reset.
4. Deploy a preview early, then rehearse the five-minute production walkthrough.

Skip login for synthetic public demo data unless needed. Still enable RLS and
grant only intended access on exposed tables. Private data needs identity and
row ownership checks. Paid endpoints need user authorization or a server-validated
demo gate; a publishable key alone does not authorize a user.

Use Next.js and Supabase platform features. AWS is optional for a sponsor/feature,
not another default hosting backend. A separate API server, ORM, queue, second
function runtime or evaluation platform is not required for the baseline demo.
Try a few real model inputs with a bounded budget and label fallback output.

Sources: [Next.js Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers),
[Supabase access](https://supabase.com/docs/guides/database/secure-data),
[Vercel monorepos](https://vercel.com/docs/monorepos/monorepo-faq).
