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
   `--source DIR` with packed tarballs, for offline hosts).
2. Refuses a downgrade (use `rollback`) and a major-version change (unless `--allow-major`).
3. Checks Node.js against the release's `engines` (`^24.22.1 || ^26.13.0`).
4. Checks that your env files set every new required setting. Missing secrets can be generated with
   `--generate-secrets`; anything else must be added by hand first.
5. Installs the release into `versions/<X.Y.Z>`. The running version keeps serving.
6. If the database has pending migrations, dumps it into `backups/` with `pg_dump -Fc` and then
   migrates.
7. Runs the new version's `magnus-server check`, switches `./current`, restarts the services and
   waits until the new version answers health checks and reports itself as running.
8. If the new version is not healthy in time (`--health-timeout`, default 180 s), it switches
   `./current` back, restarts the previous version and prints the restore command for the dump.

The previous version stays installed (the newest three are kept), so going back takes seconds:

```bash
magnus rollback               # switch back to the version before the last upgrade
magnus rollback --restore-db  # also restore the pre-upgrade dump (data written since is lost)
magnus status                 # installed and serving versions, history, available updates
```

Migrations within a major version only add to the schema, so the previous version normally runs
against the migrated database. Restore the dump only if it does not, or when a release marks a
migration `one-way`.

### Adopting an existing npm install

If you installed `@hivemagnus/magnus-server` and `@hivemagnus/magnus-ui` by hand (1.0.x), turn the
install into a managed project once:

```bash
npx @hivemagnus/magnus adopt --server-env-file /etc/magnus/server.env --ui-env-file /etc/magnus/ui.env
```

Your env files stay where they are. `adopt` installs the same version under `versions/` and writes
new systemd units that point at `./current`, then prints how to switch from your old units. It
replaces your units itself only with `--install-units`.

## Manual npm install

Without a managed project, follow these steps in order:

1. Read the release notes. Add any new required settings to your env files.
2. Back up: `magnus-server backup --env-file server.env` (prints the dump file and the restore command).
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
the database and the old one does not start, restore the dump from the backups volume.

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
for that one upgrade, so an unattended pull never applies one by surprise.

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
  already current, or another major version.
- From the server host: `magnus-server agents upgrade [--to X.Y.Z] [--nodes a,b] [--dry-run]`.

One agent goes first as a canary. Once it confirms, the rest follow, a few at a time
(`MAGNUS_AGENT_UPGRADE_CONCURRENCY`). The run stops at the first agent that does not confirm.

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
