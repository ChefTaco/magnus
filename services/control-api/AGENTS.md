# AGENTS.md - magnus-server

Read the repository root `AGENTS.md` first. Its privacy and secret rules apply here too.

## What this is

`services/control-api` (`@hivemagnus/magnus-server`, bin `magnus-server`) is the
fleet control plane. It stores inventory and desired state in PostgreSQL,
queues work in Redis (BullMQ), ingests heartbeats, health and logs from
`magnus-agent`, dispatches signed commands, cron, file and skill changes, and
keeps an append-only audit log. The dashboard is its main client.

## Stack

| Area | Choice |
| --- | --- |
| Framework | Hono v4 on `@hono/node-server` |
| Runtime | Node.js `^24.22.1 \|\| ^26.13.0`, ESM |
| Language | TypeScript strict mode, NodeNext imports with `.js` extensions |
| ORM | Prisma 7 on PostgreSQL with the `pg` adapter; client generated into `src/db/generated` and compiled into `dist` |
| Queue | BullMQ on Redis |
| Validation | Zod 4 schemas and `parseBody()` helpers |
| Auth | Purpose-specific API and node credentials; local HS256 user JWTs or Hive IAM RS256 tokens |

## Commands

```bash
npm run db:generate        # after every schema change, and before typecheck/build on a fresh clone
npm run typecheck
npm test                   # unit tests
npm run test:integration   # needs TEST_DATABASE_URL (database name magnus_ideas_*) and Redis
npm run build              # dist/, including dist/cli.js
npm run dev                # tsx watch
node dist/cli.js check     # validate env and reach PostgreSQL/Redis
npm run db:migrate         # create a new migration while developing
```

The workspace packages `@hivemagnus/magnus-contracts` and
`@hivemagnus/magnus-skills` must be built first (`npm run build` in each).

## Project map

```text
src/
  cli.ts                magnus-server CLI (start, check, migrate, env-schema)
  cli/                  argument parsing, documented env catalogue, preflight checks
  index.ts              listener, background services, graceful shutdown
  server.ts             Hono app and route mounting
  config/               env schema (Zod), feature flags, CORS, listener security, versions
  db/                   Prisma client, base-data seed, migration tests
  middleware/           auth and RBAC, request logging, rate limits, errors
  openapi/              OpenAPI 3.1 spec served at /api/docs
  queue/                Redis and BullMQ workers
  routes/               one Hono router per API domain
  security/             wire contracts shared byte-for-byte with magnus-agent
  services/             domain logic
  sdk/                  typed client for the agent's management API
  utils/                env secrets, MAGNUS_HOME paths, redaction, helpers
prisma/                 schema.prisma and migrations (never edit applied ones)
docker/                 compose.yml and the container entry point
scripts/                build helpers, the Compose check, legacy data migrations
```

## Optional integrations

Hive IAM, Hive Router, HiveMem, Security Fusion (local or an external security
console), the Hermes Agent plugin API, the Hermes registry sync and the AI
assistant providers are optional. Each is off until its environment variables
are set (`src/config/features.ts`), and the server must start and work without
any of them. Never hard-code their URLs, hosts or tokens; add new settings to
`src/config/env.ts`, `src/cli/env-catalog.ts`, `.env.example` and the README
integrations table together.

## Rules

- Never return node tokens, SSH credentials, environment maps, passwords, API
  keys, private keys or raw request bodies. Redact request, error and log metadata.
- Compare secrets with the constant-time helpers. Store only SHA-256 digests of
  credentials that other services present.
- Required secrets fail fast at startup; never add a fallback secret value or a
  shared master secret (`MAGNUS_SECRET` is rejected in production).
- Every route mutation audits the actor, target and outcome; sanitize details
  before `logAuditEvent()`.
- `src/security/native-completion-registry.ts` and the command completion
  registry must stay byte-identical with `packages/agent`; the cross-package
  tests pin their digests.
- An agent with `MAGNUS_AGENT_PRIVILEGED=false` answers root-only routes with
  403 `AGENT_NOT_PRIVILEGED`; the SDK maps that to a non-retryable "feature
  disabled on this node" error (`isAgentNotPrivileged`). Do not retry it.
- Schema changes need a new migration. Applied migrations are immutable;
  removed features may leave unused tables mapped in `schema.prisma`.
- Tests use fake data only: `example.com` hosts, RFC 5737 or RFC 1918
  addresses, `/home/operator` paths, obviously fake tokens.
- Update `src/openapi/spec.ts` when routes change and run
  `node scripts/check-openapi-contract.mjs` from the repository root after building.
