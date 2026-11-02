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
   checks and reports itself as running. Health checks verify the certificate in each component's
   `TLS_CERT_PATH`; on an address of this machine, a missing or non-matching certificate does not
   fail them.
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
- From the server host: `magnus-server agents upgrade [--to X.Y.Z] [--nodes a,b] [--canary NODE] [--max-failures N] [--dry-run]`.

Before anything is touched, the server asks every selected agent for a read-only preflight report
(`GET /api/v1/agent-upgrade/preflight`, 16 at a time with a short timeout): layout, launcher, writable
directories, free disk, npm, whether the running version is complete, ledger health, fence high-water,
enrollment marker and compatibility with the target's `engines`. It holds that against the admission
predicates, without taking a lease. A blocked node is left out with its reason, and the others go on. An
agent older than 1.1.8 has no such route; it shows as `preflight: unavailable`, which is not a failure, and
heartbeat data is used instead. See the full report without starting anything with **Check** in the
console, `POST /api/v1/agents/upgrade` with `dryRun`, `magnus-server agents upgrade --dry-run`, or
`magnus-server agents doctor [--nodes a,b]`.

One agent goes first as a canary. Once it confirms, the rest follow, a few at a time
(`MAGNUS_AGENT_UPGRADE_CONCURRENCY`). Each node is checked again right before it is asked; a node
that became ineligible is skipped with the reason.

**Only evidence about the release stops a run.** A problem of one node never does:

- An integrity or source failure stops at once, because every node gets the same artifact.
- On the canary, a release failure stops the run and no other node is touched. A node-level problem
  hands the canary role to the next node.
- Who goes first decides who can stop the wave. The queue is: agents on 1.1.8 or later, older agents with no lease
  history, then older agents with lease history, which cannot report their fence (`FENCE_UNREPORTED`). `canaryNodeId`
  still goes first.
- While no node has confirmed, canaries that answer ambiguously stop the run after
  `MAGNUS_AGENT_UPGRADE_MAX_FAILURES` of them (at least two), with the release reported as suspect but unproven. An
  agent older than 1.1.8 can only answer a failed install as `MANAGED_MUTATION_UNCERTAIN`, so this is the only signal
  such a fleet gives about a bad release. One such node hands off as usual. A `FENCE_UNREPORTED` node has another
  explanation for its answer, a stale fence, so it does not count while any other node may still confirm. Once only those
  are left it does, so the walk stays bounded; a fleet of nothing but stale old agents also stops there, and the message
  says so.
- A first canary whose reply was lost keeps its role through its whole watch, the trial window plus ten minutes, because
  it may still be staging and restarting. A canary that answered uncertain has finished with the request, and hands off
  after the window.
- A retry of a run that stopped on ambiguity leaves older agents out (`RETRY_HELD_SUSPECTED`), so it strands no further
  lease. After reading the agent log, and running `agents fence` where needed, retry with `acknowledgeSuspicion`
  (`--acknowledge-suspicion`, or the console's "Retry older agents too").
- After the canary, the run stops when release failures (a revert, a failed install or smoke test, a
  trial that never confirms) reach `MAGNUS_AGENT_UPGRADE_MAX_FAILURES` (default 2). Override it for
  one run with `maxFailures`, `--max-failures N` or the console's "Stop after" field.
- Node-level problems are recorded and the wave goes on. Refusals that clear by themselves (unreachable,
  busy, a lock timeout, `RESOURCE_BUSY`, a fence the server just repaired, a failed eligibility check) are tried
  again at the end of the wave, up to twice, with a new request each time, and only once the last request's lease has
  settled. A retry that cannot go ahead keeps the node's original code. Anything ambiguous or release-class is never
  retried automatically.
- From 1.1.8 the agent names the cause of a failed install, reading only npm's own first `npm error code` line, how the
  process ended, and the disk itself, never text a lifecycle script could write. A bad package or a failing script stays
  `SELF_UPGRADE_FAILED` (release); disk, access, network, certificate, registry auth and memory causes have node-level
  codes. A lifecycle script killed inside npm, or hanging inside npm, cannot be told apart and reads as the package and as
  `SELF_UPGRADE_TIMEOUT` respectively. An older agent reports them all as `SELF_UPGRADE_FAILED`.

Outcomes per node:

| State | Meaning | Run |
| --- | --- | --- |
| `confirmed` | The agent reported this request's version as confirmed after its trial | continues |
| `refused` | Nothing changed on the node: the server did not send the request, or the agent declined it | continues; a refused canary hands the role to the next node |
| `watching` | The reply was lost and the node's window passed: its batch slot is free, and its reports are still read | continues |
| `ambiguous` | The run stopped watching without learning the outcome; a later report is still recorded in the run | continues |
| `reverted` | The new version did not report in time and the agent switched back | counts towards the budget; stops on the canary |
| `failed` | A release problem: integrity, source, install, or a trial that never confirmed | counts towards the budget; integrity and source stop at once |
| `skipped` | Not reached, or ineligible at its turn | — |

The run ends as one of:

| Status | Meaning |
| --- | --- |
| `succeeded` | Every selected node is confirmed or has an expected reason, such as already being on the target or an operator's switch-off. A node that reverted this version or is still on trial is not finished |
| `partial` | Some nodes need attention, and nothing points at the release. Retry takes just those nodes |
| `failed` | Evidence about the release: a release failure, even when the wave went on below the budget. Or a suspicion, shown as such: nodes that all answered ambiguously, or all refused with the same code, with nothing confirmed. A code that names a node-level cause of its own, such as a full disk, never raises one |
| `stopped` | Someone stopped it |
| `interrupted` | The server running it went away |

`magnus-server agents upgrade` exits 0 for `succeeded`, 2 for `partial` and 1 otherwise. The summary lists
each node needing attention with a code, the cause and a specific remedy. A report that arrives later still
updates the run: a lost reply that finally confirms turns `partial` into `succeeded`.

- **Stop**: the console's Stop button, `POST /api/v1/agents/upgrade/runs/<id>/stop` or
  `magnus-server agents stop <id>` stops the run before its next batch. Ctrl-C in
  `magnus-server agents upgrade` does the same; a second Ctrl-C leaves at once.
- **Interrupted runs**: the server (or CLI) that runs an upgrade renews a lease on it. If it
  restarts or is killed, the run shows as `interrupted` within a few minutes, its asked nodes are
  settled from their last heartbeat report, and a new run can start. A report that arrives later
  for such a node is still recorded into the run.
- **Retry**: the console's Retry button, `POST /api/v1/agents/upgrade/runs/<id>/retry` or
  `magnus-server agents upgrade --retry <id>` starts a new run with the same version and integrity
  for the nodes that were not upgraded, including those the check held back. Nodes that reverted
  this version are only offered again with `allowRetryReverted` (`--retry-reverted`).
- Prerelease versions need `allowPrerelease` (`--allow-prerelease`). A target the registry does not
  have is shown as unverified.
- The server waits for each agent's own trial window (`MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS`, which
  1.1.3 agents report), two heartbeats and a restart margin, counted from the reply to the request, so
  staging time does not eat it.

If the reply to an upgrade request is lost, the server keeps watching: the agent's heartbeat report
for that request decides, and the node gives up its batch slot once its window has passed. When the node
confirms, the server reads the signed receipt of that request, which settles its command lease. If it never
reports, the lease (`agent-upgrade-<requestId>`) stays `unknown` until reconciled with signed evidence:
`POST /api/v1/commands/agent-upgrade-<requestId>/reconcile-resource` adopts the agent's signed receipt (see
docs/COMMAND_RESOURCE_LEASES.md).

**Upgrade readiness.** On a versioned, enabled agent, node pages and the node list also show whether a node could take an upgrade now,
all the time and not only when one starts: an enrollment stuck draining and for how long, a marker the
server does not share, a fence ahead of the server, an unresolved ledger, low disk, missing npm. A node that
has not been ready for 24 hours raises a notification (`node.upgrade_not_ready`), unless `MAGNUS_AGENT_UPGRADES=false`.
The readiness monitor keeps settling stuck leases either way.

### When an agent can't be upgraded

Every problem has a code. The console, the CLI and this table read the same catalogue
(`packages/contracts/src/upgrade-remedies.ts`). "Tried again" clears by itself in most cases; "ambiguous"
means the request may have run, so it is never repeated automatically.

<!-- upgrade-remedies:start -->
| Code | Kind | Cause | Remedy |
|---|---|---|---|
| `SELF_UPGRADE_INTEGRITY` | release, stops at once | The downloaded tarball does not match the pinned npm integrity. | Do not retry. Check the registry or MAGNUS_AGENT_UPGRADE_SOURCE_DIR, and the integrity passed to the run. |
| `SELF_UPGRADE_SOURCE` | release, stops at once | The tarball is missing from MAGNUS_AGENT_UPGRADE_SOURCE_DIR. | Copy the exact tarball to that directory on the nodes, then retry. |
| `SELF_UPGRADE_FAILED` | release | The package itself failed on the node: a bad tarball, an install error, missing provenance or a smoke test that failed or hung. An agent older than 1.1.8 also reports environment causes this way. | Read the detail and the agent log. If several nodes fail the same way, the release is at fault. |
| `SELF_UPGRADE_REVERTED` | release | The new version crashed or stayed silent during its trial, and the launcher switched back. | Read the reason on the node and in the agent log. To try again, retry with allowRetryReverted (--retry-reverted). |
| `CONFIRM_TIMEOUT` | release | The agent accepted the request, but the new version was not confirmed within its trial window. | Read the agent log on the node. A later report for this request is still recorded in the run. |
| `AGENT_SILENT` | release | The agent accepted the request and then stopped sending heartbeats. | Check the service on the node. The launcher switches back by itself if it is running. |
| `MUTATION_OUTCOME_UNKNOWN` | node, ambiguous | The request was sent and no usable answer came back. | The run keeps watching the node by request id. If it never reports, check the node, then reconcile the lease of the request (agent-upgrade-<requestId>). |
| `MANAGED_MUTATION_UNCERTAIN` | node, ambiguous | The agent cannot say whether a managed request ran. Any version answers this when a handler failed after it may have started; an agent older than 1.1.8 also answers it for every refusal, whatever the real cause. The command lease stays unknown and blocks later managed requests on this node. | Read the agent log for the real cause. If the agent holds a receipt for the command (agent-upgrade-<requestId>), settle it with signed evidence: POST /api/v1/commands/<id>/reconcile-resource. If it holds none, an agent older than 1.1.8 offers no way out: upgrade that agent by hand on the node, after which the readiness monitor or `magnus-server agents doctor --heal` can settle the lease. If the cause was a stale fence, first run `magnus-server agents fence NODE VALUE`, or the next request fails the same way. |
| `OUTCOME_UNKNOWN` | node, ambiguous | The agent ledger holds an unresolved receipt for this command. | Inspect the receipt and reconcile it with signed evidence (docs/COMMAND_RESOURCE_LEASES.md). |
| `RUN_INTERRUPTED` | node, ambiguous | The server stopped watching this node when the run was interrupted. | A later report is recorded in the run. If the node does not report, retry it. |
| `SELF_UPGRADE_ENV_NETWORK` | node, tried again | The node could not reach the registry while fetching the new version. | Check the path from the node to the registry, or use MAGNUS_AGENT_UPGRADE_SOURCE_DIR, then retry it. |
| `AGENT_UNREACHABLE` | node, tried again | The server could not open a connection to the agent. | Check that the agent is running and that its address and port in the inventory are correct. |
| `SELF_UPGRADE_BUSY` | node, tried again | The agent is already staging an upgrade or another process holds its upgrade lock. | Wait for it to finish, then retry the node. |
| `RESOURCE_BUSY` | node, tried again | Another command owns the single execution slot on the node. | Wait for the command to finish, then retry the node. |
| `RESOURCE_LEASE_CONFLICT` | node, tried again | The server holds another unsettled command lease for the node. | Wait for it to settle. If it stays `unknown`, run `magnus-server agents doctor --heal` or reconcile it. |
| `ENROLLMENT_AUTHORITY_UNAVAILABLE` | node, tried again | The agent could not reach the server to confirm its enrollment. | Check the path from the node to the server (CONTROL_API_URL, TLS trust). |
| `STALE_FENCE` | node, tried again | The agent holds a resource fence at least as high as the one the server sent, and refused without running anything. | The server repairs this by itself by moving its generation up, and tries the node again. Nothing to do unless the problem persists. |
| `LEASE_EXPIRED` | node, tried again | The command lease expired before the agent could start it; nothing ran. | Retry the node. If this repeats, compare the clocks of the node and the server. |
| `NOT_DISPATCHED` | node, tried again | The server did not send the request. | Read the detail, then retry the node. |
| `CHECK_FAILED` | node, tried again | The server could not check this node right before asking it, so it did not ask. | Read the detail, usually a database or Redis problem on the server, then retry the node. |
| `AGENT_SILENT_AFTER_LOST_REPLY` | node, ambiguous | The request may or may not have arrived, and the agent has stopped sending heartbeats. | Check the service on the node. A later report for this request is still recorded in the run. |
| `FENCE_UNREPORTED` | node | This agent is older than 1.1.8, has handled managed requests before, and cannot say what fence it holds. If that fence is ahead of the server, its request fails as MANAGED_MUTATION_UNCERTAIN and strands a lease. | Before the wave, read .magnus/command-receipts/fence-*.json on the node and run `magnus-server agents fence NODE VALUE`. Nothing to do if the fence is not ahead. |
| `LEDGER_MISSING` | node | The agent has no command ledger, so its "no receipt" proves nothing about a lease held for it. The ledger may have moved, or the install may have been rebuilt. | Check AGENT_INSTALL_DIR and restore .magnus/command-receipts if it moved; the lease then settles by itself. If it is gone, Magnus has no way to settle the lease: establish by hand what the command did, then change the lease row in the database yourself. |
| `LEDGER_NO_FENCE` | node | The agent ledger holds neither a fence nor this node's enrollment marker, so nothing shows it is the ledger this command would have used. | Check whether .magnus/command-receipts was replaced, and restore it if so; the lease then settles by itself. If it cannot be restored, Magnus has no way to settle the lease: establish by hand what the command did, then change the lease row in the database yourself. |
| `LEDGER_EVIDENCE_INCONSISTENT` | node | The agent ledger accepted this lease's fence, but holds no receipt, no claim and no record of a failed admission for it. Either a receipt was removed, or an admission failed on an agent build that kept no such record. | Inspect .magnus/command-receipts on the node and the agent log around the lease's time. Magnus has no way to settle the lease: establish by hand what the command did, then change the lease row in the database yourself. |
| `ENROLLMENT_MARKER_UNKNOWN` | node | The agent could not read its managed-enrollment marker, so a mismatch cannot be ruled out. | Check .magnus/command-receipts/managed-enrollment.json on the node: its mode, owner and content. |
| `SELF_UPGRADE_ENV_TLS` | node | npm would not trust the registry's certificate on this node: a wrong clock, an expired certificate or an intercepting proxy. | Check the clock on the node and its CA trust for the registry, then retry it. |
| `SELF_UPGRADE_ENV_AUTH` | node | The registry refused this node's request (401 or 403). | Check the npm credentials and registry settings on the node, or use MAGNUS_AGENT_UPGRADE_SOURCE_DIR, then retry it. |
| `SELF_UPGRADE_ENV_RESOURCE` | node | The node ran out of memory or file handles, npm was killed, or a file was busy. A killed npm is told apart by how the process ended; a lifecycle script killed inside npm still reads as a package fault. | Check the memory on the node and its kernel log, then retry it. |
| `RETRY_HELD_SUSPECTED` | node | The run this one retries stopped because older agents answered ambiguously with nothing confirmed. Each further attempt on an older agent can strand another lease, so this retry leaves them alone. | Read the agent log of the nodes that answered, and run `magnus-server agents fence NODE VALUE` where a fence is ahead. Then retry with acknowledgeSuspicion (--acknowledge-suspicion). |
| `SELF_UPGRADE_ENV_DISK` | node | The node ran out of disk space or quota, or hit an I/O error, while installing the new version. | Free disk space on the node, then retry it. |
| `SELF_UPGRADE_ENV_ACCESS` | node | The node refused a write while installing the new version. | Run `sudo magnus-agent install-service` again on the node, which repairs ownership, then retry it. |
| `RESOURCE_ENROLLMENT_REQUIRED` | node | Admission refused the request because the node's resource enrollment is not complete. | Complete the node's resource enrollment (docs/COMMAND_RESOURCE_LEASES.md). |
| `FENCE_OVERFLOW` | node | The agent reports a resource fence above the highest value the server will adopt. | Stop the agent, inspect .magnus/command-receipts/fence-*.json on the node, and repair that file by hand. The server does not change its generation. |
| `FENCE_INVALID` | node | The agent reports a resource fence that is not a decimal value for its own node. | Inspect .magnus/command-receipts/fence-*.json on the node. |
| `FENCE_AHEAD` | node | The agent holds a resource fence above the server generation, so managed requests would be refused. | Nothing to do for an upgrade run: it repairs this at its start. `magnus-server agents doctor --heal` repairs it now. |
| `IDEMPOTENCY_CONFLICT` | node | The agent already has a receipt for this command identifier with different input. | Retry the node, which uses a new identifier, and report the conflict if it repeats. |
| `LEDGER_UNAVAILABLE` | node | The agent could not read or write its command ledger. | Check ownership, mode 0700 and free space of .magnus/command-receipts on the node. |
| `LEDGER_UNRESOLVED` | node | The agent ledger holds a command with an unresolved outcome, which blocks every later managed request. | Reconcile that command with signed evidence (docs/COMMAND_RESOURCE_LEASES.md). |
| `LEASE_HELD` | node | A command lease on the node is reserved, running or unknown. | Wait for it to finish. On a 1.1.8 agent, a lease stuck `unknown` with no receipt is settled by the readiness monitor, a run, or `magnus-server agents doctor --heal`; one with a receipt needs signed reconciliation. On an older agent, see MANAGED_MUTATION_UNCERTAIN. |
| `WORK_HELD` | node | Participant work, such as a console terminal or SSH session, is still held on the node. | Finish or reconcile that work, then retry the node. |
| `UNMANAGED_MUTATION` | node | The agent is enrolled for managed requests and refused a request without a valid claim. | Complete the node's resource enrollment on the server (docs/COMMAND_RESOURCE_LEASES.md), or upgrade the agent by hand. |
| `RESOURCE_CLAIM_INVALID` | node | The server would not confirm the agent's claim for this request. | Check the enrollment and inventory host name of the node, then retry. |
| `RESOURCE_TARGET_INVALID` | node | Admission refused the node: its inventory address changed or its health is not fresh. | Wait for a fresh heartbeat, or repair the inventory address. |
| `ADMISSION_FENCE_CLOSED` | node | A server release closed admission to this node. | Release the admission fence (POST /api/v1/resource-leases/admission/<nodeId>/release). |
| `ENROLLMENT_MISSING` | node | Resource leases apply to this node but it is not enrolled. | Enroll the node (docs/COMMAND_RESOURCE_LEASES.md). |
| `ENROLLMENT_DRAINING` | node | The node's resource enrollment is stuck in draining. | Finish the drain: POST /api/v1/resource-leases/enrollment/<nodeId>/complete. |
| `ENROLLMENT_HOST_MISMATCH` | node | The enrollment names another host than the inventory. | Correct the host name of the node in the inventory. |
| `ENROLLMENT_INCOMPLETE` | node | The node's resource enrollment is not complete. | Enroll the node (docs/COMMAND_RESOURCE_LEASES.md). |
| `ENROLLMENT_MARKER_MISMATCH` | node | The agent holds a local managed-enrollment marker the server does not share. | Complete the node's resource enrollment on the server (docs/COMMAND_RESOURCE_LEASES.md), or upgrade the agent by hand. |
| `NODE_OFFLINE` | node, tried again | The node is offline or has no recent heartbeat. | Bring the agent back, then retry the node. |
| `NODE_NOT_FOUND` | node | The node is no longer in the inventory. | Register the node again if it should be managed. |
| `VERSION_UNKNOWN` | node | The agent has not reported a usable version. | Wait for a heartbeat, or upgrade the agent by hand. |
| `SELF_UPGRADE_TIMEOUT` | node | An npm step of the upgrade did not finish in its time budget on the node. A new version that hangs when it is run reports SELF_UPGRADE_FAILED instead. A lifecycle script that hangs inside npm also ends up here: it cannot be told apart. | Check the network and disk speed of the node, then retry it. If every node hangs the same way, suspect the release. |
| `SELF_UPGRADE_UNAVAILABLE` | node | The agent cannot upgrade itself now: its layout, launcher, directories or npm are not usable. | Read the detail. Running `sudo magnus-agent install-service` once on the node usually repairs it. |
| `SELF_UPGRADE_LAUNCHER` | node | The new version needs a newer launcher than the node has. | Run `sudo magnus-agent install-service` once on the node. |
| `SELF_UPGRADE_ENGINE` | node | The new version does not support the Node.js on this node. | Upgrade Node.js on the node. |
| `SELF_UPGRADE_PACKAGE` | node | The agent refused to install a package other than magnus-agent. | Report this: the server sent an unexpected package name. |
| `SELF_UPGRADE_REFUSED` | node | The agent refused the version change. | Read the detail. Crossing a major version is done by hand. |
| `PREFLIGHT_NOT_WRITABLE` | node | The agent cannot write to its install directory. | Run `sudo magnus-agent install-service` again on the node, which repairs ownership. |
| `PREFLIGHT_DISK_LOW` | node | The install directory has less free space than an upgrade needs. | Free disk space on the node. |
| `PREFLIGHT_NPM` | node | npm is missing on the node or too old. | Install npm beside the agent's Node.js, or set MAGNUS_AGENT_NPM. |
| `PREFLIGHT_FROM_INCOMPLETE` | node | The running version is not complete under versions/, so a failed upgrade could not switch back. | Run `sudo magnus-agent install-service` again on the node. |
| `PREFLIGHT_ENGINE` | node | The target version does not support the Node.js on this node. | Upgrade Node.js on the node. |
| `NOT_REACHED` | node | The run ended before it reached this node. | Retry the run, once what ended it is dealt with. This node was not asked and did not change. |
| `RUN_STOPPED` | node | Someone stopped the run before it reached this node. | Retry the run when you want this node upgraded. This node was not asked and did not change. |
| `NOT_ELIGIBLE` | node | This node became ineligible at its turn, for a reason without a code of its own. | Read the detail, then retry the node. |
| `ALREADY_CURRENT` | expected | The node already runs the target version. | Nothing to do. |
| `SELF_UPGRADE_CURRENT` | expected | The agent already runs the target version. | Nothing to do. |
| `DOWNGRADE` | expected | The node runs a newer version than the target. | Nothing to do, or choose a newer target. |
| `MAJOR_VERSION` | expected | The change crosses a major version. | Upgrade this node by hand. |
| `NOT_SELF_UPGRADABLE` | expected | This agent cannot upgrade itself: it is too old, or not set up with the launcher. | Run `sudo magnus-agent install-service` once on the node. |
| `PROTOCOL_TOO_OLD` | expected | The agent speaks an older self-upgrade protocol. | Upgrade this agent by hand. |
| `SELF_UPGRADE_DISABLED` | expected | An operator switched self-upgrade off on this node, or it runs in a container or the legacy layout. | Nothing to do if that is intended. Otherwise set MAGNUS_AGENT_SELF_UPGRADE=true, pull a newer image, or run `sudo magnus-agent install-service` once. |
| `UPGRADE_IN_PROGRESS` | node | An upgrade is staged or on trial on this node, and it can still switch back. | Wait for its trial to end, then retry the node if it did not confirm. |
| `ALREADY_REVERTED` | node | This node already switched back from this exact version. | Read the reason. To try again, use allowRetryReverted (--retry-reverted). |
| `PREFLIGHT_UNAVAILABLE` | expected | An agent older than 1.1.8 has no preflight check; heartbeat data is used instead. | Nothing to do: the agent gains the check when it is upgraded. |
| `PREFLIGHT_UNREACHABLE` | expected | The preflight check got no answer. The node stays in the run, and dispatch decides. | Nothing to do unless the node then fails with AGENT_UNREACHABLE. |
<!-- upgrade-remedies:end -->

**Fences.** A fence is an ordering token the server owns, and the agent refuses anything at or below what it
last saw. An agent can be ahead after a database restore, or because an older build wrote timestamp-style
values. The agent then refuses with `STALE_FENCE` and says what it holds, without running anything. A
preflight or such a refusal moves the server's generation to that value + 1, under the node's admission lock
and audited as `agent.fence.advanced`. It only ever moves up. Only the node's own keys and decimal values
below a cap are accepted, so a malicious agent can only inflate its own counter. Above the cap the server
changes nothing and reports `FENCE_OVERFLOW`.

An agent older than 1.1.8 does not say what it holds: it answers `MANAGED_MUTATION_UNCERTAIN`, and the server
has to treat that as ambiguous. If such a node has a high fence, read it from
`.magnus/command-receipts/fence-*.json` on the node and raise the server side first:
`magnus-server agents fence NODE VALUE`. It only moves up, and it is audited. A run warns before the wave about
each selected node that cannot report its fence and has lease history (`FENCE_UNREPORTED`).

**Leases stuck `unknown`.** A 1.1.8 agent reports a refusal it can prove with a signature bound to the
request, the lease and the node, and the lease settles as `not-dispatched`. For a lease already stuck, the readiness
monitor (once an hour per node), a run or `magnus-server agents doctor --heal` asks a 1.1.8 agent, a minute past the
lease's deadline, what its ledger holds for that command. Only a signed account with no receipt, from a ledger that
shows it is this node's, settles it, audited as `agent.lease.recovered`; see docs/COMMAND_RESOURCE_LEASES.md for exactly what
proves what. A receipt leaves signed reconciliation as the only way out.

**What stays stuck, and the way out.** `LEDGER_MISSING`, `LEDGER_NO_FENCE` (no fence and no marker) and
`LEDGER_EVIDENCE_INCONSISTENT` (the fence accepted, with no receipt, claim or record of a failed admission) stay held, and no
signed reconciliation applies, since the agent refuses to reconcile a command it has no receipt for. Restore the ledger if it
moved, and the lease settles by itself. Otherwise Magnus has no way out: someone has to establish what the command did on the
node and change the lease row in the database by hand.

**There is no automatic way out on an older agent.** A lease stranded by an agent older than 1.1.8 with no receipt stays
held: it cannot be reconciled, since there is nothing to reconcile, and it blocks managed requests on that node, an upgrade
request included. The way out is to upgrade that agent by hand on the node. The monitor or `agents doctor --heal` can
then settle the lease.

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
