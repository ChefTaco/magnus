# Magnus architecture

Magnus has three runtime parts: a web console, an API server, and an agent on every managed Linux
host. Ardent is a separate agent runtime that Magnus can manage, and the skills catalogue is data
the server publishes to hosts.

```text
 Operator (browser)
        │ HTTPS, same origin only
        ▼
 ┌──────────────────┐   server-side, API_SECRET    ┌──────────────────────┐
 │    Magnus UI     │ ───────────────────────────▶ │    Magnus server     │──── PostgreSQL
 │ (apps/dashboard) │                              │ (services/control-api)│──── Redis
 └──────────────────┘                              └──────────────────────┘
        │ SSH (terminal, Hermes dashboard)            ▲ heartbeats │ signed commands
        ▼                                             │            ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ Managed Linux host: magnus-agent (packages/agent)                    │
 │   optional: Hermes Agent, Codex CLI, Ardent profiles, skills         │
 └──────────────────────────────────────────────────────────────────────┘
```

## Packages

| Path | Role |
| --- | --- |
| `apps/dashboard` | `@hivemagnus/magnus-ui`: Next.js 16 web console, default port `3000` |
| `services/control-api` | `@hivemagnus/magnus-server`: Hono API server, default port `4000` |
| `packages/agent` | `@hivemagnus/magnus-agent`: node agent on each managed host, default port `4100` |
| `packages/ardent` | `@hivemagnus/ardent`: headless agent runtime, management API on `127.0.0.1:9910` by default |
| `packages/contracts` | `@hivemagnus/magnus-contracts`: Zod schemas shared by the server, the console and the agent |
| `packages/skills` | `@hivemagnus/magnus-skills`: Ubuntu operations skills in the Hermes Agent skill format |
| `packages/magnus` | `@hivemagnus/magnus`: installer and upgrade tool for managed server and console projects; see [UPGRADING.md](../UPGRADING.md) |
| `scripts` | Repository checks (secrets, private data, OpenAPI, documentation, package contents) |

## Console

The console is a same-origin web application. Browser code calls only Next.js route handlers.
Those handlers run on the server, add credentials such as `API_SECRET`, and forward the request
to the API server (`/api/proxy/<path>`) or to an agent. No API, node or SSH credential is ever sent to
the browser.

The proxy can target more than one control node. An absent or blank selector means the server
configured in `CONTROL_API_URL`; any other target must be in the configured control-node list,
which prevents the proxy from being used to reach arbitrary hosts.

Main areas:

- Fleet: `/`, `/mission-control`, `/nodes`, `/fleet-map`, `/commands`, `/anomalies`,
  `/anomalies/remediation`, `/cron`, `/files`, `/library`, `/skills`, `/roles`, `/logs`,
  `/audit`, `/webhooks`, `/notifications`, `/api-docs`.
- Operations: `/fleet-readiness`, `/fleet-timeline`, `/retention`, `/rollouts`, `/incidents`,
  `/application-operations`.
- Agents: `/ardent` and `/ardent/profiles` for Ardent, `/codex` and `/codex/installations` for
  the Codex CLI, and, when Hermes Agent is enabled, `/orchestra`, `/orchestra/installations`,
  `/orchestra/profiles`, `/orchestra/web-gateway`, `/hermes-drift` and `/hermes-security`.
- Security: `/security-fusion` when Security Fusion runs locally in the server.
- Embedded services: the Hermes dashboard under `/api/hermes/dashboard` and the Hive Router admin
  UI under `/api/hive-router/dashboard`, each only when its integration is configured.

### Sign-in

The console always has one local administrator: `DASHBOARD_ADMIN_USERNAME` with an Argon2id
`DASHBOARD_ADMIN_PASSWORD_HASH`. A successful sign-in sets a signed session cookie, and
`src/proxy.ts` requires that cookie on every non-public route. Sign-in attempts are throttled in
Redis by source, by username and by both together, with progressive delays and a global
concurrency limit. The TLS front end ignores inbound forwarding headers and takes the client
address from the socket, so the throttle cannot be bypassed with a spoofed header.

Named users can sign in through Hive IAM (OIDC) when the `HIVE_OAUTH_*` variables are set. Hive IAM
remains the identity provider; Magnus does not administer it.

### Terminals and SSH

The node terminal opens an SSH session to a managed host with a dedicated, unprivileged SSH
identity (`DASHBOARD_SSH_*`). Both terminal transports (WebSocket and HTTP streaming) validate the
console session first, and terminal metadata is audited without recording what was typed. Host
keys are pinned on first use (`src/lib/terminal-host-key.ts`). In the default `enforce` mode an
unreadable or unsafe pin store, a lock failure, or a key mismatch rejects the connection.

The Hermes dashboard proxy does not trust on first use. It uses a reviewed inventory
(`HERMES_SSH_AUTHORIZATIONS_FILE`) that binds each Hermes installation and node to exact
addresses and expected SHA-256 host keys, with an optional bounded overlap for key rotation.

## Server

The server owns the fleet state. It keeps the inventory, desired state and audit log in
PostgreSQL (through Prisma) and uses Redis for queues (BullMQ), heartbeat streams and rate
limits. Its domains, all under `/api/v1`:

- nodes, heartbeats, health, drift, topology and dependencies;
- commands, quick commands, cron, files, logs, skills, roles and the script library;
- rollouts, deployments and agent self-update;
- anomalies, predictions, remediation plans and fleet checks;
- notifications, alerts and webhooks;
- users, authentication, credentials and the append-only audit log;
- Hermes Agent desired state (`/api/v1/hermes`, also mounted as `/api/v1/orchestra`) and the
  Hermes registry (`/api/v1/hermes-registry`);
- Codex CLI posture (`/api/v1/codex`) and Ardent management (`/api/v1/ardent`);
- read-only operations summaries (`/api/v1/ops/*`): dependency health, readiness, timeline,
  retention, trace map, incidents, package security posture, application probes;
- an AI fleet assistant and a small read-only tool interface for agents (`/api/v1/mcp`);
- resource leases ([command resource leases](COMMAND_RESOURCE_LEASES.md));
- Security Fusion (`/api/v1/security-fusion`) when `SECURITY_FUSION_MODE` is `local`.

The OpenAPI 3.1 document is the route-level reference. The server serves it, with interactive
documentation, at `https://<server>:4000/api/docs`.

Every command sent to an agent is signed, carries a deadline, and has a durable receipt on the
node; see [command receipts and recovery](COMMAND_RECEIPTS.md). Results are signed with
`RESULT_SIGNING_SECRET`, which is separate from the node credential.

Prometheus metrics are served at `/metrics` behind `METRICS_TOKEN`. Request logs, error responses
and SSH execution logs redact values that look like secrets. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to
export traces over OTLP HTTP. See [observability](OBSERVABILITY.md).

Authentication uses local users with server-issued JWTs by default. When `IAM_CORE_URL`,
`IAM_TOKEN_ISSUER` and `IAM_TOKEN_AUDIENCE` are set, RS256 access tokens issued by Hive IAM are
accepted instead. Services that call the server (a collector, a Hermes plugin, an approval
bridge) get their own scoped credentials, which the server stores only as SHA-256 digests.

## Agent

The agent runs on each managed host and:

- sends a heartbeat to `POST /api/v1/heartbeat` every 30 seconds, with CPU, memory, disk, network,
  services, GPU and security posture;
- serves management routes under `/api/v1/*`, authenticated with the node credential
  (`x-node-token`);
- runs commands, cron changes, file operations and skill installs, and keeps a durable,
  signed receipt for each command;
- manages Hermes Agent through the local `hermes` CLI, the Codex CLI through its App Server, and
  Ardent profiles, each only when installed;
- serves an unauthenticated, deliberately minimal readiness probe at `/api/v1/ping` and detailed
  health at the authenticated `/api/v1/health/check`.

By default the agent runs as root (`MAGNUS_AGENT_PRIVILEGED=true`). In unprivileged mode it runs
as an ordinary account and the features that need root answer `403 AGENT_NOT_PRIVILEGED`. The
[agent README](../packages/agent/README.md) lists them.

## Ardent

Ardent is an independent agent runtime. One process serves one profile (config, persona, skills
and SQLite state). It can run on its own, but when `ARDENT_OWNER_USER` is set on a host's agent,
Magnus inventories its profiles and the console shows them under `/ardent`. With
`integrations.magnus_control` enabled, an Ardent profile also gets read-only tools for the Magnus
API. See the [Ardent README](../packages/ardent/README.md).

## Integrations

Hive IAM, Hive Router, HiveMem, an external security console, Hermes Agent and Codex are all
optional. Each one is off until its environment variables are set, and nothing falls back to a
built-in host. See the integration tables in the [root README](../README.md#optional-integrations)
and in each package README.

Further reading:

- [Hermes Agent management](APP_ARCHITECTURE_HERMES.md)
- [Hermes registry](HERMES_REGISTRY.md)
- [Codex CLI management](APP_ARCHITECTURE_CODEX.md)
