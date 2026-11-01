# AGENTS.md - magnus (installer and upgrade tool)

Read the repository root `AGENTS.md` first. Its privacy rules apply here too.

## Purpose

`packages/magnus` (`@hivemagnus/magnus`, bin `magnus`) creates managed projects
(`init`, `adopt`) and upgrades and rolls them back (`upgrade`, `rollback`,
`status`). Each release pins the exact component versions in
`package.json#magnusRelease`, which `npm run release:manifest` generates.
Never edit that field by hand.

## Rules

- **Safety rules are not optional.**
  - Never cross a major version without `--allow-major`.
  - Never migrate without a backup.
  - Always switch back automatically when the new version is unhealthy.
  - Print the exact restore command whenever the database may need one.
- Every side effect goes through `Io` (`src/io.ts`), so the engine stays
  testable with a scripted host. Never call `child_process` or `fetch` directly.
- Keep `magnus-project.json` backwards compatible. Bump `schema` only together
  with a migration of older projects.
- When the hand-over between engine versions changes, bump `ENGINE_PROTOCOL` in
  `src/release.ts` and `scripts/check-release-manifest.mjs` together.
- The package has no runtime dependency on the server or the console. It drives
  their CLIs inside `versions/<X>`.
- Never sudo or write outside the project directory, except for the systemd
  unit directory the operator chose (`--system` needs root and says so).
- Generated files never contain real hosts or credentials beyond the values
  `init` generated for this project.

## Commands

From the repository root:

```bash
npm --workspace @hivemagnus/magnus run typecheck
npm --workspace @hivemagnus/magnus test
npm --workspace @hivemagnus/magnus run build
```
