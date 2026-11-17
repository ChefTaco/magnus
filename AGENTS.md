# Agent Instructions

Magnus is the fleet and agent manager of the Hive:Magnus suite: an API server, a node agent on each
managed Linux host, shared contracts, and management of Ardent, Hermes Agent and Codex CLI agents.
[HiveXUI](https://github.com/ChefTaco/HiveXUI) is the suite's UI; Magnus keeps its own API and also
runs on its own. The current release line is 3.x: node authentication uses per-node Ed25519 keys and
`NODE_AUTH_MODE` defaults to `enforce` ([per-node credentials](docs/NODE_CREDENTIALS.md)).

These instructions apply to AI coding agents (Claude Code, Codex, Copilot and others) and to human
contributors. This is a **public repository**: everything committed, including commit messages, is
published.

## Local context

If an `AGENTS.local.md` exists in the repository root or in the directory you are working in, read it
too. It holds the maintainer's private operational context, such as hosts and deployment notes.
**Never commit it, quote it, or copy its contents into tracked files or commit messages.** The same
applies to `CLAUDE.local.md`.

## Privacy and secrets: hard rules

1. **Never commit secrets.** This includes `.env` and `.env.*` (except `.env.example`), `.npmrc`,
   private keys, certificates, `certs/`, databases (`*.db`, `*.sqlite`), backups, `state/`,
   `artifacts/`, tokens, passwords, and API keys. Each of these is already covered by `.gitignore`.
   Never force-add them (`git add -f`).
2. **Never commit private infrastructure details.** This includes real hostnames, private network
   domains (for example Tailscale MagicDNS names), IP addresses of real machines, SSH users, SSH host
   keys, home directory paths (`/home/<user>`), TLS fingerprints of real hosts, account IDs, and
   personal email addresses. Use placeholders instead:
   - hosts: `magnus.example.com`, `node-1.example.com`
   - IPs: the documentation ranges `192.0.2.0/24`, `198.51.100.0/24` and `203.0.113.0/24`, or RFC 1918
     addresses in tests
   - users: `admin` for application logins, `deploy` for SSH, `operator` for home directories
   - paths: `/opt/<package>`, `~`, `$HOME`
3. **Configuration comes from the environment.** Code reads hosts, users, and secrets from
   environment variables or config files. It never ships personal defaults or fallback secret values.
   A required secret that is missing must fail fast. Generating a strong random secret on first
   install is fine.
4. **Integrations stay optional.** Hive IAM, Hive Router, HiveMem, an external security console,
   Hermes Agent and Codex are optional. When one is not configured, the feature is off and
   everything else keeps working. Never hard-code their URLs.
5. **Keep commit messages and PR text generic.** Describe what changed in the code. Don't mention
   private machines, private projects, customers, or internal program names.
6. **Test fixtures use fake data only**, such as `example.com`, `alice@example.com`, and obviously
   fake tokens. Never use values copied from a real environment, even expired ones.
7. **When in doubt, leave it out** and ask the maintainer.

## Enforcement

Run `npm run hooks:install` once per clone. The hooks in `.githooks/` run on every commit and push:

| Hook | Checks |
|---|---|
| `pre-commit` | `scripts/check-private-data.sh --staged` (forbidden files and private terms) and `scripts/scan-secrets.sh` |
| `commit-msg` | private terms in the commit message |
| `pre-push` | all tracked files, plus the messages of every outgoing commit |

Private terms come from an optional, gitignored `.private-terms` file in the repository root. It
holds one case-insensitive extended regex per line, so the denylist itself is never published. CI
runs `npm run scan:secrets` and `npm run check:private` on every push and pull request.

**Never bypass the hooks** (`--no-verify`) or edit them to make a commit pass. If a check fails,
remove or genericize the data. If the check itself is wrong, fix the check in a separate, reviewed
change.

## Repository layout

| Path | Package | Contents |
|---|---|---|
| `apps/dashboard` | `@hivemagnus/magnus-ui` | Standalone Next.js web console for installs without HiveXUI; to be deprecated once HiveXUI's Magnus module passes acceptance |
| `services/control-api` | `@hivemagnus/magnus-server` | Hono API server: fleet inventory, desired state, jobs, audit (PostgreSQL + Redis) |
| `services/fleet-gateway` | `@hivemagnus/magnus-fleet-gateway` | Separate service that holds the restricted SSH key and carries the browser web terminal. Ships as a container image, not on npm |
| `packages/oathweave` | `@hivemagnus/magnus-oathweave` | Oathweave token verifier and identity links shared by the server and fleet gateway. Private: bundled into their tarballs, not on npm |
| `packages/agent` | `@hivemagnus/magnus-agent` | Node agent that runs on each managed host and reports to the server |
| `packages/contracts` | `@hivemagnus/magnus-contracts` | Zod schemas shared by the server, UI and agent |
| `packages/skills` | `@hivemagnus/magnus-skills` | Ubuntu operations skill catalogue (Hermes Agent compatible) |
| `packages/magnus` | `@hivemagnus/magnus` | Installer and upgrade tool (`magnus init`, `magnus upgrade`, `magnus rollback`) |
| `scripts/` | | Repository checks and release tooling ([script guide](scripts/README.md)) |
| `docs/` | | Architecture, credentials, Ardent and operations guides ([index](docs/README.md)) |
| `release/` | | Per-release manifests (`release/X.Y.Z.json`) read by the installer |
| `docker/` | | Compose file for the published server and console images |
| `tooling/` | | Builders for native Hermes Agent and Codex artifacts |

Each workspace has its own `AGENTS.md` with package-specific guidance. Read it before editing there.

## Engineering conventions

- TypeScript is strict everywhere. Match the style of the file you are editing.
- Use Zod 4 for runtime validation. Wire shapes shared between packages belong in
  `packages/contracts`; everything else stays package-local.
- Keep browser code on same-origin proxy routes, and inject secrets server-side only.
- Add or update tests with every behaviour change. Security-relevant fixes need a regression test.
- Never edit an applied Prisma migration; add a new one.
- Published packages follow semver. Note user-facing changes in `CHANGELOG.md`.
- Use Conventional Commits (`feat:`, `fix(server):`, `docs:` and so on).
- Magnus manages Ardent agents, so it tracks the latest `@hivemagnus/ardent` release. After an Ardent
  release, bump the three pins (root and agent `package.json`, agent `npm-shrinkwrap.json`), run
  `npm install` and `npm run ardent:openapi:write`, and allow any new management routes in the node
  agent. `npm run ardent:latest:check` fails while Magnus is behind.

## Gates

Run these before every commit or pull request:

```bash
npm run typecheck
npm test
npm run build
npm run openapi:check      # needs the server build
npm run docs:links         # package maps and local Markdown links; docs:check also needs a console build
npm run scan:secrets
npm run check:private
```

`npm run verify` runs everything CI runs (scans, build, typecheck, tests, skills catalogue, OpenAPI,
Ardent client, npm packs, release manifest and documentation checks). On a fresh clone, run
`npm --workspace @hivemagnus/magnus-server run db:generate` before typechecking or building the
server. `npm run lint` exists in `services/control-api` and `apps/dashboard`. The server's
integration tests need a disposable PostgreSQL database named `magnus_ideas_*` and Redis; see the
[server README](services/control-api/README.md#develop).

## Releases

Server, console, agent, contracts, skills and installer share one version. `npm run release:bump
X.Y.Z` sets every version and pin; then write `release/X.Y.Z.json` and the CHANGELOG entry and run
`npm run release:manifest`. Publication runs only from the `publish.yml` workflow on a `vX.Y.Z`
tag, after review; never `npm publish` by hand. Maintenance releases of an older line are cut from
a `release/<major>.<minor>.x` branch and published under the `maintenance-<major>.<minor>` dist-tag.
See [publishing](docs/PUBLISHING.md) and [UPGRADING.md](UPGRADING.md#release-notes-for-maintainers).

## Gotchas

- Node authentication: `NODE_AUTH_MODE` defaults to `enforce`. `compat` and `warn` (and with them
  `NODE_MANAGER_SECRET`, `RESULT_SIGNING_SECRET` and `COMMAND_RECONCILIATION_SECRET`) are deprecated,
  honoured only when set explicitly, and go away in the next major. Never add a code path that needs
  a shared node secret.
- Wire contracts that must stay byte-identical between the server and the agent
  (`security/node-request-auth.ts`, `security/node-evidence.ts`, the completion registries) are
  pinned by tests in both packages. Change both sides together.
- Upgrade problem codes live in `packages/contracts/src/upgrade-remedies.ts`;
  `node scripts/check-upgrade-remedies.mjs --write` regenerates the table in `UPGRADING.md`.
- The console's environment table in `apps/dashboard/README.md` is generated
  (`npm run docs:generate`); do not edit it by hand.
