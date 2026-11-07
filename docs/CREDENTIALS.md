# One local credentials file

Run `npm run setup`. It creates **`.env.local` at the repository root**, beside
`.env.example`. Fill values there. Each teammate has their own ignored copy.
The committed example contains placeholders only. Setup never overwrites a filled file.

The Next.js npm scripts load this root file for dev, build and production start.
Use the same loader for agent tools:

```sh
npm run env:check
npm run with-env -- aws sts get-caller-identity
npm run supabase -- projects list
```

`env:check` prints variable names and presence only, returning nonzero for missing
required or partially configured groups. It does not authenticate. `with-env`
passes nonempty file values to one child process; existing process/CI values win.
Values are literal, with no shell evaluation or variable expansion. Quote values
containing `#` or newlines. Do not create a second env file inside `web/`.

## What to fill

| Capability | Variables | Needed when |
| --- | --- | --- |
| App database connection | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Connecting the event's Supabase project |
| Privileged server DB access | `SUPABASE_SECRET_KEY` or legacy `SUPABASE_SERVICE_ROLE_KEY` | A server operation actually needs admin access; bypasses RLS |
| One model provider | `LLM_PROVIDER`, `LLM_MODEL`, and the corresponding `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` or `DEEPSEEK_API_KEY` | Implementing the demo's AI endpoint |
| Supabase management | `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` | Agent needs management API / CLI access, migrations or deployment |
| DB tooling | `SUPABASE_DB_PASSWORD`, optional `DATABASE_URL` | Linking/direct SQL tools require them |
| AWS profile / SSO | `AWS_PROFILE`, `AWS_REGION` | Using an existing logged-in AWS CLI profile |
| AWS temporary credentials | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION` | Using the event's temporary role credentials instead of a profile |
| GitHub | Optional `GH_TOKEN` | Existing `gh auth login` / Git Credential Manager is insufficient |
| Vercel deployment | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | Default Next.js host; required for agent deployment commands |
| Protected preview checks | Optional `VERCEL_AUTOMATION_BYPASS_SECRET` | An existing bypass is needed for automated smoke checks |
| Shared demo gate | `DEMO_ACCESS_TOKEN` | The actual app implements a server-validated demo access check |

Only the two `NEXT_PUBLIC_SUPABASE_*` values go to browser code. Model keys,
admin/management tokens, database passwords and AWS keys are server/tool secrets.
The publishable key identifies the project; use RLS policies and grants for access.
Choose one LLM provider; empty slots for the others are fine. Slots do not create
an LLM endpoint or cloud resources before the actual prompt.

## Give agents usable access

Invite teammates to the event's Supabase project with their own accounts. The
public app key does not grant dashboard or schema-management access. Supply a
management token for CLI/API tasks and the project ref; verify the selected project
before changes. A separate MCP connector uses its own OAuth configuration and is
not connected automatically by this env file.

For AWS, use a named SSO/profile or the event's temporary role credentials. Finish
SSO login before agent work. Leave the unused method empty. A console email and
password do not authenticate AWS SDK/CLI calls. The role's IAM permissions define
what the agent can do. Install AWS CLI v2 when using its commands; npm-based tools
can run through `with-env -- npm exec -- ...`. The `supabase` npm command provides
the pinned Supabase CLI on first use; it already uses the env loader. Other
credentials do not install their tools.

The agent may use configured credentials for the tasks you authorize. Record
project/account IDs, resource owners, approved spend and access-test results in
PLAN.md/HACKATHON.md. Never record values. Confirm identity with read-only calls
before modifying resources; a configured token does not prove its permissions.
Read secrets in process memory, without printing the file or passing tokens in
arguments/URLs. Reuse the installed CLI's login where it already works.

## Deployment and readiness

Vercel is the host for both UI and API routes. Follow **DEPLOYMENT.md** for the
event project setup, exact build settings and bot commands. Its CLI is pinned to
65.10.0 and reads the token from env. The checked-in helpers verify project/owner
identity and sync only the app's allowed public values, selected model key and
optional demo gate to a named Preview or Production environment. Values go over
stdin, not command arguments. Management/AWS/GitHub/deployment credentials remain
local. Public Next.js values are embedded at build time; redeploy after changing
hosted values and restart dev after editing this file.

- [ ] Fill the root env file and run the redacted check.
- [ ] Verify the event Supabase project and intended query/RLS access.
- [ ] Verify AWS account/role if AWS is enabled.
- [ ] Verify the Vercel project/owner and settings, sync app env and smoke-test a Preview.
- [ ] Verify one real LLM input once its endpoint is implemented.
- [ ] Confirm the presenter can reset and run the complete demo.

No event project, paid resources or credentials are created by this template.
Actual live permissions remain unverified until valid credentials are supplied.

Sources: [Next.js env behavior](https://nextjs.org/docs/app/guides/environment-variables),
[Supabase keys](https://supabase.com/docs/guides/getting-started/api-keys),
[Supabase CLI](https://supabase.com/docs/reference/cli/introduction),
[AWS credentials](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-envvars.html),
[OpenAI key handling](https://developers.openai.com/api/docs/guides/production-best-practices).
