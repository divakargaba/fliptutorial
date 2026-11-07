# Hackathon Agent Template

A ready-to-run Next.js starter and a shared GitHub message board for your
team's coding agents. **Next.js + TypeScript + Tailwind + Supabase + Vercel**, focused on one
working five-minute demo. Prepare it before the event; paste the prompt at kickoff.

## 1. Before the hackathon

Use **Use this template → Create a new repository** on
[micobenissa/hackathon-agent-template](https://github.com/micobenissa/hackathon-agent-template).
Create a separate event repo, invite teammates, and have each person clone it.
Templates copy files, not issues, secrets or collaborator access.

Install Node 24, Git and [GitHub CLI](https://cli.github.com). On Windows run the
`tools/` commands from **Git Bash**, included with Git for Windows, not the WSL
`bash.exe` shim. Install and sign in to the coding agent you choose.

```sh
git clone https://github.com/YOUR-TEAM/YOUR-EVENT.git
cd YOUR-EVENT
gh auth login
tools/setup
tools/board whoami
npm run setup
npm run dev
```

`npm run setup` also creates the ignored **root `.env.local`** without overwriting
existing values. Fill the needed slots from [.env.example](.env.example): Supabase
app/management access, one LLM key, Vercel deployment access and optional AWS/GitHub credentials.
Run `npm run env:check` for a redacted presence check, then restart the app.
See [docs/CREDENTIALS.md](docs/CREDENTIALS.md) for which keys enable each capability.
Teammates use their own provider accounts and local env copies.

```sh
npm run env:check
npm run with-env -- aws sts get-caller-identity
npm run supabase -- projects list
```

The Supabase command installs its pinned CLI on first use. Install AWS CLI v2
before using its command. The helper loads the local file for that
process only; it does not print credentials or authenticate separate MCP connectors.
`npm run demo` starts the Next.js app with UI and API routes together.

Vercel is the deployment default for both UI and API routes. Import the event repo,
fill its token/project/team IDs, then follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
The guide fixes the `web` root, outside-root source access, Node 24, app env sync,
Preview/Production commands and the exact checks an agent performs before handoff.

```sh
npm run vercel:check
npm run vercel:configure
npm run vercel:env -- preview
npm run deploy:preview
```

The lead runs setup first: it creates/finds the Message Board, pins it when allowed,
and writes `.board-issue`. Commit that number if changed. Teammates run the same
setup; it reuses the board. Use `tools/setup --issue N` if you have an existing one.

Fill the team table in AGENTS.md and the readiness checklist in HACKATHON.md. Give
each person a separate clone. Set Git identity with `git config user.name` and
`git config user.email` before making commits. Check event rules permit prebuilt code.

## 2. When the prompt drops

Paste [prompts/kickoff.md](prompts/kickoff.md) plus the real prompt into the lead's
agent. Each teammate pastes [prompts/teammate.md](prompts/teammate.md) into theirs.
The lead records the demo goal, contracts, exact ownership and first tasks, then
tags the team on the board. Agents wait for assignments rather than inventing a product.

## 3. Keep agents listening

Choose **one** per clone:

```sh
AUTOPILOT_NAME=Mico tools/autopilot codex
# or
AUTOPILOT_NAME=Sam tools/autopilot claude
```

These use your installed agent CLI and credentials. They catch up, run one task
at a time, then wait for your login or `@all`. Leave the terminal/computer running;
Ctrl+C stops it. A failed agent run or dirty tracked files stop the runner visibly.
No permissions are bypassed. Codex uses workspace-write with network access;
Claude uses acceptEdits and a small shell allowlist. Review the scripts before use.

For the **desktop app**, paste [prompts/monitor.md](prompts/monitor.md) and ask it to
schedule checks in the repo's chat. Do not run the CLI watcher as well. The app and
computer must stay running for local work. To do a single CLI check, use
`tools/autopilot --once codex` (or `claude`).

Claude hooks surface unread posts at session start and each prompt. Codex reads
AGENTS.md; Cursor has an always-on rule pointing to it. Hooks/rules do not provide
an idle wake-up mechanism by themselves.

## Board commands

```sh
tools/board post "[Mico] @all Board test. Reply once from another agent."
tools/board unread
tools/board read -n 20
tools/board wait --interval 30 --timeout 120
```

`@all` is a marker our script recognizes, not a real GitHub team notification.
Posts must start with `[Name]` (the human, never the agent/tool). Use the actual GitHub login for handoffs.
`read` does not mark read; `unread` advances the cursor. `wait` ignores this clone's
own posts and returns other posts, marking mentions. State is private to `.git/board/`.
`BOARD_CONSUMER` selects an independent cursor; the CLI runner and hooks use their
own. `BOARD_REPO`, `BOARD_ISSUE` and `BOARD_INTERVAL` override defaults.

## The starter

- **Next.js + React + TypeScript + Tailwind**, including a working app-server check.
- **Supabase client** ready for the event's Postgres database.
- **Next.js Route Handlers** for the selected LLM; add Supabase Auth or Storage only if needed.
- **Vercel hosting**, scoped project/configuration checks and runtime-only env sync.
- **One local env file**, automatic non-overwriting setup, redacted checks and an agent-tool loader.
- **Vitest + React Testing Library**, **Playwright** browser smoke and GitHub Actions checks.
- [Exact stack](docs/STACK.md), [credentials](docs/CREDENTIALS.md),
  [deployment runbook](docs/DEPLOYMENT.md) and [testing plan](docs/TESTING.md)
  are written for both humans and agents.

```sh
npm run check
cd web && npx playwright install chromium && cd ..
npm run test:e2e
```

The app starts without cloud credentials. Only the Supabase URL and publishable
key have `NEXT_PUBLIC_` names. Other credentials stay in server/tool processes.
No cloud project, product schema or LLM endpoint is created before the prompt.
The UI reports Supabase configuration, not a verified database connection.
At kickoff, verify the first real query and AI call, then rehearse the demo in PLAN.md.

## Troubleshooting

- **gh not found / not logged in:** install GitHub CLI, restart Git Bash, run `gh auth login`.
- **Wrong account:** check `tools/board whoami` and `gh auth status`; switch accounts yourself.
- **Board missing:** the lead runs `tools/setup`; pull the committed `.board-issue`.
- **Own posts wake the agent:** ensure each teammate has a separate clone and one watcher.
- **Runner/state lock remains after a crash:** confirm the old process stopped before removing
  the specific stale `.git/board/*.lock` directory named by the error. Never delete a live lock.
- **Push conflict:** pull/rebase; resolve only your files or ask the owner. Never force-push.
- **No new messages:** normal polling stays quiet. An idle agent needs the watcher or app schedule.

## Provenance and current references

This coordination flow is based on the supplied
[Hackathon Agent Board guide](https://marvelous-relative-5de.notion.site/hack)
and the board/runner tested with the team in `divakargaba/agenttest`.
The template contains no game code, board history, credentials or teammate assignments.
Codex runner flags follow the [official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode);
Claude hooks follow its [official hooks reference](https://code.claude.com/docs/en/hooks).
