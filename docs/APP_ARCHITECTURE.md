# Magnus architecture

Magnus has three runtime parts: a browser console, an API server, and an agent on every managed
Linux host. Ardent is a separate agent runtime that Magnus can manage, and the skills catalogue is
data the server publishes to hosts.

There are two browser UIs. [HiveXUI](https://github.com/ChefTaco/HiveXUI) is the Hive:Magnus suite's
UI, a separate static application that calls the API directly with Oathweave resource tokens
([route inventory](console-api.md)). `apps/dashboard` remains for standalone installs, and is what
the diagram and the Console section below describe. It will be deprecated once HiveXUI's Magnus
module passes acceptance; published versions stay available.

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
| `apps/dashboard` | `@hivemagnus/magnus-ui`: Next.js 16 web console for standalone installs, default port `3000` |
| `services/control-api` | `@hivemagnus/magnus-server`: Hono API server, default port `4000` |
| `services/fleet-gateway` | `@hivemagnus/magnus-fleet-gateway`: holds the restricted SSH key and carries the browser web terminal, default port `4310` |
| `packages/oathweave` | `@hivemagnus/magnus-oathweave`: Oathweave token verifier and identity links shared by the server and fleet gateway |
| `packages/agent` | `@hivemagnus/magnus-agent`: node agent on each managed host, default port `4100` |
| `packages/contracts` | `@hivemagnus/magnus-contracts`: Zod schemas shared by the server, the console and the agent |
| `packages/skills` | `@hivemagnus/magnus-skills`: Ubuntu operations skills in the Hermes Agent skill format |
| `packages/magnus` | `@hivemagnus/magnus`: installer and upgrade tool for managed server and console projects; see [UPGRADING.md](../UPGRADING.md) |
| `scripts` | Repository checks (secrets, private data, OpenAPI, documentation, package contents) |

## Console

This section describes the standalone console, `apps/dashboard`. It is a same-origin web application. Browser code calls only Next.js route handlers.
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
- Security: `/security-fusion`, a summary of and links into an external security console
  (Cindertrace) when `MAGNUS_SECURITY_CONSOLE_URL` is set; see [Cindertrace migration](CINDERTRACE_MIGRATION.md).
- Embedded services: the Hermes dashboard under `/api/hermes/dashboard` and a router admin UI under
  `/api/hive-router/dashboard`, each only when its integration is configured. Emberpath's current
  source has no admin UI to embed; only a release that still bundles one does. Both run sandboxed in
  an opaque origin, authorized by a short-lived frame grant instead of the console cookie, so their
  script has no console authority ([design note](HERMES_DASHBOARD_HIVEXUI.md)).

### Sign-in

The console always has one local administrator: `DASHBOARD_ADMIN_USERNAME` with an Argon2id
`DASHBOARD_ADMIN_PASSWORD_HASH`. A successful sign-in sets a signed session cookie, and
`src/proxy.ts` requires that cookie on every non-public route. Sign-in attempts are throttled in
Redis by source, by username and by both together, with progressive delays and a global
concurrency limit; past the per-username budget only a wrong password is refused, so anonymous
attempts cannot lock the administrator out. The TLS front end ignores inbound forwarding headers and
takes the client address from the socket, or, for a reverse proxy listed in
`DASHBOARD_TRUSTED_PROXIES`, from the right-most untrusted `X-Forwarded-For` hop, so the throttle
cannot be bypassed with a spoofed header. State-changing API requests must come from the console's own
origin (`Origin` or `Sec-Fetch-Site`); API reads from an opaque origin (`Origin: null`) or another
site are refused too, except navigations and the public endpoints. Every page carries a same-origin
Content Security Policy.

Named users can sign in through an OIDC provider such as Oathweave (formerly Hive IAM) when the
`HIVE_OAUTH_*` variables are set. The provider remains the identity provider; Magnus does not
administer it. The dashboard uses the authorization code flow with S256 PKCE on every sign-in.
Register its client with the provider either as a public client
(no secret; leave `HIVE_OAUTH_CLIENT_SECRET` unset) or as a confidential client, in which case
`HIVE_OAUTH_CLIENT_SECRET` must hold its secret: the provider refuses a confidential client's code
exchange without it (`invalid_client`), and the dashboard logs that reason when it happens.
A named user's API calls carry that user's own access token, not the console's credential, so the
Control API must verify it: since 4.0.0 only Oathweave mode does (`OATHWEAVE_ISSUER` and the other
Oathweave settings, an identity link for each user, and tokens for the audience `magnus`, so
`HIVE_OAUTH_API_AUDIENCE=magnus`). `magnus-ui check` warns about any other audience.

### Terminals and SSH

HiveXUI's terminal goes through the separate
[fleet gateway](../services/fleet-gateway/README.md), so neither the browser nor the API process
holds the SSH key. It requires an `ADMIN` account link, `magnus:terminal` and recent identity
verification, pins host keys that an operator approved explicitly, and audits metadata only.

The standalone dashboard's own node terminal, deprecated with that console, opens an SSH session to
a managed host with a dedicated, unprivileged SSH identity (`DASHBOARD_SSH_*`) over HTTP streaming.
It validates the console session first, and terminal metadata is audited without recording what was
typed. Host keys are pinned on first use (`src/lib/terminal-host-key.ts`). In the default `enforce`
mode an unreadable or unsafe pin store, a lock failure, or a key mismatch rejects the connection.

The Hermes dashboard proxy does not trust on first use. It uses a reviewed inventory
(`HERMES_SSH_AUTHORIZATIONS_FILE`) that binds each Hermes installation and node to exact
addresses and expected SHA-256 host keys, with an optional bounded overlap for key rotation.

## Server

The server owns the fleet state. It keeps the inventory, desired state and audit log in
PostgreSQL (through Prisma) and uses Redis for queues (BullMQ), heartbeat streams and rate
limits. Its domains, all under `/api/v1`:

- nodes, heartbeats, health, drift, topology and dependencies;
- commands, quick commands, cron, files, logs, skills, roles and the script library;
- rollouts and agent upgrades (the browser-driven deployment routes are retired and answer 410);
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
- security observation export and the optional response adapter for Cindertrace
  (`/api/v1/security-integration`). The embedded Security Fusion is retired: with
  `SECURITY_FUSION_MODE=remote`, `/api/v1/security-fusion/*` answers `410 SECURITY_FUSION_MOVED`.

The OpenAPI 3.1 document is the route-level reference. The server serves it, with interactive
documentation, at `https://<server>:4000/api/docs`.

Every command sent to an agent is signed, carries a deadline, and has a durable receipt on the
node; see [command receipts and recovery](COMMAND_RECEIPTS.md). Results are signed with the node's
own key, and the server signs its requests and decisions with its key. `NODE_AUTH_MODE` defaults
to `enforce`; the shared `NODE_MANAGER_SECRET` and `RESULT_SIGNING_SECRET` matter only under an
explicit, deprecated `compat` or `warn` ([per-node credentials](NODE_CREDENTIALS.md)).

Prometheus metrics are served at `/metrics` behind `METRICS_TOKEN`. Request logs, error responses
and SSH execution logs redact values that look like secrets. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to
export traces over OTLP HTTP. See [observability](OBSERVABILITY.md).

Authentication uses local users with server-issued JWTs. When the Oathweave settings are present,
Oathweave resource tokens are accepted as well. The external IAM mode (`IAM_CORE_URL`) was removed
in 4.0.0, and the server refuses to start while `IAM_CORE_URL` is set.
Services that call the server (a collector, a Hermes plugin, an approval
bridge) get their own scoped credentials, which the server stores only as SHA-256 digests.

## Agent

The agent runs on each managed host and:

- sends a heartbeat to `POST /api/v1/heartbeat` every 30 seconds, with CPU, memory, disk, network,
  services, GPU and security posture;
- serves management routes under `/api/v1/*`, which, once the node has a key, accept only requests
  signed with the server key the agent pinned (the shared `x-node-token` only under an explicit, deprecated `compat` or
  `warn`);
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
API. Ardent is developed in its own repository; see the [Ardent README](https://github.com/ChefTaco/Ardent#readme).
Magnus pins the published `@hivemagnus/ardent` package as a development dependency for the agent's
context-adoption bundle and the generated Ardent client in `@hivemagnus/magnus-contracts`.

## Integrations

Oathweave, Emberpath, HiveMem, an external security console, Hermes Agent and Codex are all
optional. Each one is off until its environment variables are set, and nothing falls back to a
built-in host. See the integration tables in the [root README](../README.md#optional-integrations)
and in each package README.

Further reading:

- [Hermes Agent management](APP_ARCHITECTURE_HERMES.md)
- [Hermes registry](HERMES_REGISTRY.md)
- [Codex CLI management](APP_ARCHITECTURE_CODEX.md)
