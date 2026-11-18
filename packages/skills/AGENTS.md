# AGENTS.md - Magnus Skills

This package publishes Ubuntu operations skills to Hermes Agent profiles.
The Control API reads `skills/index.json` for `/api/v1/orchestra/skill-catalog`.
`magnus-agent` reconciles selected bundles onto each managed host. Keep publishing
in that reconciliation path.

Read the [root instructions](../../AGENTS.md). Apply their privacy rules in every
bundle. Use environment configuration with neutral defaults such as
`/var/lib/magnus-skills/<skill>` or `/var/backups/magnus`. Never hard-code
private hosts, users or paths.

## Add or edit a skill

1. Add a self-contained `skills/<slug>/` directory. Use a kebab-case slug that
   matches the manifest's `name`.
2. Write `manifest.json` with `name`, SemVer `version`, one-line `description`,
   `author`, relative `entryPoint`, and string arrays `dependencies` (required
   host packages) and `tags`. Either array may be empty. Use the
   [certificate manager manifest](skills/cert-manager/manifest.json) as an example.
3. Add the executable entry point and any support files it uses. Entry points
   are shell scripts targeting Ubuntu 22.04+, with no transpilation.
4. Run `npm run catalog` from this package. The
   [generator](scripts/build-index.mjs) writes `skills/index.json` and each
   bundle's `SKILL.md`. Put lasting instruction edits in the manifest or generator.
5. Run `npm run catalog:check`, `npm run typecheck` and `npm run build`.
   Run `npm test` for manifests, entry points and generated catalogue validation.

The generated aggregate contains `schema`, `generatedAt`, `count` and
`skills`. Each entry adds its directory `path` to the manifest fields. The
generator preserves `generatedAt` for unchanged content and honors
`SOURCE_DATE_EPOCH` on changed builds. The drift check fails when generated
files change. Use Node.js `^24.22.3 || ^26.13.1` for the generator.

Generated manuals follow the [Hermes Agent skill format](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills),
with frontmatter (`name`, `description`, `version`, optional `platforms` and
Hermes metadata) and progressive disclosure. `src/index.ts` exports
`getSkillsDir()` for the absolute bundled directory, `listManifests()` for
manifest loading and `SkillManifest` for TypeScript callers of `@hivemagnus/magnus-skills`.

## Entry point interface

Use [the certificate manager entry point](skills/cert-manager/certs.sh) as a
template. Use Bash strict mode and parse options before positional arguments.

- `-h` and `--help` print usage and exit. Include purpose, arguments, examples,
  environment variables used by the script and what each verbosity level reveals.
- `-v`, `-vv` and `-vvv` provide progressively more output. Repeated `-v`
  increments verbosity. Default output is a concise machine-consumable summary.
  Levels 1, 2 and 3 add debug context, trace/config details and raw diagnostics
  through conditional `log_v1`, `log_v2` and `log_v3` on stderr.
- Unknown flags report an error and show usage. The `--` sentinel ends option
  parsing, including for positionals that start with a dash.

For local Hermes Agent verification, discover bundles via `~/.hermes/skills/`
or a profile's `skills.external_dirs` in `~/.hermes/config.yaml`. For fleet
verification, sync the selected skill through `magnus-agent`.
