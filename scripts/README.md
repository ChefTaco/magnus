# Repository scripts

Run these from the repository root after `npm ci`. The root `package.json` is the command
catalogue; each package README lists its own build and test commands.

| Task | Command | Script |
| --- | --- | --- |
| Everything CI runs | `npm run verify` | Secret and private-data scans, build, typecheck, tests, skills catalogue, OpenAPI, Ardent package, npm packs, documentation and cleanup tests |
| Secret scan | `npm run scan:secrets` | `scan-secrets.sh` |
| Private-data scan | `npm run check:private` | `check-private-data.sh`: forbidden files plus the patterns in the optional, gitignored `.private-terms` file. `--staged` checks only staged files (used by the pre-commit hook). |
| Install git hooks | `npm run hooks:install` | Points `core.hooksPath` at `.githooks/` |
| OpenAPI contract | `npm run openapi:check` | `check-openapi-contract.mjs`: the server's OpenAPI document is valid 3.1 and every operation has a summary, tags and responses. Needs a server build. |
| npm package contents | `npm run check:packs` | `check-npm-packs.mjs`: dry-runs `npm pack` for every published package and checks that its entry points, README and LICENSE are included and that nothing resembling secrets or local state is |
| Lockfile | `npm run lockfile:check` | `validate-lockfile.mjs`: `package-lock.json` agrees with every workspace manifest and each registry package has an integrity hash |
| Documentation | `npm run docs:check` | `check-repository-docs.mjs` and `check-documentation.mjs`. Needs a console build (`npm run dashboard:build`). |
| Documentation, no build | `npm run docs:links` | `check-repository-docs.mjs`: package guides, package maps and local Markdown links |
| Documentation check tests | `npm run docs:test` | `test-repository-docs.mjs` |
| Console environment table | `npm run docs:generate` | `generate-documentation.mjs`: regenerates the table in `apps/dashboard/README.md` |
| TLS endpoint | `npm run tls:check -- HOST PORT` | `check-tls-endpoint.mjs`: system trust, hostname and minimum expiry |
| TLS bypasses | `node scripts/check-tls-bypasses.mjs` | Fails when code disables TLS verification |
| Console screenshots | `node scripts/capture-dashboard-screenshots.mjs` | Captures console pages from `PLAYWRIGHT_BASE_URL` into `output/playwright/` |
| Preview local cleanup | `npm run clean:local` | `clean-local.mjs` |
| Apply local cleanup | `npm run clean:local -- --apply` | `clean-local.mjs` |
| Cleanup tests | `npm run clean:local:test` | `test-clean-local.mjs` |

`start-ui-ci.mjs` starts the console for the Playwright CI configuration
(`npm run verify:ui:ci`).

## Local cleanup

`clean-local.mjs` removes only regenerable Python caches and test report directories
(`test-results`, `playwright-report`, `blob-report`). It skips symlinks and directories that
contain tracked files, and it never touches `node_modules`, build output (`.next`, `dist`),
`output/`, `artifacts/`, certificates, profile or agent state, or environment files. Without
`--apply` it only lists what it would remove.
