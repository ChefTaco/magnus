# Agent Instructions

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
| `apps/dashboard` | `@hivemagnus/magnus-ui` | Next.js web console for fleets, nodes, jobs, Hermes Agent and Ardent |
| `services/control-api` | `@hivemagnus/magnus-server` | Hono API server: fleet inventory, desired state, jobs, audit (PostgreSQL + Redis) |
| `packages/agent` | `@hivemagnus/magnus-agent` | Node agent that runs on each managed host and reports to the server |
| `packages/ardent` | `@hivemagnus/ardent` | Headless TypeScript agent runtime with A2A, jobs, skills and channel adapters |
| `packages/contracts` | `@hivemagnus/magnus-contracts` | Zod schemas shared by the server, UI and agent |
| `packages/skills` | `@hivemagnus/magnus-skills` | Ubuntu operations skill catalogue (Hermes Agent compatible) |
| `scripts/` | | Repository checks |
| `docs/` | | Architecture and integration notes |

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

## Gates

Run these before every commit or pull request:

```bash
npm run typecheck
npm test
npm run build
npm run openapi:check
npm run scan:secrets
npm run check:private
```
