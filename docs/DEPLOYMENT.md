# Deploy the demo to Vercel

Vercel is the default host for **both the Next.js UI and its API routes**.
Supabase remains the managed Postgres database. No separate app server or function
platform is required. Use the exact stack in STACK.md.

## One-time event project setup

1. Create the event repo from this template and choose the Vercel account/team
   that will own the demo. Import that **event repo** into Vercel through its
   GitHub integration. Allow the integration to access that repo.
2. Apply the settings below before treating the first deployment as ready.
3. Put `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` in the root `.env.local`.
   Use a Vercel account token that can read/configure/deploy the selected project.
   The project ID is in Project Settings; the owner/team ID is in team settings
   or the project's existing `.vercel/project.json`. IDs are identifiers, not tokens.
4. Fill the Supabase public values and the selected model's key/model when needed.
   Each teammate keeps their own local credentials. Never commit the local env file.

GitHub and Vercel account authorization must actually be connected once; env
variables alone do not install the GitHub integration or grant team access.
The scripts target an existing project and refuse missing credentials or a
project/owner mismatch. They do not create a project, change a plan or buy a domain.

## Exact Vercel settings

| Setting | Value |
| --- | --- |
| Framework Preset | Next.js (`nextjs`) |
| Root Directory | `web` |
| Include source files outside Root Directory in Build Step | Enabled |
| Node.js | `24.x` |
| Install Command | `npm ci` |
| Build Command | `npm run build` |
| Output Directory | Framework default; no override (`null` in project settings) |
| Production Branch | `main` |
| App configuration | `web/vercel.json` |
| Project settings for the bot | `tools/vercel-project-settings.json` |

The outside-root setting is required: `web` scripts use `../tools/env.mjs`.
Vercel supplies hosted env values to the process; the ignored local file is not
needed in the cloud build. Run deployment commands from the repo root so the
uploaded source includes `web/` and `tools/`. Vercel selects `web` from project settings.

## Bot commands

The Vercel CLI is pinned to **65.10.0**, installed on first use. It reads
`VERCEL_TOKEN` from the process environment, without a token in the command line.
Use these root commands after filling credentials:

```sh
npm run env:check
npm run vercel:check
npm run vercel:configure
npm run vercel:check
npm run vercel:env -- preview
npm run check
npm run test:e2e
npm run deploy:preview
```

`vercel:check` verifies read access, project ID, owner ID and settings. It does not
prove all write/deploy permissions. `vercel:configure` applies only the settings
in the checked-in JSON. Production Branch remains a Git setting to verify in
Vercel's dashboard. `vercel:env` requires an explicit target, overwrites matching
variables there and passes values on stdin. It reports names only.

After the lead has a working demo and the human's deployment authorization:

```sh
npm run vercel:env -- production
npm run deploy:production
```

The deploy helpers verify the project/owner and settings before invoking the CLI.
They deploy to the configured project, wait for the build, and report its canonical
URL. A successful deployment command is not a completed product smoke test.
Additional read-only CLI tools are available as `npm run vercel -- <command>`;
check the command's `--help` first. Do not use verbose API/debug output around secrets.

## What gets uploaded as app environment

The sync deliberately includes only:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
- `LLM_PROVIDER`, `LLM_MODEL` and the **one selected** provider key, when selected.
- `DEMO_ACCESS_TOKEN`, if the product uses a demo gate and it is configured.

Public Supabase values are Config; server values are Secrets. Management tokens,
database passwords, direct DB URLs, AWS credentials, GitHub tokens, Vercel tokens,
IDs and preview-protection bypass credentials are not copied into app env.
The root `.vercelignore` also excludes local env/key files from CLI source uploads.
If the actual app needs another server credential, its owner explicitly extends
the allowlist in `tools/vercel.mjs` and documents the need. Do not upload the whole
env file. Changing model provider does not remove old remote variables; remove
obsolete keys deliberately. Redeploy after env changes; public Next.js values are
embedded at build time.

## Verify and hand off

1. Open the preview URL and run the actual input → result flow, including a useful
   failure case. Check the phone layout and loading/error states.
2. Verify `/api/health` returns HTTP 200 with `{"status":"ok"}`. That proves only
   the app server; also test the actual Supabase query/RLS and one real model call.
3. A protected preview can require a signed-in session. If an existing automation
   bypass secret is supplied, read `VERCEL_AUTOMATION_BYPASS_SECRET` from memory and
   send it in the `x-vercel-protection-bypass` header. Keep it out of URLs/logs.
   Do not disable protection or create bypass access just to make a check pass.
4. If using Supabase Auth, configure the production site URL and the intended
   callback/preview redirect URLs in that Supabase project, then test sign-in.
5. Record Vercel project/team IDs, canonical production/preview URLs, commit,
   Supabase project ref and smoke-test results in PLAN.md. Never record tokens.
6. Post one board completion with the tested URL, commit, checks and limitations.

With the Git integration connected, pushes to `main` produce Production deployments;
other branches produce Previews. Use the Git workflow or explicit CLI deployment
for a given commit deliberately, rather than creating duplicate deployments.
Confirm teammate commit/deploy permissions if Vercel rejects a deployment.
For rollback, select a known-good deployment in Vercel and use its documented
rollback/promotion flow; record the commit and recheck the main journey.

## Readiness and failure handling

The template's offline tests verify scoping, secret selection and command construction.
No live Vercel project has been connected or deployed by preparing this template.
Missing credentials are reported by name. An authorization failure needs the right
token/team access; a settings mismatch needs `vercel:configure`; a cloud build
failure needs its build logs. Report the exact blocker and avoid repeated deploys.
A public five-minute demo still needs an approved spend and a resource owner.

Sources: [Monorepo settings](https://vercel.com/docs/monorepos/monorepo-faq),
[CLI token auth](https://vercel.com/docs/cli/global-options#token),
[Project API](https://vercel.com/docs/rest-api/projects/update-an-existing-project),
[Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions),
[Protected preview automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation).
