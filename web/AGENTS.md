Read ../AGENTS.md, ../HACKATHON.md, ../PLAN.md and ../docs/STACK.md first.
This is a Next.js App Router app. The Supabase client lives in src/lib/supabase/.
Product SQL migrations live in ../supabase/; LLM endpoints live in src/app/api/.
The npm scripts load ../.env.local through the root tools/env.mjs helper.
Only NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY go to the browser.
Do not add a separate API server or production infrastructure for a demo.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
