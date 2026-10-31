# Contributing to Magnus

Thanks for your interest in improving Magnus! Bug reports, documentation fixes, and pull requests
are all welcome.

## Getting set up

```bash
nvm use               # Node.js version from .nvmrc
npm ci                # installs every workspace
npm run hooks:install # privacy and secret checks on commit and push
npm run build
```

The repository is an npm workspaces monorepo:

| Path | Package |
|---|---|
| `apps/dashboard` | `@hivemagnus/magnus-ui` |
| `services/control-api` | `@hivemagnus/magnus-server` |
| `packages/agent` | `@hivemagnus/magnus-agent` |
| `packages/ardent` | `@hivemagnus/ardent` |
| `packages/contracts` | `@hivemagnus/magnus-contracts` |
| `packages/skills` | `@hivemagnus/magnus-skills` |

The server's integration tests need PostgreSQL and Redis. `services/control-api/docker/compose.yml`
starts both.

## Before opening a pull request

Run the same gates that CI runs:

```bash
npm run typecheck
npm test
npm run build
npm run openapi:check
npm run scan:secrets
npm run check:private
```

- Keep TypeScript strict and follow the style of the surrounding code.
- Add or update tests for behaviour changes.
- If you change an HTTP route or schema, update the OpenAPI snapshot so `npm run openapi:check`
  passes.
- Never commit `.env` files, keys, certificates, databases, or other credentials, or details of
  private infrastructure (real hostnames, IPs, usernames, home paths). The git hooks in `.githooks/`
  enforce this. See [AGENTS.md](AGENTS.md) for the full rules, which apply to people and AI agents
  alike.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`,
`chore:` and so on), with an optional scope such as `fix(server): ...`.

## Reporting bugs and requesting features

Open a GitHub issue using one of the templates. For security issues, follow
[SECURITY.md](SECURITY.md) and do **not** open a public issue.

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
