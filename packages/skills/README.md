# @hivemagnus/magnus-skills

A catalogue of Ubuntu operations skills for Magnus-managed hosts. Each skill
is a small, self-contained shell script plus a `SKILL.md` in the
[Hermes Agent skill format](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills),
so an agent knows when and how to run it.

The catalogue covers packages and updates, services, cron, certificates,
backups, disks, swap, mounts, DNS, NTP, firewall, network diagnostics, users and
logins, processes, logs, Docker, sysctl, security audits, Wazuh agent health,
local LLM services and more. Run `npm run catalog` to list them.

## Install

```bash
npm i @hivemagnus/magnus-skills
```

## Use

From TypeScript or JavaScript:

```ts
import { getSkillsDir, listManifests } from '@hivemagnus/magnus-skills';

for (const skill of listManifests()) console.log(skill.name, skill.description);
console.log(getSkillsDir()); // absolute path of the bundled skills/ directory
```

With Hermes Agent, point a profile's `skills.external_dirs` in
`~/.hermes/config.yaml` at the package's `skills/` directory. You can also copy
selected bundles into `~/.hermes/skills/`.

With Magnus, the magnus-server reads this catalogue and `magnus-agent`
publishes the selected skills onto each managed host.

Every script supports `-h`/`--help` and `-v`, `-vv` and `-vvv` verbosity, and
targets Ubuntu 22.04 or later. Scripts that need configuration read it from
environment variables, which `--help` documents.

## Layout

| Path | Contents |
| --- | --- |
| `skills/<slug>/manifest.json` | Catalogue metadata (source of truth) |
| `skills/<slug>/SKILL.md` | Generated Hermes Agent instructions |
| `skills/<slug>/<script>` | Executable entry point |
| `skills/index.json` | Generated aggregate catalogue |
| `src/index.ts` | `getSkillsDir()`, `listManifests()`, `SkillManifest` |
| `scripts/build-index.mjs` | Catalogue generator |

## Development

From the repository root:

```bash
npm --workspace @hivemagnus/magnus-skills run catalog        # regenerate SKILL.md and index.json
npm --workspace @hivemagnus/magnus-skills run catalog:check  # fail if generated files drift
npm --workspace @hivemagnus/magnus-skills test
npm --workspace @hivemagnus/magnus-skills run build
```

To add a skill, create `skills/<slug>/manifest.json` and an executable entry
point, then run `npm run catalog`. Never edit the generated `SKILL.md` by hand.
See [AGENTS.md](https://github.com/ChefTaco/magnus/blob/main/packages/skills/AGENTS.md)
for the manifest schema and the script template.

## License

Apache-2.0
