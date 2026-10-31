# @hivemagnus/magnus-server

The Magnus server is the control plane of a Magnus fleet. It is a Hono API
server backed by PostgreSQL and Redis that Linux hosts running
[`@hivemagnus/magnus-agent`](../../packages/agent) report to, and that the
[Magnus dashboard](../../apps/dashboard) talks to.

It keeps the fleet inventory and desired state, ingests agent heartbeats,
health snapshots and logs, dispatches signed commands, cron jobs, file syncs
and skill installs through a durable queue, and records every change in an
append-only audit log. Optional modules add anomaly detection and remediation
plans, rollouts, webhooks, an AI fleet assistant, Hermes Agent and Ardent
management, and Security Fusion.

## Requirements

- Node.js `^24.22.1 || ^26.13.0`
- PostgreSQL 15 or later
- Redis 7 or later
- A TLS certificate for production (cleartext HTTP is a loopback-only development opt-in)

## Install

```bash
npm install -g @hivemagnus/magnus-server
magnus-server --help
```

The package ships compiled JavaScript, the generated Prisma client, the Prisma
schema and every migration, so it needs no install-time code generation.

## Configure

All configuration comes from environment variables. Start from the documented
example:

```bash
mkdir -p ~/.magnus && cp "$(npm root -g)/@hivemagnus/magnus-server/.env.example" ~/.magnus/server.env
chmod 600 ~/.magnus/server.env
# fill in DATABASE_URL, REDIS_URL, TLS paths and the required secrets
# (one `openssl rand -hex 32` each; every secret must be different)
```

`magnus-server env-schema --format table` lists every documented variable and
`magnus-server env-schema` prints the same list as JSON.

**Required:** `DATABASE_URL` (in production), `REDIS_URL`, `API_SECRET`,
`JWT_SECRET` (unless Hive IAM is configured), `NODE_MANAGER_SECRET`,
`AUDIT_HMAC_SECRET`, `RESULT_SIGNING_SECRET`, `LOG_INGEST_SIGNING_SECRET`,
`CREDENTIAL_ROTATION_KEY`, `METRICS_TOKEN`, `WEBHOOK_ENCRYPTION_KEY`, and in
production `TLS_CERT_PATH` / `TLS_KEY_PATH`. The server refuses to start while
any is missing; there are no fallback secret values.

Local data (audit logs, credential rotation state, uploaded backups) lives
under `MAGNUS_HOME`, default `~/.magnus`.

## Run

```bash
magnus-server check   --env-file ~/.magnus/server.env   # validate env, reach PostgreSQL and Redis, list integrations
magnus-server migrate --env-file ~/.magnus/server.env   # apply migrations and base data
magnus-server start   --env-file ~/.magnus/server.env   # or: start --migrate
```

| Command | Purpose |
| --- | --- |
| `start` (default) | Start the API server. `--migrate` applies pending migrations first. |
| `check` | Validate configuration, connect to PostgreSQL and Redis, report pending migrations and enabled integrations. Exits non-zero on a problem. |
| `migrate` | Run `prisma migrate deploy` with the packaged schema and migrations, then create the base rows (system actor, sentinel nodes, starter library). Idempotent. |
| `env-schema` | Print the documented environment variables (`--format json` or `table`). |
| `version`, `help` | Print the version or usage. |

`--env-file <path>` may be repeated. Variables already set in the process
environment take precedence, and empty values count as unset.

The API is served under `/api/v1`, interactive documentation at `/api/docs`
(OpenAPI 3.1 JSON at `/api/docs/openapi.json`), and Prometheus metrics at
`/metrics` (bearer `METRICS_TOKEN`).

### Docker Compose

[`docker/compose.yml`](docker/compose.yml) runs magnus-server with PostgreSQL
and Redis. The image is built from the monorepo root with
[`Dockerfile`](Dockerfile): it builds and `npm pack`s the server and its
workspace dependencies, then installs those tarballs exactly as an npm user
would.

```bash
cp services/control-api/.env.example services/control-api/docker/.env   # set POSTGRES_PASSWORD, REDIS_PASSWORD and the secrets
docker compose -f services/control-api/docker/compose.yml --env-file services/control-api/docker/.env up -d --build
```

Compose refuses to start while a required secret is missing. The server
listens on `https://127.0.0.1:4000`; without a mounted certificate it
generates a self-signed one for `MAGNUS_TLS_HOSTNAMES` (default `localhost`)
in its data volume, which is meant for evaluation only. To use a real
certificate, mount it and set `TLS_CERT_PATH` and `TLS_KEY_PATH`.
`bash services/control-api/scripts/check-compose.sh` brings the stack up with
throwaway secrets, checks it end to end and removes it again.

## Optional integrations

Every integration is off until it is configured; the server starts and runs
without any of them. `magnus-server check` prints which are on.

| Integration | What it adds | Environment |
| --- | --- | --- |
| Hive IAM | RS256 access tokens issued by Hive IAM replace locally issued JWTs | `IAM_CORE_URL`, `IAM_TOKEN_ISSUER`, `IAM_TOKEN_AUDIENCE` |
| Hive Router | OpenAI-compatible model routing for managed Hermes Agents | `MAGNUS_ROUTER_URL` (alias `HIVE_ROUTER_URL`), `MAGNUS_ROUTER_MODEL`, `MAGNUS_ROUTER_API_KEY`, `HIVE_ROUTER_HEALTH_URL` |
| HiveMem | Shared agent memory for Hermes Agents and operational lessons | `HIVEMEM_URL`, `HIVEMEM_TOKEN`, `MAGNUS_LESSONS_HIVEMEM_URL`, `MAGNUS_LESSONS_HIVEMEM_TOKEN` |
| Security Fusion (local) | Security cases, evidence and signed receipts in this server | `SECURITY_FUSION_MODE=local`, `SECURITY_FUSION_RECEIPT_SIGNING_KEY`, optional `SECURITY_FUSION_EVIDENCE_DIR`, `SECURITY_FUSION_CONTAINMENT_COMMAND`, `SECURITY_FUSION_MATTERMOST_*` |
| External security console | Exports observations to an external console; local Security Fusion routes answer 410 with the console URL | `SECURITY_FUSION_MODE=remote`, `MAGNUS_SECURITY_CONSOLE_URL`, `SECURITY_FUSION_API_URL`, `SECURITY_EXPORT_ENABLED`, `SECURITY_EXPORT_SECRET`, `SECURITY_SUMMARY_TOKEN`, `SECURITY_INVENTORY_TOKEN_SHA256`, `SECURITY_BACKUP_TOKEN_SHA256` |
| Hermes Agent plugin API | Endpoint-scoped plugin credentials (read, operator) and the signed approval bridge | `MAGNUS_PLUGIN_API_ENABLED=true`, `MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON`, `MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256`, optional `MAGNUS_APPROVAL_BRIDGE_CONSUMER`, `APPROVAL_SIGNER_PUBLIC_KEY_*`, `APPROVAL_*_ACTOR_SHA256` |
| Hermes registry sync | Imports the bundled skill catalogue and tracks plugin sources; staged deployments to named hosts | `MAGNUS_HERMES_REGISTRY_ENABLED=true`, `MAGNUS_REGISTRY_DEPLOY_HOSTS`, `MAGNUS_REGISTRY_SUBMIT_ONLY_HOSTS` |
| Observability collector | Read-only credential for an external collector | `MAGNUS_COLLECTOR_TOKEN_SHA256` |
| AI fleet assistant | Ollama, llama.cpp, OpenAI, OpenRouter or Anthropic model profiles | `OLLAMA_URL`, `LLAMACPP_URL`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` |
| Agent discovery | Agents self-register | `ENABLE_AGENT_DISCOVERY=true`, `AGENT_DISCOVERY_SECRET` |
| Resource leases | Durable node and shared-resource lease coordination | `MAGNUS_RESOURCE_LEASES_ENABLED=true` |

Credentials for services that call Magnus are stored only as SHA-256 digests.

## Develop

From the repository root:

```bash
npm ci
npm --workspace @hivemagnus/magnus-contracts run build
npm --workspace @hivemagnus/magnus-skills run build
npm --workspace @hivemagnus/magnus-server run db:generate
npm --workspace @hivemagnus/magnus-server run typecheck
npm --workspace @hivemagnus/magnus-server test            # unit tests
npm --workspace @hivemagnus/magnus-server run build
```

`npm run dev` (in this directory) runs the server with `tsx watch`. Without
`DATABASE_URL`, development connects to `postgresql://magnus@127.0.0.1:5432/magnus`
(role `magnus`, no password); production always requires `DATABASE_URL`. Set
`ALLOW_INSECURE_HTTP=true` to serve cleartext HTTP on loopback while
developing.

Integration tests need a disposable PostgreSQL database whose name starts with
`magnus_ideas_` and a Redis server:

```bash
export TEST_DATABASE_URL=postgresql://magnus:<password>@127.0.0.1:5432/magnus_ideas_test
export DATABASE_URL=$TEST_DATABASE_URL REDIS_URL=redis://127.0.0.1:6379
npm --workspace @hivemagnus/magnus-server run db:migrate:deploy
npm --workspace @hivemagnus/magnus-server run test:integration
```

Schema changes go in a new Prisma migration (`npm run db:migrate`); applied
migrations are never edited.

## License

Apache-2.0. See [LICENSE](LICENSE).
