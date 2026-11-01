# Magnus

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Magnus is self-hosted fleet management for Linux hosts and AI agents.** A small agent on each
host reports to a central API server, and a web console lets you see and operate the whole fleet:
inventory and health, commands, cron jobs, files, logs, skills, rollouts, incidents and an
append-only audit log. Magnus can also manage the AI agents that run on those hosts (Hermes Agent,
the Codex CLI and its own Ardent runtime) and ships a catalogue of Ubuntu operations skills for
them.

| Component | What it does |
|---|---|
| [**Magnus UI**](apps/dashboard) | Next.js web console. The browser talks only to the console; it calls the API server and the agents server-side, so secrets never reach the browser. |
| [**Magnus server**](services/control-api) | Hono API server backed by PostgreSQL and Redis. It keeps the inventory and desired state, ingests heartbeats and logs, dispatches signed commands through a durable queue, and records every change in the audit log. |
| [**Magnus agent**](packages/agent) | Daemon for each managed Linux host. It sends heartbeats, runs commands, manages cron, files and skills, and manages Hermes Agent, Codex and Ardent when they are installed. |
| [**Ardent**](packages/ardent) | Headless TypeScript agent runtime with durable tasks, A2A 1.0, scheduled jobs, skills, and optional Telegram and Mattermost channels. It runs standalone or under Magnus management. |
| [**Skills**](packages/skills) | Ubuntu operations skills (shell script plus `SKILL.md`) in the Hermes Agent skill format. |

Everything is strict TypeScript on Node.js 24 or 26.

## Packages on npm

These are the release package names. See the [publication guide](docs/PUBLISHING.md)
for registry setup and release verification.

| Path | Package | Description |
|---|---|---|
| `apps/dashboard` | [`@hivemagnus/magnus-ui`](https://www.npmjs.com/package/@hivemagnus/magnus-ui) | The web console (`magnus-ui start`), shipped as a prebuilt Next.js standalone server |
| `services/control-api` | [`@hivemagnus/magnus-server`](https://www.npmjs.com/package/@hivemagnus/magnus-server) | The API server (`magnus-server migrate`, `magnus-server start`) with its Prisma schema and migrations |
| `packages/agent` | [`@hivemagnus/magnus-agent`](https://www.npmjs.com/package/@hivemagnus/magnus-agent) | The node agent (`magnus-agent`) with example systemd units |
| `packages/ardent` | [`@hivemagnus/ardent`](https://www.npmjs.com/package/@hivemagnus/ardent) | The Ardent agent runtime (`ardent init`, `ardent chat`, `ardent gateway run`) |
| `packages/contracts` | [`@hivemagnus/magnus-contracts`](https://www.npmjs.com/package/@hivemagnus/magnus-contracts) | Zod schemas and types shared by the server, the console and the agent |
| `packages/skills` | [`@hivemagnus/magnus-skills`](https://www.npmjs.com/package/@hivemagnus/magnus-skills) | The skills catalogue, with a small API to list and locate the bundled skills |
| `packages/magnus` | [`@hivemagnus/magnus`](https://www.npmjs.com/package/@hivemagnus/magnus) | The installer and upgrade tool (`magnus init`, `magnus upgrade`, `magnus rollback`), which pins tested versions of every component |

## Requirements

- Node.js 24 (`>=24.22.1`) or 26 (`>=26.13.0`).
- PostgreSQL 17 (15 or later works) and Redis 7 for the server. Redis is also used by the console
  for login throttling.
- Linux with systemd for the agent.
- TLS certificates for the server, the console and each agent. Cleartext HTTP is a loopback-only
  development option.

## Quick start

**One command, for a single host.** This installs the server and the console, generates secrets and
a self-signed certificate, runs PostgreSQL and Redis through docker compose (or uses
`--database-url`/`--redis-url`), and starts everything as systemd user services. Upgrades then take
one command as well (see [Upgrading](#upgrading)).

```bash
npx @hivemagnus/magnus init        # project in ~/.magnus; prints the console URL and login
```

`npx @hivemagnus/magnus init --help` lists the options. `--system --service-user magnus` installs
system units under `/opt/magnus` instead. To set things up yourself, follow the steps below.

### 1. Start the server

**With Docker Compose.** [`services/control-api/docker/compose.yml`](services/control-api/docker/compose.yml)
runs the server together with PostgreSQL 17 and Redis 7:

```bash
git clone https://github.com/ChefTaco/magnus.git && cd magnus
cp services/control-api/.env.example services/control-api/docker/.env
# set POSTGRES_PASSWORD, REDIS_PASSWORD and every required secret
# (one `openssl rand -hex 32` each; all of them must be different)
docker compose -f services/control-api/docker/compose.yml \
  --env-file services/control-api/docker/.env up -d --build
```

The server applies its migrations on start and listens on `https://127.0.0.1:4000`. Without a
mounted certificate it creates a self-signed one, which is meant for evaluation only.

**With npm and your own PostgreSQL and Redis:**

```bash
npm install -g --allow-scripts=argon2,ssh2,cpu-features,prisma,@prisma/engines,msgpackr-extract \
  @hivemagnus/magnus-server
mkdir -p ~/.magnus
cp "$(npm root -g)/@hivemagnus/magnus-server/.env.example" ~/.magnus/server.env
chmod 600 ~/.magnus/server.env
# set DATABASE_URL, REDIS_URL, TLS_CERT_PATH, TLS_KEY_PATH and the required secrets

magnus-server check   --env-file ~/.magnus/server.env   # validate config, reach PostgreSQL and Redis
magnus-server migrate --env-file ~/.magnus/server.env   # apply migrations and base data
magnus-server start   --env-file ~/.magnus/server.env
```

The server refuses to start while a required secret is missing; there are no default secrets.
`magnus-server env-schema --format table` lists every variable. The API is served under `/api/v1`,
with interactive documentation at `https://localhost:4000/api/docs`.

### 2. Start the console

```bash
npm install -g --allow-scripts=argon2,ssh2,cpu-features @hivemagnus/magnus-ui
cp "$(npm root -g)/@hivemagnus/magnus-ui/.env.example" ~/.magnus/ui.env
chmod 600 ~/.magnus/ui.env
# set CONTROL_API_URL, API_SECRET (same value as the server), SESSION_SECRET,
# CONTROL_NODE_CREDENTIAL_KEY, REDIS_URL, DASHBOARD_PUBLIC_ORIGIN,
# DASHBOARD_ADMIN_USERNAME, DASHBOARD_ADMIN_PASSWORD_HASH and the TLS paths

magnus-ui check --env-file ~/.magnus/ui.env
magnus-ui start --env-file ~/.magnus/ui.env    # https://localhost:3000
```

The [console README](apps/dashboard) shows how to generate the Argon2id password hash and lists
every setting.

### 3. Add a host

On each Linux host you want to manage:

```bash
sudo npm install --prefix /opt/magnus-agent @hivemagnus/magnus-agent
sudo install -m 0600 /opt/magnus-agent/node_modules/@hivemagnus/magnus-agent/.env.example /opt/magnus-agent/.env
```

Register the node in the console (or through the API) with the host's FQDN and a node secret, then
set `CONTROL_API_URL`, `NODE_MANAGER_SECRET`, `RESULT_SIGNING_SECRET` and the TLS paths in
`/opt/magnus-agent/.env`. Validate the configuration and enable the example systemd unit:

```bash
cd /opt/magnus-agent
sudo node node_modules/@hivemagnus/magnus-agent/dist/index.js check
sudo cp node_modules/@hivemagnus/magnus-agent/deploy/magnus-agent.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now magnus-agent
```

The host shows as online within one heartbeat interval (30 seconds). By default the agent runs as
root (`MAGNUS_AGENT_PRIVILEGED=true`); it can also run as an ordinary account with fewer features.
See the [agent README](packages/agent) for both modes.

## Upgrading

Server, console and agent are released together. Within a major version, an upgrade is one command
or one click:

- **Managed install** (`magnus init` or `magnus adopt`): `magnus upgrade`, or `magnus-server upgrade`.
  It backs up PostgreSQL, installs the new release beside the running one, migrates, checks, switches
  over and restarts. If the new version is not healthy, it switches back automatically and prints the
  restore command. `magnus rollback` goes back one step.
- **Docker Compose:** `docker compose pull && docker compose up -d`. The images migrate at startup,
  after a dump.
- **Agents:** **Upgrade agents** on the Nodes page, or `magnus-server agents upgrade`. Each agent
  switches back by itself if the new version does not report a heartbeat. Run
  `sudo magnus-agent install-service` once per node first.

Nothing crosses a major version by itself, and every automatic behaviour has an off switch. The
console and `magnus-server check` show when a new release is available
(`MAGNUS_UPDATE_CHECK=false` turns that off). See [UPGRADING.md](UPGRADING.md) for every path, the
switches, and how to run your own release process instead.

## Optional integrations

Every integration is off when its variables are unset. Magnus starts and works without any of
them, and `magnus-server check` and `magnus-ui check` print which ones are on.

| Integration | What it adds | Enable with |
|---|---|---|
| [Hive IAM](https://github.com/ChefTaco/hive) login | Named-user OIDC sign-in to the console, and IAM-issued access tokens for the API | Console: `HIVE_OAUTH_DISCOVERY_URL`, `HIVE_OAUTH_CLIENT_ID`, `HIVE_OAUTH_ISSUER`, `HIVE_OAUTH_API_AUDIENCE`. Server: `IAM_CORE_URL`, `IAM_TOKEN_ISSUER`, `IAM_TOKEN_AUDIENCE` |
| [Hive Router](https://github.com/ChefTaco/hive) | Model routing for managed Hermes Agents, and the router admin UI embedded in the console | Server: `MAGNUS_ROUTER_URL`, `MAGNUS_ROUTER_MODEL`, `MAGNUS_ROUTER_API_KEY`. Console: `HIVE_ROUTER_ADMIN_URL` |
| [HiveMem](https://github.com/ChefTaco/hive) | Shared long-term memory for Hermes Agents, Ardent and operational lessons | Server: `HIVEMEM_URL`, `HIVEMEM_TOKEN`. Ardent: `memory.provider: hivemem` |
| External security console | Exports security observations and links the console's security pages to it | Server: `SECURITY_FUSION_MODE=remote`, `MAGNUS_SECURITY_CONSOLE_URL`, `SECURITY_EXPORT_ENABLED=true`. Console: `MAGNUS_SECURITY_CONSOLE_URL` |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Installation, profile, skill and drift management, and the Hermes dashboard embedded over SSH | Console: `MAGNUS_HERMES_ENABLED=true`, `HERMES_SSH_AUTHORIZATIONS_FILE`, `DASHBOARD_SSH_*`. Agent: `HERMES_USER`. Registry sync: `MAGNUS_HERMES_REGISTRY_ENABLED=true` on the server |
| Codex CLI | Fleet view of Codex CLI versions and ChatGPT sign-in state, with update and device-code login actions | Agent: `CODEX_USER` (the CLI is detected automatically) |
| Telegram and Mattermost (Ardent) | Chat with an Ardent profile | Ardent `config.yaml`: `channels.telegram` (`TELEGRAM_BOT_TOKEN`) or `channels.mattermost` (`MATTERMOST_URL`, `MATTERMOST_TOKEN`) |

## Development

```bash
git clone https://github.com/ChefTaco/magnus.git && cd magnus
npm ci                   # install every workspace
npm run hooks:install    # privacy and secret checks on commit and push
npm run build            # contracts, skills, Ardent, agent, server, console
npm test
npm run verify           # everything CI runs: scans, build, typecheck, tests, contract and doc checks
```

Each workspace has its own scripts, for example `npm run control-api:test` or
`npm --workspace @hivemagnus/ardent test`. The server's integration tests need a disposable
PostgreSQL database; see the [server README](services/control-api).

## Documentation

- [Documentation index](docs/README.md)
- [Architecture](docs/APP_ARCHITECTURE.md)
- [Script guide](scripts/README.md)
- [Upgrading](UPGRADING.md)
- [Changelog](CHANGELOG.md)
- The README and `AGENTS.md` in each package

## Security

Secrets stay server-side, and a missing required secret stops the process instead of falling back
to a default. TLS verification is never disabled. Please report vulnerabilities privately; see
[SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

[Apache License 2.0](LICENSE) © ChefTaco and contributors.
