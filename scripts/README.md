# Repository scripts

Run these from the repository root after `npm ci`. The root `package.json` is the command
catalogue; each package README lists its own build and test commands.

| Task | Command | Script |
| --- | --- | --- |
| Everything CI runs | `npm run verify` | Secret and private-data scans, build, typecheck, tests, skills catalogue, OpenAPI, Ardent client types, npm packs, documentation and cleanup tests |
| Secret scan | `npm run scan:secrets` | `scan-secrets.sh`: provider tokens, literal credentials and private infrastructure in working files and the Git index; findings redact values |
| Publication safety tests | `npm run privacy:test` | Scanner, staged-content, npm-content, clean-build, publication-environment, release-tag and registry-failure regressions |
| Private-data scan | `npm run check:private` | `check-private-data.sh`: forbidden files plus the patterns in the optional, gitignored `.private-terms` file. `--staged` checks only staged files (used by the pre-commit hook). |
| Install git hooks | `npm run hooks:install` | Points `core.hooksPath` at `.githooks/` |
| OpenAPI contract | `npm run openapi:check` | `check-openapi-contract.mjs`: the server's OpenAPI document is valid 3.1 and every operation has a summary, tags and responses. Needs a server build. |
| npm package contents | `npm run check:packs` | `check-npm-packs.mjs`: dry-runs `npm pack` for every published package, checks required files, and scans file names and contents for credentials, private infrastructure and local state |
| Context-only runtime adoption | `npm run ardent:context:integration` | Offline container acceptance against an older published Ardent runtime; compaction, recovery, real gateway restarts and runtime rollback with a synthetic provider |
| Skills catalogue | `npm run skills:check` | The generated `SKILL.md` files match their manifests |
| Swallowed failure reasons | `npm run check:reasons` | `check-swallowed-reasons.mjs`: a bare `catch` that answers an HTTP error in the upgrade, ledger, managed-http, enrollment and scheduler paths must log its cause (tests: `npm run reasons:test`) |
| Upgrade remedies | `npm run check:remedies` | `check-upgrade-remedies.mjs`: the problem-code table in `UPGRADING.md` matches `packages/contracts/src/upgrade-remedies.ts` (`--write` regenerates it) |
| Ardent client types | `npm run ardent:openapi:check` | `check-ardent-openapi.mjs`: `packages/contracts/src/ardent-openapi.ts` matches the pinned `@hivemagnus/ardent` (`npm run ardent:openapi:write` regenerates it) |
| Ardent pin is current | `npm run ardent:latest:check` | `check-ardent-latest.mjs`: fails while the pinned `@hivemagnus/ardent` is behind npm's latest (tests: `npm run ardent:latest:test`) |
| Version bump | `npm run release:bump X.Y.Z` | `bump-version.mjs`: every workspace version, internal pins, `agent-version.json`, the lockfile, the release manifest and a CHANGELOG stub |
| Release manifest | `npm run release:manifest` / `npm run release:manifest:check` | `check-release-manifest.mjs`: writes or checks `magnusRelease` in `packages/magnus/package.json` from `release/X.Y.Z.json` (tests: `npm run release:test`) |
| Native artifacts | `npm run test:native-artifact`, `npm run build:native-agent` | Native agent, Hermes Agent and Codex artifact builders and their tests (see `tooling/`) |
| Lockfile | `npm run lockfile:check` | `validate-lockfile.mjs`: `package-lock.json` agrees with every workspace manifest and each registry package has an integrity hash; the agent, server and console shrinkwraps pin public registry artifacts, and the server and console ones honour every exact override |
| Server and console locks | `npm run locks:generate` / `npm run locks:refresh` | `package-locks.mjs`: regenerates the standalone, production-only `npm-shrinkwrap.json` of the server and console from the workspace lock (network; review the diff), or moves only their version and sibling pins to the local packs (offline, the release-bump step). `--check` runs in `npm run check:packs` (tests: `test-package-locks.mjs`) |
| Packed server and console | `node scripts/check-packed-server.mjs` | Installs each packed tarball as its image does (`shrinkwrap-install-lock.mjs`) and requires the server's installation report to find no dependency that differs from the shipped lock. Part of `npm run check:packs` |
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

`check-publish-environment.mjs` is used by the npm publication workflow. With
`GITHUB_REPOSITORY` and a read-only `GH_TOKEN`, it verifies that the
`npm-publish` environment has an actual required reviewer. A missing rule or
an unreadable environment blocks publication. It does not publish anything.

`publish-packages.mjs` is the final workflow step. `DRY_RUN=true` inspects all
six built packages. `DRY_RUN=false` requires a matching `GITHUB_REF` version
tag, aligned release metadata and successful registry checks before it calls
`npm publish --provenance`. See [publication setup](../docs/PUBLISHING.md) for
review and authentication prerequisites. The workflow's explicit bootstrap
mode supplies its temporary environment credential only to that final step;
tag pushes and dry runs use no bootstrap credential.

## Local cleanup

`clean-local.mjs` removes only regenerable Python caches and test report directories
(`test-results`, `playwright-report`, `blob-report`). It skips symlinks and directories that
contain tracked files, and it never touches `node_modules`, build output (`.next`, `dist`),
`output/`, `artifacts/`, certificates, profile or agent state, or environment files. Without
`--apply` it only lists what it would remove.
