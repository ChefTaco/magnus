# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/).

## [1.1.1] - 2026-11-01

### Fixed

- Agent self-upgrade when the agent runs as root inside an install directory another account owns
  (for example one a deploy user installs releases into). The new `versions/<X>` tree, `./current`,
  the upgrade state and the npm cache now get that directory's owner, so the owner can still replace
  or remove them.
- Managed cron lines no longer name `versions/<X>`. Under the launcher they go through the install
  directory, so they survive later self-upgrades and pruning. `magnus-agent install-service` leaves
  `node_modules` as a link to `current/node_modules`, so lines written before the versioned layout
  keep their exact text.
- `hermes-sync` recognises that it runs as a service when it is started through a linked path.

### New environment variables

- None.

### Migration impact

- None: 1.1.1 adds no database migrations.

## [1.1.0] - 2026-11-01

### Added

- `@hivemagnus/magnus`, a new installer and upgrade tool. `npx @hivemagnus/magnus init` creates a
  managed single-node project (server and console, systemd units, generated secrets and TLS, and
  optionally PostgreSQL and Redis through docker compose). It pins exact, tested versions of every
  component. See [UPGRADING.md](UPGRADING.md).
- `magnus upgrade [--to X.Y.Z] [--dry-run]` (or `magnus-server upgrade`) checks the registry and the
  Node.js engines and dumps PostgreSQL before migrating. It installs the new release beside the running
  one, migrates, checks, switches `./current` and restarts. If the new version does not become healthy
  it switches back automatically and prints the exact database restore command. It never crosses a
  major version without `--allow-major`. `magnus rollback [--restore-db]` and `magnus status` complete
  it, and `magnus adopt` turns an existing npm install into a managed project.
- Startup auto-migrate (`MAGNUS_AUTO_MIGRATE=true`): pending migrations are applied before the server
  listens, under a PostgreSQL advisory lock and after a `pg_dump`. Slow or one-way migrations stop
  startup unless they are explicitly allowed.
- Update notices: a daily, opt-out registry check shows newer releases with their notes, new required
  settings and slow or one-way migrations in the console and in `magnus-server check`. Agents that run
  a different version than the server log a loud warning with the exact fix command.
- Server-driven agent upgrades: the **Upgrade agents** action on the Nodes page and
  `magnus-server agents upgrade`. One canary goes first, then a few agents at a time. Each agent
  installs the exact version and npm integrity into `versions/<X>` beside the running one and switches
  back by itself if the new version does not report an accepted heartbeat within
  `MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS`. Agents that cannot upgrade themselves are greyed out with
  the reason. Run `sudo magnus-agent install-service` once per node to enable it; the agent never uses
  sudo for upgrades.
- New server commands `magnus-server migrations` and `magnus-server backup`, and
  `magnus-server check --format json`.
- Per-release manifests (`magnusRelease`) with migration impact notes
  (`prisma/migrations/<name>/magnus-impact.json`), checked by `npm run release:manifest:check`.

### Changed

- The git-checkout self-update endpoints (`/api/v1/self-update/check`, `/apply` and `/restart`) are
  off by default and answer 410 with the upgrade command. Set `MAGNUS_LEGACY_GIT_SELF_UPDATE=true` to
  keep using them from a source checkout.
- The heartbeat's `updateAvailable` compares versions by semver, and agents now report their Node.js
  version and self-upgrade status.
- The native completion registry adds the agent self-upgrade mutation, so its digest changes. A
  managed mutation admitted by a 1.0.x server and settled by 1.1.0 is refused with
  `RESOURCE_EVIDENCE_INVALID`, so upgrade the server while no managed mutation is running.
- The console shows its own release version in the sidebar.

### New environment variables

All are optional, and each automatic behaviour has its own switch.

- Server: `MAGNUS_AUTO_MIGRATE`, `MAGNUS_AUTO_MIGRATE_BACKUP`, `MAGNUS_AUTO_MIGRATE_ALLOW_SLOW`,
  `MAGNUS_BACKUP_DIR`, `MAGNUS_PG_DUMP`, `MAGNUS_RUNTIME_FILE`, `MAGNUS_UPDATE_CHECK`,
  `MAGNUS_UPDATE_REGISTRY`, `MAGNUS_AGENT_UPGRADES`, `MAGNUS_AGENT_UPGRADE_CONCURRENCY`,
  `MAGNUS_LEGACY_GIT_SELF_UPDATE`, `MAGNUS_PROJECT_DIR`.
- Agent: `MAGNUS_AGENT_SELF_UPGRADE`, `MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS`,
  `MAGNUS_AGENT_UPGRADE_REQUIRE_PROVENANCE`, `MAGNUS_AGENT_UPGRADE_SOURCE_DIR`, `MAGNUS_AGENT_NPM`.

### Migration impact

- None: 1.1.0 adds no database migrations.

## [1.0.3] - 2026-10-31

### Added

- Configuration switches for interoperating with older components. Every default keeps the
  current behaviour.
  - `MAGNUS_AGENT_ARDENT_PACKAGES` (agent, default `@hivemagnus/ardent`): scoped npm names
    accepted as the Ardent runtime for the staged sidecar, install path, receipt and managed
    unit. Ardent state now also reports the installed `packageName`.
  - `MAGNUS_APPROVAL_ASSERTION_DOMAINS` (server, default `magnus.approval-assertion`): signature
    domain prefixes accepted for signed approval decisions, so older signers keep working.
  - `MAGNUS_ROUTE_ALIASES_JSON` (server, unset): legacy `/api/v1` path prefixes rewritten to
    current routes before routing, for example the renamed resource-lease admission and
    transfer authority snapshot routes.
  - `MAGNUS_WEBHOOK_TYPE_ALIASES` (server, unset): legacy webhook type names mapped to a
    current delivery format.

## [1.0.2] - 2026-10-31

### Changed

- Update runtime dependencies, including ky 2, dotenv 18, Prisma 7.10, argon2 0.45, Hono
  4.13.14, Express 5.3, the A2A SDK 1.3 and Next.js 16.4.3. When installing a server
  package with npm 12, allow the install scripts of `argon2@0.45.1`, `prisma@7.10.1` and
  `@prisma/engines@7.10.1`.
- Update the console's UI libraries (tailwind-merge 3, motion 14, React 19.3, Recharts 3.10).
- Port the console and server HTTP clients to ky 2. Ky 2 reads error bodies before it throws,
  so the console takes API error messages from the error itself and keeps showing them.

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

[1.1.1]: https://github.com/ChefTaco/magnus/releases/tag/v1.1.1
[1.1.0]: https://github.com/ChefTaco/magnus/releases/tag/v1.1.0
[1.0.3]: https://github.com/ChefTaco/magnus/releases/tag/v1.0.3
[1.0.2]: https://github.com/ChefTaco/magnus/releases/tag/v1.0.2
[1.0.1]: https://github.com/ChefTaco/magnus/releases/tag/v1.0.1
[1.0.0]: https://github.com/ChefTaco/magnus/releases/tag/v1.0.0
