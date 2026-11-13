# @hivemagnus/magnus-agent

The Magnus node agent. It is a small daemon that runs on each Linux host you
manage. It enrolls with a [magnus-server](https://github.com/ChefTaco/magnus/tree/main/services/control-api)
Control API, sends heartbeats, and serves authenticated management routes for
the server and the Magnus console.

The agent is infrastructure, not an LLM runtime. It can manage Hermes Agent,
the Codex CLI and Ardent when they are installed on the host. Each of these
integrations is optional and stays inert until you configure it.

## Features

- Heartbeat with CPU, memory, disk, network, services, GPU, Docker group
  services, Wazuh and Tailscale node-key posture.
- Health checks (`/api/v1/health/check`) and an unauthenticated readiness probe
  (`/api/v1/ping`).
- Command execution with timeouts, signed results and a durable command ledger.
- Cron management, including finite managed schedules (see
  [MANAGED_SCHEDULER.md](https://github.com/ChefTaco/magnus/blob/main/packages/agent/MANAGED_SCHEDULER.md)).
  Nodes upgraded from before 1.1.6 may keep one stale remembered Hermes schedule
  source per past Hermes run; see
  [Hermes schedule sources remembered before 1.1.6](https://github.com/ChefTaco/magnus/blob/main/packages/agent/MANAGED_SCHEDULER.md#hermes-schedule-sources-remembered-before-116)
  for the cleanup.
- File read and write with symlink-resolved path checks. Agent state and
  secrets can never be read or written through the API.
- Skill publication, listing and removal, for example from
  [`@hivemagnus/magnus-skills`](https://github.com/ChefTaco/magnus/tree/main/packages/skills).
- Drift, profiling, trace, workspace, network information and local user routes.
- Optional OpenTelemetry trace export and journald log forwarding.
- Optional authenticated UDP discovery of the control node (off by default).

Optional executors:

| Executor | Routes | Active when |
| --- | --- | --- |
| Hermes Agent | `/api/v1/hermes/*`, `magnus-hermes-sync` | the `hermes` CLI is installed for `HERMES_USER` |
| Codex CLI | `/api/v1/codex/*` | a Codex CLI is found for `CODEX_USER` |
| Ardent | `/api/v1/ardent/*` | `ARDENT_OWNER_USER` is set and Ardent is installed |
| HiveMem credential renewal | background | a renewal config file and allowlists exist |

## Requirements

- Linux with systemd. By default the agent runs as root (privileged mode). You
  can also run it as an ordinary account with fewer features; see
  [Privileged and unprivileged mode](#privileged-and-unprivileged-mode).
- Node.js `^24.22.3` or `^26.13.1`.
- `/usr/bin/flock` (util-linux) for command execution.
- A reachable magnus-server Control API.

## Install

```bash
sudo npm install --prefix /opt/magnus-agent @hivemagnus/magnus-agent
sudo install -m 0600 /opt/magnus-agent/node_modules/@hivemagnus/magnus-agent/.env.example /opt/magnus-agent/.env
```

For a quick trial you can also install it globally with
`npm i -g @hivemagnus/magnus-agent` and run `magnus-agent --env-file ./agent.env`.
For production, install it below a stable directory such as `/opt/magnus-agent`,
as shown above. The managed scheduler finds its private `.env` and state there
across upgrades.

## Enroll with a magnus-server

1. In the Magnus console or through the Control API, register the node. Use
   the host's FQDN and a node secret, for example from `openssl rand -hex 32`.
2. Edit `/opt/magnus-agent/.env`:

   ```bash
   CONTROL_API_URL=https://magnus.example.com:4000
   NODE_MANAGER_SECRET=<the node secret registered on the server>
   RESULT_SIGNING_SECRET=<openssl rand -hex 32>
   TLS_CERT_PATH=/opt/magnus-agent/certs/agent.crt
   TLS_KEY_PATH=/opt/magnus-agent/certs/agent.key
   NODE_ENV=production
   ```

3. Validate the configuration, then install the example unit:

   ```bash
   cd /opt/magnus-agent
   sudo node node_modules/@hivemagnus/magnus-agent/dist/index.js check
   sudo cp node_modules/@hivemagnus/magnus-agent/deploy/magnus-agent.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now magnus-agent
   ```

4. Within a heartbeat interval (30 seconds), the node shows as online on the
   server.

Use a certificate whose SAN matches the address the server uses to reach the
agent. If the Control API uses a private CA, set `CONTROL_API_CA_PATH`. TLS
verification is never disabled.

## Privileged and unprivileged mode

`MAGNUS_AGENT_PRIVILEGED` (default `true`) selects the mode.

- **Privileged (`true`):** the agent runs as root and every feature is
  available. If the process is not root, startup fails with a clear message,
  and so does `magnus-agent check`. The agent never half-runs as a normal user
  and never escalates through `sudo`. Use `deploy/magnus-agent.service`.
- **Unprivileged (`false`):** the agent runs as an ordinary account, such as a
  dedicated `magnus-agent` user. The features below are switched off at
  startup. Their routes answer `403` with error code `AGENT_NOT_PRIVILEGED`,
  and `magnus-agent check` lists them as disabled. Use
  `deploy/magnus-agent-unprivileged.service`, which also applies systemd
  hardening. Run the listener on a port above 1023 and make sure the TLS key is
  readable by that account.

| Feature | Needs privileged mode | Unprivileged behaviour |
| --- | --- | --- |
| Heartbeat, health, drift, profiling, traces, network info | no | available |
| Command execution (`/api/v1/commands`) | no | runs as the agent's account |
| File read/write (`/api/v1/files`) | no | limited to what the account may access |
| Skill publication (`/api/v1/skills`) | no | into a skills dir the account owns |
| Workspace routes | no | below `MAGNUS_AGENT_WORKSPACE_ROOT` |
| Hermes Agent and Codex CLI management | no | for the agent's own account only |
| Cron and managed schedules (`/api/v1/cron/*`) | **yes** | 403 `AGENT_NOT_PRIVILEGED` |
| Local users and passwords (`/api/v1/users/*`) | **yes** | 403 `AGENT_NOT_PRIVILEGED` |
| Automatic system updates (`POST /api/v1/health/system-updates/enable`) | **yes** | 403 `AGENT_NOT_PRIVILEGED` |
| Docker group remediation (heartbeat) | **yes** | membership is reported, never changed |
| Ardent management (`POST /api/v1/ardent/action`) | **yes** | 403 `AGENT_NOT_PRIVILEGED`; state stays readable |
| HiveMem credential and certificate renewal | **yes** | not started |
| Execution supervisor (`MAGNUS_EXECUTION_SUPERVISOR_ENABLED`) | **yes** | configuration error if enabled |

## Upgrades

Run `sudo magnus-agent install-service` (add `--unprivileged` for the ordinary-account mode) once
per node. It does four things:

- moves the install into `/opt/magnus-agent/versions/<X>`
- links `./current`
- installs the upgrade launcher (`launcher/launcher.mjs`)
- writes the systemd unit

`--dry-run` prints the steps first.

After that, the server can upgrade the agent from the console's **Upgrade agents** action or with
`magnus-server agents upgrade`, in four steps:

1. The agent downloads the exact version the server names and checks its npm `sha512` integrity. It
   also runs `npm audit signatures` (`MAGNUS_AGENT_UPGRADE_REQUIRE_PROVENANCE`).
2. It installs that version beside the running one and checks that it runs on this Node.js
   (`engines`), works with the installed launcher, and reports the requested version. Then it points
   `./current` at it and exits.
3. The launcher starts the new version on trial.
4. If the new version does not report an accepted heartbeat within
   `MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS` (default 180), or crashes twice, the launcher switches back
   to the previous version. A new version that runs but cannot reach the control API gets up to three
   windows, and the revert reason then says so.

Every step has a time limit, and the whole upgrade stops after 13 minutes (`SELF_UPGRADE_TIMEOUT`).
npm, its lifecycle scripts and the smoke test run without the agent's credentials. The agent uses
`MAGNUS_AGENT_NPM` when set, otherwise the npm that ships with the Node.js it runs on, then npm on
`PATH`. A retried
request with the same `requestId` returns the current state instead of an error.

The state file (`upgrade-state.json`) and the links are written durably (fsync and rename), and the
agent and the launcher lock the state file while they change it. `./last-good` points at the last
confirmed version. The launcher switches to it when `versions/<from>` is missing, and when the state
file is unreadable and `./current` keeps exiting. When a write fails (full or read-only disk), the
launcher logs it and still starts an agent instead of crash-looping.

A confirmed version installs its own `launcher/launcher.mjs` when that declares a higher
`LAUNCHER_PROTOCOL` and passes a self-check; the old file is kept as `launcher.mjs.previous`. In the
`--unprivileged` mode, `launcher/` stays owned by root, so the launcher is updated only by
`install-service`. A release that needs a newer launcher than the node runs is refused with
`SELF_UPGRADE_LAUNCHER`.

The agent writes only inside its install directory and never uses sudo. Set
`MAGNUS_AGENT_SELF_UPGRADE=false` to refuse upgrade requests on a node. Offline nodes can install from
local tarballs with `MAGNUS_AGENT_UPGRADE_SOURCE_DIR`. See
[UPGRADING.md](../../UPGRADING.md#agents).

## CLI

```text
magnus-agent [start] [--env-file <path>]          Start the agent (default)
magnus-agent check [--json] [--env-file <path>]   Validate configuration without starting
magnus-agent enroll --token <token>               Bind a new node key with a one-time enrollment token
magnus-agent identity show [--json]               Print the node id and key fingerprints (never the key)
magnus-agent identity rotate                      Replace the node key
magnus-agent identity reset                       Remove the node key and return to the shared node secret
magnus-agent env-schema                           Print the configuration schema as JSON
magnus-agent --help | --version
```

Variables already set in the environment win over `--env-file`. The agent also
reads `$AGENT_INSTALL_DIR/.env` (default `./.env`).

## Configuration

[`.env.example`](./.env.example) groups every key into Required and Optional,
and `magnus-agent env-schema` prints them as JSON.

| Variable | Purpose |
| --- | --- |
| `CONTROL_API_URL` | magnus-server Control API (required) |
| `NODE_MANAGER_SECRET` | Node credential shared with the server (required, 32+ characters). The agent also creates its own node key in `$AGENT_INSTALL_DIR/identity` and binds it automatically; see [per-node credentials](https://github.com/ChefTaco/magnus/blob/main/docs/NODE_CREDENTIALS.md) |
| `NODE_AUTH_MODE` | Reserved (`compat`, `warn`, `enforce`); the agent behaves as `compat` in this release |
| `RESULT_SIGNING_SECRET` | Independent result-signing key (required, 32+ characters) |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | Listener TLS, required in production |
| `HOST_FQDN` | Host identity override (default `hostname --fqdn`) |
| `NODE_MANAGER_PORT` / `NODE_MANAGER_BIND_HOST` | Listener port (default `4100`) and address |
| `CONTROL_API_CA_PATH` | CA bundle for a private-CA Control API |
| `SKILLS_DIR` / `SKILLS_EXTRA_DIRS` | Skill directories |
| `HERMES_USER`, `HERMES_REGISTRY_TOKEN`, `MAGNUS_HERMES_SYNC_PULL` | Hermes Agent management and registry sync |
| `CODEX_USER`, `CODEX_BIN`, `CODEX_HOME` | Codex CLI management |
| `ARDENT_OWNER_USER`, `ARDENT_STAGED_PACKAGE`, `MAGNUS_AGENT_ARDENT_PACKAGES`, `MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES` | Ardent management (artifact stream cap, default 64 MiB) |
| `MAGNUS_AGENT_RENEWAL_*` | HiveMem credential renewal allowlists (empty by default) |
| `MAGNUS_AGENT_TLS_RENEWAL=tailscale` | Renew a Tailscale listener certificate |
| `MAGNUS_AGENT_PRIVILEGED` | Privileged (root, default `true`) or unprivileged mode |
| `MAGNUS_AGENT_DOCKER_USER` | Account the docker-group check verifies |
| `ENABLE_AGENT_DISCOVERY`, `AGENT_DISCOVERY_*` | Authenticated UDP discovery |

### HiveMem credential renewal

When HiveMem is part of your stack, the agent can renew HiveMem tokens before
they expire. Put the entries in a root-owned `0600` JSON file
(`MAGNUS_AGENT_RENEWAL_CONFIG`, default `$AGENT_INSTALL_DIR/credential-renewal.json`).
The entries can only touch what the comma-separated allowlists name:
`MAGNUS_AGENT_RENEWAL_ENDPOINTS`, `_UNITS`, `_USERS`, `_ARDENT_PROFILES`,
`_TOKEN_FILES` and `_SIGNING_ENV_FILES`. Every list is empty by default, so
renewal does nothing until you configure it.

### Reviewed historical mutation records

A node with retained mutation records whose outcome is unknown can settle them only through a signed
historical quiescence receipt. The receipt counts only for records an operator has reviewed, listed
in a root-controlled JSON file (`MAGNUS_AGENT_REVIEWED_HISTORICAL_RECORDS`, default
`/etc/magnus/reviewed-historical-records.json`):

```json
{
  "version": 1,
  "records": {
    "0b6f1c2e-6d3a-4f6e-9c1d-2a7b8e9f0a1b": { "nodeFqdn": "node-1.example.com", "recordSha256": "<64 lowercase hex>" }
  }
}
```

The keys are the mutation record ids. `recordSha256` is the SHA-256 of the retained record file, as
in the signed observation. Entries for other nodes (`nodeFqdn` other than `HOST_FQDN`) are ignored, so
one file can serve a fleet. The file and its directory must be owned by root and not group- or
world-writable, and the file must not be a symlink or larger than 1 MiB. `0644` works for an
unprivileged agent too. The agent reads the file once at startup, so restart it after a change. A
missing file means no reviewed records. A file that fails these checks or the schema is refused as a
whole, and the agent logs the reason at startup.

### Hermes registry sync

`deploy/magnus-hermes-sync.service` and its timer run `dist/hermes-sync.js`
every five minutes. Without `HERMES_REGISTRY_TOKEN` the job does nothing.
With `--submit-only` it only reports the local Hermes inventory. Applying the
server's desired skills, plugins and MCP releases also needs
`MAGNUS_HERMES_SYNC_PULL=true`.

## Interoperating with older components

`MAGNUS_AGENT_ARDENT_PACKAGES` (default `@hivemagnus/ardent`) lists the scoped
npm package names the agent accepts as the Ardent runtime, in preference order.
It applies to the staged `ardent-package.json` sidecar, the install path
`node_modules/<name>`, the install receipt and the managed `ardent@<profile>`
user unit. To keep managing an Ardent build published under another scope, add
its name, for example `MAGNUS_AGENT_ARDENT_PACKAGES=@hivemagnus/ardent,@legacy-scope/ardent`.
Older sidecars with the `{name, version, sha256}` shape are accepted unchanged.
Profile channel maps accept any channel key that matches `[a-z][a-z0-9_-]{0,31}`.

For adopting Emberfold without replacing the existing runtime, see
[context-only Ardent adoption](../../docs/ARDENT_CONTEXT_ADOPTION.md). The release
bundles the exact context adapter and engine; managed staging verifies continuity
in isolated data before activation exercises an actual old-runtime rollback.

## Development

```bash
npm install                # at the repository root
npm run dev --workspace @hivemagnus/magnus-agent
npm run typecheck --workspace @hivemagnus/magnus-agent
npm test --workspace @hivemagnus/magnus-agent
npm run build --workspace @hivemagnus/magnus-agent
```

To run the agent locally as your own user, set `MAGNUS_AGENT_PRIVILEGED=false`.
For local development without certificates, set `ALLOW_INSECURE_HTTP=true`.
The agent then serves plain HTTP on loopback only. This is rejected in
production.

## License

Apache-2.0

### Native installation acceptance

Set `MAGNUS_AGENT_SELF_URL` to the running agent's verified HTTPS origin and,
when needed, `MAGNUS_AGENT_SELF_CA_PATH` to its private CA bundle.
`magnus-agent --env-file /opt/magnus-agent/agent.env acceptance --json` waits up
to 60 seconds for authenticated healthy status, the expected product version and
a recently accepted heartbeat. Use `--wait-seconds 0` for one probe. It emits only
bounded evidence, without raw health diagnostics, credential fingerprints or tokens.
A reachable listener alone does not pass this check. Existing profiles and
provider authorizations remain operator-owned.

Release maintainers can export a reviewed image into a native artifact with its
exact Node runtime using `npm run build:native-agent -- --image PINNED_IMAGE
--output NEW_DIRECTORY`. The source must be an immutable registry digest or
local image ID, on matching Linux architecture. The image is never started.
The archive contains public runtime files and licenses, a native launcher and
SHA-256 metadata. Review privacy and sign the release matrix before publication;
artifact construction does not authorize deployment.

Managed web terminals require explicit `MAGNUS_AGENT_MANAGED_TERMINAL_USER` and
`MAGNUS_EXECUTION_SUPERVISOR_ENABLED=true`. Use a dedicated non-root account without
supplementary groups. Each PTY runs in a bounded systemd cgroup with a read-only host
filesystem, private temporary files, no privilege escalation and no user-manager IPC.
The signed receipt proves that group stopped; it does not undo external network effects.
