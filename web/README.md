# Demo app

**Next.js + React + TypeScript + Tailwind**, with Supabase Postgres.
**Vercel hosts the UI and API functions.** The project root is `web`; outside-root
source access stays enabled so the shared env helper can run during builds.
Read root README.md, AGENTS.md and PLAN.md first.

From the repository root:

```sh
npm run setup
npm run demo
```

Next.js starts at http://127.0.0.1:3000 (another port if occupied). The local env
file is **../.env.local**, at the repo root. The npm scripts load it before Next
starts or builds. Setup creates it without overwriting existing values. Run
`npm run env:check` at the root to see missing variable names without values.

Pages live in `src/app/`; LLM endpoints belong in `src/app/api/`. Use the Supabase
client in `src/lib/supabase/client.ts` and put SQL migrations in `../supabase/`.
Only the Supabase URL and publishable key have a `NEXT_PUBLIC_` prefix.

`Check local app` verifies client hydration and the `/api/health` round-trip.
It does not verify Supabase or a model provider. Add the actual prompt's schema
and LLM call at kickoff. The dev command uses Webpack for reliable local refresh;
production builds use the standard Next.js build. Vitest uses Vite internally.

See ../docs/STACK.md for pinned stack versions, ../docs/CREDENTIALS.md for access,
and ../docs/DEPLOYMENT.md for exact Vercel settings and deployment commands.
