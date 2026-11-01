# @hivemagnus/magnus

Install, upgrade and roll back a [Magnus](https://github.com/ChefTaco/magnus) server and console
with one command.

```bash
npx @hivemagnus/magnus init       # create and start a project in ~/.magnus
magnus upgrade                    # newest release of the current major, with backup and auto-revert
magnus rollback                   # back to the previous version
magnus status                     # versions, health, history, available updates
```

Each release of this package pins exact, tested versions of `@hivemagnus/magnus-server`,
`@hivemagnus/magnus-ui` and `@hivemagnus/magnus-contracts`, together with the matching agent
version. The pins and release notes ship as `magnusRelease` in `package.json`.

## `magnus init`

`init` creates a managed project: the configuration, the installed versions and the units that run
them.

```
~/.magnus/
  magnus-project.json            project state and history
  package.json, package-lock.json  exact pins of the serving release
  config/magnus-server.env       generated secrets (0600)
  config/magnus-ui.env
  config/tls/                    self-signed certificate (unless --tls-cert/--tls-key)
  versions/1.1.0/                one npm install per release
  current -> versions/1.1.0      what the services run
  backups/                       pre-migration database dumps
  units/                         the generated systemd units
  deps.compose.yml               PostgreSQL and Redis, when no --database-url/--redis-url is given
```

| Option | Meaning |
|---|---|
| `--system --service-user NAME` | System units in `/opt/magnus` (run as root) instead of user units |
| `--database-url URL --redis-url URL` | Use your own PostgreSQL and Redis instead of the bundled compose file |
| `--version X.Y.Z` | Install a specific release |
| `--public-host NAME` | Host name for URLs and the certificate |
| `--admin-user`, `--admin-password` | Console login (the password is generated and printed once by default) |
| `--no-ui`, `--no-start`, `--no-auto-migrate` | Server only; configure without starting; keep `MAGNUS_AUTO_MIGRATE=false` |
| `--supervisor none` | Write everything, but start the processes yourself |

User services start at boot only with lingering enabled (`loginctl enable-linger $USER`).

## `magnus upgrade`

```bash
magnus upgrade --dry-run     # releases, notes, new settings and migrations, without changing anything
magnus upgrade [--to X.Y.Z] [--yes] [--generate-secrets] [--allow-major] [--source DIR]
```

An upgrade:

1. Checks the registry and the Node.js engines.
2. Refuses a downgrade or a major-version change (unless `--allow-major`).
3. Checks for new required settings.
4. Installs the release into `versions/<X>`.
5. Dumps PostgreSQL, migrates and checks.
6. Switches `./current`, restarts and waits for the new version to serve.
7. If the new version is unhealthy, switches back and prints the database restore command.

Slow or one-way migrations need `--yes`.

`magnus-server upgrade` hands the same command to the project it was installed into.

## `magnus adopt`

Turns an existing npm install into a managed project without touching what runs:

```bash
npx @hivemagnus/magnus adopt --server-env-file /etc/magnus/server.env --ui-env-file /etc/magnus/ui.env
```

See [UPGRADING.md](https://github.com/ChefTaco/magnus/blob/main/UPGRADING.md) for every upgrade
path, agent upgrades and the switches that turn automation off.

Requires Node.js `^24.22.1` or `^26.13.0`, npm, systemd (or `--supervisor none`), and `openssl` for
the self-signed certificate.

## License

Apache-2.0
