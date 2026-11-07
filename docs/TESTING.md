# What to test during the hackathon

Keep tests focused on the demo, contracts and access boundaries. A large coverage
percentage is not the goal. These tools are already configured in the starter.

| Check | Command from root | When / what it catches |
| --- | --- | --- |
| Types | `npm run typecheck` | Before each push; request/response and component contract mismatches |
| Tooling | `npm run test:tools` | Board/runner behavior, env loading, Vercel project scoping and credential allowlisting |
| Unit/component | `npm test` | Validation, decisions, configuration, loading/error behavior |
| Production build | `npm run build` | Before deployment; type and build-time issues |
| Browser smoke | `npm run test:e2e` | Real page, client hydration and API round-trip at desktop/phone widths |
| Dev startup | `npm run test:e2e:dev` | The same browser smoke against Next.js development mode |

Install the browser once with `cd web && npx playwright install chromium`.
CI installs its own browser dependencies. Playwright uses a production build and
port 3100 so it does not collide with your normal dev server on port 3000.

## Add these checks when the product exists

1. The main user journey: input → Next.js API / Supabase data → result → UI.
2. The highest-risk error: invalid input, provider timeout/rate limit, or failed upload.
3. User data access: unauthenticated requests and cross-user read/write attempts must fail.
4. AI quality: try a few demo inputs; keep paid calls out of ordinary tests.
5. A real, bounded provider smoke check with secrets supplied privately, run by its owner.
6. Phone width, keyboard focus, accessible labels, loading/empty/error states.

Mock provider HTTP calls in ordinary tests. Do not replace the final demo's core
behavior with a mock and call it integrated. Label demo data and fallbacks clearly.
Test Supabase changes on the event's agreed development project. Use synthetic data; do not
reset another teammate's demo dataset. A synthetic-data demo need not add login
just to check a testing box. Protect paid public actions even when skipping accounts.

GitHub Actions checks this template without any cloud secrets. The SDK test uses
a mocked Data API response; the browser smoke does not verify a live database.
The health route checks only the Next.js app. Env checks report presence, not
authentication. Verify live Supabase/AWS/LLM access separately with a bounded,
read-only check, and record the result without secrets. Only integration jobs need
credentials. Do not put API keys in fixtures.

Vercel helper tests use a fake CLI response; they do not claim live account access
or deployment success. After credentials are supplied, follow DEPLOYMENT.md to
verify the project/owner, deploy a Preview and test the actual hosted journey.
Keep the URL, commit and result in PLAN.md. A successful local/CI build or health
route alone is not proof that Supabase/model access works on Vercel.

Sources: [Vitest](https://vitest.dev/guide/),
[Playwright](https://playwright.dev/docs/intro).
