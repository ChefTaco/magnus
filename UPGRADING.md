# Upgrading Magnus

Magnus releases the server, the console, the agent and the shared contracts together, under one
version number. Within a major version (1.x), every release can be applied in place, and a 1.x
server works with any 1.x agent. Releases follow [semver](https://semver.org/). Read the
[CHANGELOG](CHANGELOG.md) entry of each release you skip, in particular its **New environment
variables** and **Migration impact** sections.

The rules every upgrade path follows:

- **Never across a major version by itself.** `magnus upgrade`, the update notices, the agent
  upgrade action and the `:1` image tags all stay on the current major. A new major needs
  `--allow-major` (or a new image tag) and its own notes.
- **Always back up before migrating.** Every path that migrates dumps PostgreSQL first and stops if
  the dump fails. The only exception is a dump you switch off yourself (`MAGNUS_AUTO_MIGRATE_BACKUP=false`).
- **Every automatic behaviour has a switch.** See [Turning automation off](#turning-automation-off).
- **Slow and one-way migrations ask first.** Each release lists the impact of its migrations (`fast`,
  `slow` or `one-way`). Upgrades print slow and one-way migrations and wait for confirmation
  (`--yes`). Startup auto-migrate refuses them unless `MAGNUS_AUTO_MIGRATE_ALLOW_SLOW=true` is set.

## Managed install (`magnus init`)

A project created with `npx @hivemagnus/magnus init` upgrades with one command on the server host:

```bash
magnus upgrade --dry-run      # what would change: releases, notes, new settings, migrations
magnus upgrade                # newest release of the current major
magnus upgrade --to 1.2.0     # a specific release
```

`magnus-server upgrade` does the same; it finds the project from its own install path, or from
`MAGNUS_PROJECT_DIR`. A system-wide project (`init --system`) needs `sudo`.

Each upgrade goes through these steps:

1. Takes the project lock, then resolves the target release from the npm registry (or from
   `--source DIR` with packed tarballs, for offline hosts). Without `--to` it never picks a
   deprecated release or one newer than the registry's `latest` tag. The registry is `--registry`,
   then `MAGNUS_UPDATE_REGISTRY`, then the one npm is configured with (`.npmrc`). With
   `HTTPS_PROXY` set, magnus runs Node.js with `NODE_USE_ENV_PROXY=1` so the proxy is used.
2. Refuses a downgrade (use `rollback`) and a major-version change (unless `--allow-major`). A
   release that needs a stepping stone (`minUpgradeFrom`) names the `--to` version to take first.
3. Checks the Node.js **the services run** (recorded in the project, from the unit's `ExecStart`)
   against the release's `engines`. `--node /path/to/node` switches it and rewrites the units.
4. Checks that your env files set every new required setting. Missing secrets can be generated with
   `--generate-secrets`; anything else must be added by hand first.
5. Checks the prerequisites before it changes anything: free disk space for the install and the
   dump, the systemd session bus (user units), and with `--dry-run` also `pg_dump` and npm.
6. Installs the release into `versions/<X.Y.Z>` with the npm that belongs to the services' Node.js,
   allowing the install scripts the release's manifest lists. The running version keeps serving.
7. Runs the new version's `magnus-server check` and a start-up test (`--version`, native modules)
   **before** the database is touched. A failing or crashing check stops the upgrade here.
8. If the database has pending migrations, dumps it into `backups/` with `pg_dump -Fc`, checks the
   dump with `pg_restore --list`, and migrates. Old dumps are pruned to the newest five
   (`keepBackups` in `magnus-project.json`); the newest dump of each upgrade step always stays.
9. Switches `./current`, restarts the services and waits until the new version answers health
   checks and reports itself as running.
10. If the new version is not healthy in time (`--health-timeout`, default 180 s), or the restart
    fails, it switches `./current` back, restarts the previous version and prints the restore
    command for the dump. When the upgrade applied a **one-way** migration, the previous version is
    not started (it cannot run on that schema): restore the dump with `magnus restore`, which starts
    it afterwards, or pass `--force` to start it anyway.

From the backup on, `magnus-project.json` records the upgrade in progress. If the upgrade is killed
or the host goes down midway, the next `magnus upgrade` or `magnus rollback` says so:

```bash
magnus upgrade --resume       # finish the interrupted upgrade (runs the remaining steps again)
magnus rollback               # or go back to the version that served before it
```

Ctrl-C, a closed terminal (SIGHUP) or SIGTERM stop the upgrade at the next safe step. A running
migration always finishes first; after the switch, an interrupted upgrade switches back. Run long
upgrades in `tmux` or `screen` anyway.

A lock in `run/upgrade.lock` keeps two commands from running at once. A lock left by a process that
no longer runs (also after a reboot) is taken over by itself; `--break-lock` removes one by hand.

The previous version stays installed (the newest three are kept), so going back takes seconds:

```bash
magnus rollback               # switch back to the version before the last upgrade
magnus rollback --restore-db  # also restore the pre-upgrade dump (data written since is lost)
magnus status                 # installed and serving versions, history, available updates
```

Migrations within a major version only add to the schema, so the previous version normally runs
against the migrated database. Restore the dump only if it does not, or when a release marks a
migration `one-way`. `rollback` asks the previous version which applied migrations it does not know,
and refuses to start it over a one-way one unless you pass `--restore-db` (or `--force`).
`--restore-db` fails when there is no dump to restore, and when a restore fails the services start
again on the unchanged database.

### Restoring a dump

```bash
magnus restore ~/.magnus/backups/<file>.dump     # stops the services, restores, starts them again
```

The restore never mixes old and new tables: the live `public` schema is renamed aside, a new one
with the same owner and grants takes its place, `pg_restore --single-transaction` fills it, and the
old one is dropped only after the restore committed. If `pg_restore` fails, the original schema is
put back and the database is unchanged. Without a managed project, stop the server and run
`magnus-server restore <file> --env-file server.env`.

### Adopting an existing npm install

If you installed `@hivemagnus/magnus-server` and `@hivemagnus/magnus-ui` by hand (1.0.x), turn the
install into a managed project once:

```bash
npx @hivemagnus/magnus adopt --server-env-file /etc/magnus/server.env --ui-env-file /etc/magnus/ui.env
```

Your env files stay where they are. `adopt` installs the same version under `versions/` and writes
new systemd units that point at `./current`, then prints how to switch from your old units. It
replaces your units itself only with `--install-units`. The first `magnus upgrade` adds
`MAGNUS_PROJECT_DIR` and `MAGNUS_RUNTIME_FILE` to the server env file (with a `.bak` of the old
one), so a server you start yourself (`--supervisor none`) reports which version is serving.

User units belong to the account that owns the project: run `magnus` as that account, not with
`sudo`. Without a login session (for example over `su`), enable lingering
(`loginctl enable-linger <account>`) and use `machinectl shell <account>@`. On macOS and other
systems without systemd, use `--supervisor none`.

## Manual npm install

Without a managed project, follow these steps in order:

1. Read the release notes. Add any new required settings to your env files.
2. Back up: `magnus-server backup --env-file server.env` (prints the dump file and the restore command,
   `magnus-server restore <file> --env-file server.env`, to run with the server stopped).
3. Install the exact versions together:
   `npm install -g @hivemagnus/magnus-server@X.Y.Z @hivemagnus/magnus-ui@X.Y.Z`
   (npm 12: pass the `--allow-scripts=...` list from the README).
4. Run `magnus-server migrate --env-file server.env`, then `magnus-server check --env-file server.env`.
5. Restart the server, then the console.

`magnus-server migrations` shows what is pending, and the impact of each migration, before you
migrate.

## Docker Compose

The images are published to GHCR with the tags `X.Y.Z`, `X.Y` and `X`. There is no `latest`. The
server image applies migrations at startup (`MAGNUS_AUTO_MIGRATE=true`) after dumping the database
into its backups volume.

```bash
docker compose pull && docker compose up -d
```

`MAGNUS_VERSION` in the Compose `.env` selects the tag:

- `1` follows every 1.x release.
- `1.1` takes patch releases only.
- `1.1.0` pins one release.

To go back, set the previous version and run `docker compose up -d`. If the newer version migrated
the database and the old one does not start, restore the dump from the backups volume with the
server and console stopped:

```bash
c="docker compose -f docker/compose.yml --env-file docker/.env"
$c stop magnus-ui magnus-server
$c run --rm --no-deps --entrypoint magnus-server magnus-server restore /var/lib/magnus/backups/<file>.dump --yes
$c up -d
```

`$c run --rm --no-deps --entrypoint sh magnus-server -c 'ls -l /var/lib/magnus/backups'` lists the
dumps. Startup auto-migrate keeps the newest five (`MAGNUS_BACKUP_KEEP`), and a server that keeps
restarting reuses the dump of its last attempt instead of writing a new one each time. A database
with a migration that failed halfway is refused before any dump, with the way out.

### Automatic pulls

Upgrades through pulls are safe to automate as long as the tag stays on one major. Options:

- [Watchtower](https://containrrr.dev/watchtower/), limited to the Magnus containers. Keep
  `MAGNUS_VERSION` on a major tag such as `1`, never a tag that could cross majors:

  ```yaml
  services:
    watchtower:
      image: containrrr/watchtower
      command: --schedule "0 0 4 * * *" --cleanup --label-enable
      volumes: ["/var/run/docker.sock:/var/run/docker.sock"]
  # and on magnus-server and magnus-ui:
  #   labels: ["com.centurylinklabs.watchtower.enable=true"]
  ```

- A scheduled job:
  `docker compose pull && docker compose up -d` from cron or a systemd timer.

Slow or one-way migrations still stop at startup until you set `MAGNUS_AUTO_MIGRATE_ALLOW_SLOW=true`
for that one upgrade, so an unattended pull never applies one by surprise. **That stop takes the
server down:** the new container exits at startup and restarts until you act, and the console waits
for it. Watch for it (the container's health status, or `docker compose ps`), then either allow the
migration for one start or set `MAGNUS_VERSION` back. A large database can take a while to dump
before the server listens; the server's health check allows ten minutes for startup.

Instances that share one database take turns: each waits up to `MAGNUS_AUTO_MIGRATE_LOCK_TIMEOUT`
seconds (default 600) for the one that migrates. Behind PgBouncer in transaction mode, the migrate
lock does not hold: set `MAGNUS_MIGRATE_DATABASE_URL` to a direct connection.

## Agents

A 1.x agent works with any 1.x server. Agents keep their version until you upgrade them; the server
shows the ones that run a different version than it ships with, both in the console and in its log.

### One-time setup per node

Self-upgrades need the versioned layout and the upgrade launcher. Run this once, as root, on every
node:

```bash
sudo /opt/magnus-agent/node_modules/.bin/magnus-agent install-service                 # root agent
sudo /opt/magnus-agent/node_modules/.bin/magnus-agent install-service --unprivileged  # magnus-agent account
```

It moves the install into `/opt/magnus-agent/versions/<X>`, links `./current`, installs
`launcher/launcher.mjs` and rewrites the systemd unit (the old unit is kept as `.pre-launcher`).
`--dry-run` prints the steps first.

### Upgrading

- From the console: open **Nodes**, then **Upgrade agents**. Agents that cannot upgrade now are
  greyed out with the reason: offline, not set up with `install-service`, self-upgrade switched off,
  already current, another major version, already reverted this version, a closed release admission
  fence, an incomplete resource enrollment (for example "resource enrollment stuck in draining
  since <date>"), unsettled participant work or command leases, or an agent whose local
  managed-enrollment marker the server does not share (see below).
- From the server host: `magnus-server agents upgrade [--to X.Y.Z] [--nodes a,b] [--canary NODE] [--dry-run]`.

One agent goes first as a canary. Once it confirms, the rest follow, a few at a time
(`MAGNUS_AGENT_UPGRADE_CONCURRENCY`). Each node is checked again right before it is asked; a node
that became ineligible is skipped with the reason.

Outcomes per node:

| State | Meaning | Run |
| --- | --- | --- |
| `confirmed` | The agent reported this request's version as confirmed after its trial | continues |
| `refused` | Nothing changed on the node: the server did not send the request (admission, enrollment, unreachable agent) or the agent declined it (busy, already current, launcher missing, managed-mutation guard) | continues; a refused canary hands the role to the next node |
| `reverted` | The new version did not report in time and the agent switched back | stops |
| `failed` | A release problem (integrity, install, source), or the agent went silent after the request | stops |
| `skipped` | Not reached, or ineligible at its turn | — |

The run summary lists the counts and every refusal with its code and message, for example
`3 confirmed, 1 refused, 0 failed, 0 skipped; refused: node-b (SELF_UPGRADE_BUSY: …)`.

- **Stop**: the console's Stop button, `POST /api/v1/agents/upgrade/runs/<id>/stop` or
  `magnus-server agents stop <id>` stops the run before its next batch. Ctrl-C in
  `magnus-server agents upgrade` does the same; a second Ctrl-C leaves at once.
- **Interrupted runs**: the server (or CLI) that runs an upgrade renews a lease on it. If it
  restarts or is killed, the run shows as `interrupted` within a few minutes, its asked nodes are
  settled from their last heartbeat report, and a new run can start. A report that arrives later
  for such a node is still recorded into the run.
- **Retry**: the console's Retry button, `POST /api/v1/agents/upgrade/runs/<id>/retry` or
  `magnus-server agents upgrade --retry <id>` starts a new run with the same version and integrity
  for the failed, refused, skipped and interrupted nodes. Nodes that reverted this version are only
  offered again with `allowRetryReverted` (`--retry-reverted`).
- Prerelease versions need `allowPrerelease` (`--allow-prerelease`). A target the registry does not
  have is shown as unverified.
- The server waits for each agent's own trial window (`MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS`, which
  1.1.3 agents report), two heartbeats and a restart margin, and gives up earlier on an agent that
  stopped sending heartbeats.

If the reply to an upgrade request is lost, the server keeps watching: the agent's heartbeat report
for that request decides. On a node with resource leases, the command lease for that request
(`agent-upgrade-<requestId>`) stays `unknown` until it is reconciled with signed evidence, as for
any other managed request: `POST /api/v1/commands/agent-upgrade-<requestId>/reconcile-resource`
adopts the agent's signed receipt (see docs/COMMAND_RESOURCE_LEASES.md). The upgrade run never
releases a lease by itself.

**"Agent and server disagree about resource enrollment".** An agent stores a local
managed-enrollment marker once the server has told it the node is enrolled, and from then on it
refuses direct requests. The server tells it so when the node has any enrollment beyond `legacy`
or any durable ownership history, including participant work such as console terminal or SSH
sessions. A node with such history but no completed enrollment ends up with a marker on the agent
and no enrollment on the server. Complete the node's enrollment drain on the server
(docs/COMMAND_RESOURCE_LEASES.md), or upgrade that agent by hand on the node.

On each node, the upgrade goes like this:

1. The server sends the exact version and its npm `sha512` integrity.
2. The agent downloads that tarball and refuses it if the integrity differs. It then installs it into
   `versions/<X>` and runs `npm audit signatures` (`MAGNUS_AGENT_UPGRADE_REQUIRE_PROVENANCE`).
3. The agent checks that the new version starts, points `./current` at it, and exits.
4. The launcher starts the new version on trial. The trial passes when the new version reports one
   accepted heartbeat within `MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS` (default 180).
5. If the new version crashes twice or stays silent past the deadline, the launcher points `./current`
   back at the previous version and restarts it. The node then shows **Upgrade reverted**, with the
   reason.

The agent only writes inside its own install directory and never uses sudo. Nodes without network
access to the registry can use `MAGNUS_AGENT_UPGRADE_SOURCE_DIR` with tarballs copied to the node,
and the integrity check still applies.

Container agents (the `magnus-agent` image) do not upgrade themselves; pull a newer image instead.

## Turning automation off

If you run your own release process, set each switch you do not want:

| Switch | Where | Default | Effect when `false` |
|---|---|---|---|
| `MAGNUS_AUTO_MIGRATE` | server | `false` (`true` in `init` projects and images) | migrations run only through `magnus upgrade` or `magnus-server migrate` |
| `MAGNUS_AUTO_MIGRATE_BACKUP` | server | `true` | auto-migrate skips the dump (only if you back up another way) |
| `MAGNUS_UPDATE_CHECK` | server | `true` | no registry requests; no update notices |
| `MAGNUS_AGENT_UPGRADES` | server | `true` | the console action and `magnus-server agents upgrade` are refused |
| `MAGNUS_AGENT_SELF_UPGRADE` | agent | `true` (`false` in the agent image) | the agent refuses upgrade requests |
| `MAGNUS_LEGACY_GIT_SELF_UPDATE` | server | `false` | already off: the git pull/rebuild endpoints answer 410 |

Related settings: `MAGNUS_BACKUP_KEEP` (dumps kept, default 5), `MAGNUS_AUTO_MIGRATE_LOCK_TIMEOUT`
(seconds to wait for another instance's migration, default 600) and `MAGNUS_MIGRATE_DATABASE_URL`
(a direct connection for migrations, dumps and restores).

Do not run Watchtower or a scheduled pull against hosts you upgrade by hand.

## Release notes for maintainers

Every release documents what upgrades need to know:

- `release/<X.Y.Z>.json` holds the summary, whether the release breaks anything, the minimum version
  to upgrade from, new required and optional settings, removed settings, and the migrations the
  release ships.
- `prisma/migrations/<name>/magnus-impact.json` marks a migration `slow` or `one-way`, with a note.
  A migration without this file counts as `fast`.
- `CHANGELOG.md` lists new settings under **New environment variables** and slow or one-way
  migrations under **Migration impact**.

`npm run release:bump X.Y.Z` sets the version everywhere, and `npm run release:manifest` regenerates
the published manifest. `npm run release:manifest:check`, which also runs in `npm run verify`, fails
when any of these files disagree.
