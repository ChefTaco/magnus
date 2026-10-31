# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-10-31

### Security

- Enforce dashboard proxy body limits while streaming, including requests with
  missing or understated `Content-Length` headers.
- Require explicit SSH host-key pins for Control API SSH helpers. Remove the
  unused deployment and migration implementations behind the retired API,
  including their unsafe shell interpolation and broad source-bundle transfer.
- Update vulnerable production and development dependencies; retain the
  compatible OpenAPI generator dependency with its documented development-only
  advisory pending an upstream fix.
- Scan staged Git content and npm payload contents for credentials and private
  infrastructure. Redact scanner findings, reject local-state files, and clean
  compiled outputs before building packages so deleted code cannot be shipped.
- Run the full repository verification before npm publication.
- Refuse real npm publication when the GitHub environment has no required
  reviewer, and pin workflow actions to immutable release commits.
- Require a matching release tag for real publication, including manual runs.
  Stop on registry errors before publishing any packages, validate internal
  dependency versions, and inspect every package during dry runs.

### Fixed

- Align the server's bundled agent version metadata with the package release.
- Support first publication with an explicitly selected, reviewed bootstrap
  run. Its temporary npm credential is available only to the final publish
  step; subsequent releases use trusted publishing.

## [1.0.0] - 2026-10-31

The initial release snapshot.

### Added

- **Magnus UI** (`@hivemagnus/magnus-ui`): the web console for fleets and nodes, commands, cron
  jobs, files, logs, skills, roles, rollouts, anomalies and remediation, incidents, retention,
  webhooks, notifications and audit, plus Ardent and Codex CLI views. It ships as a prebuilt
  Next.js standalone server with the `magnus-ui` CLI (`start`, `check`, `env-schema`,
  `--env-file`) and an example systemd unit. Browser code uses same-origin routes only; API, node
  and SSH credentials stay on the server. Sign-in uses a local Argon2id administrator with
  Redis-backed throttling, and optionally named Hive IAM (OIDC) users. Node terminals use pinned
  SSH host keys.
- **Magnus server** (`@hivemagnus/magnus-server`): the Hono API server on PostgreSQL and Redis. It
  keeps the inventory and desired state, ingests heartbeats, health snapshots and logs, and
  dispatches signed commands, cron jobs, file syncs and skill installs through a durable queue. It
  records every change in an append-only audit log, and adds anomaly detection, remediation plans,
  rollouts, webhooks, an AI fleet assistant, read-only operations summaries, application probes,
  Hermes Agent and Ardent management, the Hermes registry, resource leases and Security Fusion. The
  `magnus-server` CLI has `start`, `check`, `migrate` and `env-schema`, and the package includes
  the Prisma schema and every migration. A Dockerfile and a Docker Compose example with
  PostgreSQL 17 and Redis 7 are in `services/control-api`. The OpenAPI 3.1 document is served at
  `/api/docs`, and Prometheus metrics at `/metrics`.
- **Magnus agent** (`@hivemagnus/magnus-agent`): the node agent for Linux hosts. It handles
  heartbeats with CPU, memory, disk, network, service, GPU and security posture, and runs
  commands with durable signed receipts. It also handles cron and managed schedules, file access
  with symlink-resolved path checks, skill publication, and drift and profiling routes. It can
  manage Hermes Agent, the Codex CLI and Ardent when they are installed. It offers optional
  OpenTelemetry export, journald forwarding, HiveMem credential renewal and authenticated UDP
  discovery. The `magnus-agent` CLI has `start`, `check` and `env-schema`, and the package
  includes example systemd units for privileged and unprivileged mode and for Hermes registry
  sync.
- **Ardent** (`@hivemagnus/ardent`): a headless TypeScript agent runtime. One process serves one
  profile with a YAML config, persona, skills and private SQLite state, and runs model turns
  against an OpenAI-compatible server or the Codex App Server. It provides durable tasks with an
  event journal, a bearer-protected management API with a pinned OpenAPI document, A2A 1.0 over
  JSON-RPC, HTTP+JSON and gRPC, and scheduled jobs with exactly-once window receipts. It also
  provides context compaction and plugins. Optional integrations are news research, HiveMem
  memory, Telegram and Mattermost channels, read-only Magnus tools and Hermes Agent team-card
  compatibility. The `ardent` CLI includes `init`, `doctor`, `chat`, `run`, `gateway run`, `config`,
  `jobs` and `a2a`.
- **Magnus contracts** (`@hivemagnus/magnus-contracts`): Zod schemas and types shared by the
  server, the console and the agent, and a typed Ardent HTTP client.
- **Magnus skills** (`@hivemagnus/magnus-skills`): a catalogue of Ubuntu operations skills in the
  Hermes Agent skill format, with `listManifests()` and `getSkillsDir()`.
- Node.js 24 (`>=24.22.1`) and Node.js 26 (`>=26.13.0`) are supported.

### Notes

- Every integration is off until it is configured: Hive IAM, Hive Router, HiveMem, an external
  security console, Hermes Agent, Codex and the Ardent chat channels.
- Security Fusion is off by default (`SECURITY_FUSION_MODE=off`). In `remote` mode the export of
  observations to an external security console stays off until `SECURITY_EXPORT_ENABLED=true`.
- The console's Hermes Agent pages, the Hermes dashboard proxy and its WebSocket bridge need
  `MAGNUS_HERMES_ENABLED=true`.
- The agent runs in privileged mode by default (`MAGNUS_AGENT_PRIVILEGED=true`) and then must run
  as root. Set it to `false` to run as an ordinary account; features that need root then answer
  `403 AGENT_NOT_PRIVILEGED`.
- npm 12 blocks dependency install scripts by default. These dependencies have install scripts:
  - `@hivemagnus/magnus-server`: `argon2`, `prisma` and `@prisma/engines` (which downloads the
    schema engine that `magnus-server migrate` uses), plus the optional native accelerators
    `ssh2`, `cpu-features` and `msgpackr-extract`;
  - `@hivemagnus/magnus-ui`: `argon2`, plus the optional `ssh2` and `cpu-features`;
  - `@hivemagnus/ardent`: `better-sqlite3`;
  - `@hivemagnus/magnus-agent`, `@hivemagnus/magnus-contracts` and `@hivemagnus/magnus-skills`:
    none.

  Pass them to `npm install -g` with `--allow-scripts=...`, or list them under `allowScripts` in
  your project's `package.json`.

[1.0.1]: https://github.com/ChefTaco/magnus/releases/tag/v1.0.1
[1.0.0]: https://github.com/ChefTaco/magnus/releases/tag/v1.0.0
