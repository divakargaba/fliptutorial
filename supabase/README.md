# Supabase database

Use one event project. Add the actual demo's schema, grants and RLS policies in
SQL migrations here after the prompt. Create migration files using the Supabase
CLI, after checking its current version/help. Coordinate fields and access rules
with the UI owner before editing. Enable RLS on exposed tables; do not resolve
access errors by disabling it or exposing a secret/service-role key in the browser.

LLM calls live in `web/src/app/api/` Next.js Route Handlers. The browser Supabase
client is `web/src/lib/supabase/client.ts`. Local server and management credentials
live in the ignored root `.env.local`; read docs/CREDENTIALS.md for names and usage.

Verify project identity before management operations. Record deploy/test commands
and real data round-trip results in PLAN.md, without secret values. No local
Docker stack or separate API server is required for a hosted demo project.

[Supabase CLI](https://supabase.com/docs/reference/cli/introduction) ·
[Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
