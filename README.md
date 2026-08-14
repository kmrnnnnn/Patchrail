# Patchrail

Patchrail inspects a connected repository, identifies external API integrations, checks current first-party documentation with OpenAI web search, prepares a bounded code update, verifies the exact patch in an isolated environment, and opens a GitHub Draft PR. It never merges a PR.

## Architecture

- The Next.js web service provides the public site, Better Auth GitHub login, application UI, API routes, signed webhooks, and authenticated runner endpoints.
- PostgreSQL stores users, workspaces, installations, repository state, the durable run queue, events, verification jobs, cost reservations, billing snapshots, and worker heartbeats. No Redis service is required.
- The worker claims queued runs with PostgreSQL row locks, materializes the recorded GitHub commit through a short-lived installation token, drives OpenAI Responses API calls and web search, queues verification, and delivers only verified changes to a Draft PR.
- Verification runs either in a disposable Railway Sandbox or on the included outbound-polling Docker runner. Customer commands never execute in the web or worker process.
- Stripe Elements provides the embedded billing UI. Signed Stripe webhooks and direct reconciliation keep entitlements current.

The supported runtime is Node.js 22 or newer with pnpm 11.17.0. The dependency lockfile, Railway SDK, and verifier images are pinned; review their release notes and rerun the security tests before changing them.

## Local setup

Prerequisites: Node.js 22+, Corepack, Docker, and a PostgreSQL 15+ server. GitHub and Stripe webhooks require a public HTTPS URL; use a dedicated development app/account and a trusted tunnel when exercising them locally.

```powershell
corepack enable
pnpm install --frozen-lockfile
Copy-Item .env.example .env.local
docker run --name patchrail-postgres -e POSTGRES_PASSWORD=patchrail -e POSTGRES_DB=patchrail -p 127.0.0.1:5432:5432 -d postgres:17-bookworm
$env:DATABASE_URL = "postgresql://postgres:patchrail@127.0.0.1:5432/patchrail"
pnpm db:migrate
pnpm dev
```

Load `.env.local` into each process using the environment-management method appropriate for the shell. For the full workflow, start the worker in a second terminal:

```powershell
pnpm worker
```

With `VERIFICATION_MODE=external_runner`, start the runner on a Docker-capable machine in a third terminal:

```powershell
pnpm runner
```

The runner needs `RUNNER_BASE_URL`, the same `RUNNER_SHARED_SECRET` as the web service, verification limits, and a working Docker daemon. It does not need database, GitHub, OpenAI, or Stripe credentials.

Useful checks:

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`GET /api/health` is a liveness and configuration report and intentionally stays healthy during an OpenAI outage. `GET /api/ready` checks PostgreSQL and returns `503` when the database is unavailable. Neither endpoint returns secrets or raw connection errors.

## Configuration

Start from [`.env.example`](./.env.example); it is the canonical variable inventory. Never commit `.env.local`, private keys, webhook secrets, API keys, database URLs, or runner secrets.

Required categories are:

- Core web: `DATABASE_URL`, canonical `APP_URL`, and a random `AUTH_SECRET` of at least 32 characters. Production `APP_URL` must be the generated HTTPS origin with no path, query, or fragment.
- GitHub login and repository access: `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET`.
- Live AI: `OPENAI_API_KEY`, `OPENAI_MODEL`, all four positive pricing fields, and the `AI_MAX_*` / web-search limits. Copy current prices for the selected model and hosted web-search tool from the [official OpenAI pricing page](https://openai.com/api/pricing/); Patchrail deliberately refuses missing or zero pricing rather than undercounting cost.
- Plans: repository limits and FREE/PRO AI budgets. The FREE grant is one lifetime trial per user and is not recreated by deleting a workspace.
- Billing: matching-mode `STRIPE_SECRET_KEY` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, plus `STRIPE_WEBHOOK_SECRET`, deployment-specific `STRIPE_ACCOUNT_KEY`, and `STRIPE_PRO_LOOKUP_KEY`.
- Verification: choose exactly one mode described below. Keep CPU, memory, timeout, lease, and concurrency limits conservative for the host.
- Worker: `WORKER_POLL_INTERVAL_MS`, `WORKER_CONCURRENCY`, and `WORKER_STALE_AFTER_MINUTES`; defaults are suitable for the first deployment.

Use independent secrets per environment. Generate secrets in an operator terminal or secret manager and place them directly in local secret storage or Railway Variables; do not send them through chat or commit them.

## GitHub App setup

Patchrail intentionally uses one GitHub App for two separate authorizations:

1. Better Auth uses the app's OAuth client ID and client secret to identify the user.
2. A GitHub App installation grants selected-repository access through short-lived installation tokens.

The OAuth credentials **must come from this same GitHub App**, not a standalone OAuth App. Patchrail uses the resulting GitHub App user token to prove that the signed-in user can access an installation before saving it. The two token types remain separate and OAuth tokens are encrypted at rest.

After Railway has generated the production domain, create or update the GitHub App with these exact URLs, replacing `<APP_URL>` with that HTTPS origin:

| GitHub setting                  | Value                                |
| ------------------------------- | ------------------------------------ |
| Homepage URL                    | `<APP_URL>`                          |
| User authorization callback URL | `<APP_URL>/api/auth/callback/github` |
| Setup URL                       | `<APP_URL>/api/github/callback`      |
| Webhook URL                     | `<APP_URL>/api/github/webhook`       |

Configure the registration as follows:

- Disable **Request user authorization (OAuth) during installation**. GitHub otherwise disables the Setup URL and bypasses Patchrail's state-checked installation callback.
- Disable **Redirect on update**. Repository-selection changes are synchronized by webhook or the in-product refresh action and do not carry Patchrail's one-time setup state.
- Allow installation on any account for a public SaaS deployment. A private staging app can remain owner-only.
- User permission: **Email addresses: Read-only**, used by GitHub login when a profile email is private.
- Repository permissions: **Metadata: Read-only**, **Contents: Read and write**, and **Pull requests: Read and write**. Request no Actions, Workflows, Administration, Secrets, or unrelated permissions.
- Subscribe to **Installation**, **Installation repositories**, and **Repository** events. Enable the webhook and use a random webhook secret of at least 16 characters (32+ recommended).

Create a private key, put its complete PEM value in `GITHUB_PRIVATE_KEY` (Railway accepts multiline values; escaped `\n` is also normalized), and set the numeric App ID, slug, webhook secret, client ID, and client secret in Railway. Install the app on an explicit test repository first. Users can then connect, refresh repository access, manage the installation on GitHub, or disconnect it in Patchrail.

Changing permissions requires installation owners to approve the new grant. See GitHub's [permission guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) and note that the OAuth callback and Setup URL are [different GitHub App settings](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url).

## Stripe setup

Use Stripe test mode until the complete workflow has passed:

1. Create a Patchrail PRO product and one active, positive, monthly, licensed recurring price.
2. Give the price the lookup key configured by `STRIPE_PRO_LOOKUP_KEY` (the example uses `patchrail_pro_monthly`). Keep that lookup key unique and stable; changing an amount should create a new price with the same intended lookup-key migration rather than mutating historical invoices.
3. Put the test secret and publishable keys from the same Stripe account and mode in Railway. Choose a unique `STRIPE_ACCOUNT_KEY` for this Patchrail deployment.
4. Create a webhook endpoint at `<APP_URL>/api/stripe/webhook`, copy its signing secret to `STRIPE_WEBHOOK_SECRET`, and subscribe at minimum to `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.deleted`, `invoice.paid`, `invoice.payment_failed`, and `setup_intent.succeeded`.
5. Exercise upgrade, required authentication, saved-card update, cancel-at-period-end, resume, failed payment, and downgrade using Stripe test cards. Confirm replaying a webhook is accepted as a duplicate and does not duplicate entitlement changes.

For local testing, forward Stripe CLI events to `http://localhost:3000/api/stripe/webhook` and use the CLI-provided signing secret only in the local environment. Patchrail stores Stripe identifiers and a safe payment-method summary, never card data. Consult Stripe's [subscription + Elements guide](https://docs.stripe.com/billing/subscriptions/build-subscriptions?api-integration=paymentintents&payment-ui=elements) before changing the integration.

## Verification modes

### Railway Sandbox (preferred on Railway)

Set:

```text
VERIFICATION_MODE=railway_sandbox
RAILWAY_ENVIRONMENT_ID=<production environment ID>
RAILWAY_TOKEN=<project-scoped token>
```

`RAILWAY_API_TOKEN` is supported as a fallback, but a project-scoped `RAILWAY_TOKEN` has the smaller blast radius. Enable [**Priority Boarding**](https://docs.railway.com/platform/priority-boarding) under Railway account Feature Flags before deployment; Sandboxes and their TypeScript SDK are currently beta. Both a token and environment ID are required.

The worker creates an `ISOLATED` disposable Sandbox for each verification attempt, uploads only the bounded repository archive, patch, commands, and resource limits, and destroys the VM afterward. The sandbox has public NAT egress but cannot access the Railway project's private network. It receives no Patchrail infrastructure secrets.

### External Docker runner

Set the web and worker to:

```text
VERIFICATION_MODE=external_runner
RUNNER_BASE_URL=<APP_URL>
RUNNER_SHARED_SECRET=<random value of at least 32 characters>
```

Run `pnpm runner` as a supervised service on a dedicated, trusted Docker-capable host. The runner only makes outbound HTTPS polling requests, so it needs no inbound public port. Do not deploy it as a normal Railway service or expose/mount a production Docker socket into the web or worker container.

Harden the host in addition to the in-process controls:

- Permit outbound access to Patchrail, DNS, public package registries, and public HTTPS; block loopback, RFC1918/private, link-local, cloud metadata, multicast, and the Railway private network from verifier bridge traffic.
- Keep the Docker daemon local and unauthenticated over the network. Run Patchrail under a dedicated OS account with access only to its temporary directory and Docker.
- Apply a filesystem quota and monitoring. Allow at least 20 GB for pinned images/cache plus 2 GB per concurrent job; alert before exhaustion. Repository archives are capped at 250 MiB and expanded trees at 1 GiB, but Docker layers require additional headroom.
- Keep only the runner shared secret on the host. Treat temporary customer source as confidential, encrypt host storage where available, and verify cleanup after crashes/restarts.

The runner validates archive paths, size and digest, rejects links and credential-bearing paths, applies bounded patches, and uses pinned container image digests. Containers run non-root, read-only, without capabilities or infrastructure secrets, with CPU/RAM/PID/file-size/time limits. Dependency installation gets public network access with lifecycle/build scripts disabled; subsequent verification commands run with `--network none`. Logs are bounded and redacted, the delivered-file digests are rechecked after every command, and workspaces/containers are removed when a job ends.

## Railway production deployment

Create one Railway project/environment with three persistent resources:

1. A managed PostgreSQL service.
2. A `web` service connected to this repository, using the custom Config as Code path `/railway.web.json`.
3. A `worker` service connected to the same revision, using `/railway.worker.json`.

Both code services build the root [`Dockerfile`](./Dockerfile), run as the non-root `patchrail` user, and execute the same idempotent migration pre-deploy command. A PostgreSQL advisory lock serializes concurrent web/worker migrations. The web starts `node server.js`; the worker starts the TypeScript worker and should not receive a public domain.

In Railway:

- Reference the managed PostgreSQL service's `DATABASE_URL` variable from both code services; do not copy a static database password.
- Add the shared application/integration variables to both web and worker unless the Railway variable UI provides an environment-level shared variable. The external runner process receives only its runner-specific subset.
- Generate a Railway domain for `web`, set `APP_URL` to its exact `https://...` origin, update the GitHub/Stripe URLs above, and redeploy.
- Select one verification mode. For `railway_sandbox`, provide the scoped token and environment ID to the processes that validate or execute runs. For `external_runner`, deploy and supervise the separate host before enabling runs.
- Keep the web health check at `/api/health`. After deploy, require `/api/ready` to return `200`, confirm the web configuration booleans are all `true`, and confirm worker logs show `worker_started`. Verify that `worker_heartbeats.heartbeat_at` continues to advance in PostgreSQL.

Railway uses each service's explicitly selected config path; the repository intentionally has two service-specific files rather than a root `railway.json`. See Railway's [custom Config as Code instructions](https://docs.railway.com/config-as-code) and [production checklist](https://docs.railway.com/overview/production-readiness-checklist).

Before opening production to users, enable PostgreSQL backups, define log/availability alerts, test a database restore, test a code rollback, and complete one real test-mode flow from GitHub login through a verified Draft PR. Never treat a successful image build or liveness check as proof of that workflow.

## Database migrations

Schema changes are made in [`src/db/schema.ts`](./src/db/schema.ts) and committed as ordered SQL files under [`drizzle/`](./drizzle/). Generate and review a migration locally:

```powershell
pnpm db:generate
pnpm db:migrate
```

Run the migration twice against a disposable database to verify idempotent deployment behavior, then run the test/build suite. Do not use schema push in production or edit a migration already applied to a shared environment. Roll forward with a new migration; restore from a tested backup if recovery requires reverting data. The Railway pre-deploy step fails the deployment when migration fails.

## Release checklist

- `pnpm install --frozen-lockfile`, formatting, lint, strict typecheck, tests, production build, and Docker build pass from a clean checkout.
- A fresh PostgreSQL database migrates successfully, a second migration run is a no-op, `/api/ready` is healthy, and the worker heartbeat is current.
- GitHub login works for a new and returning user; installation ownership proof, repository refresh/disconnect, exact source SHA, branch creation, and Draft-only PR delivery work against a disposable repository.
- OpenAI discovers an API from repository evidence, cites current authoritative sources, respects call/token/time/cost caps, and records actual provider usage. A forced clarification and a failed-first verification/one-repair path both settle cost correctly.
- Verification cannot reach private/metadata addresses, cannot mutate protected paths or tests undetected, has bounded logs/resources, and leaves no container/workspace behind after success, failure, timeout, or cancellation.
- Stripe test-mode upgrade, payment failure, cancellation/resume, webhook replay, FREE/PRO budget reservation, and exact actual-cost settlement pass.
- Desktop and mobile authenticated pages are checked with real data, keyboard navigation, visible focus, labels, contrast, overflow, and loading/empty/error states.
