# AGENTS.md - Magnus Skills

## Purpose

`packages/skills` (`@hivemagnus/magnus-skills`) holds the skill and tool bundles that Magnus publishes to Hermes
Agent profiles. The Control API reads this package for catalogue metadata, and
the Magnus agent reconciles the resulting skills onto local Hermes Agent installs
on each managed system.

Read the repository root `AGENTS.md` first. Its privacy rules apply here too.
Scripts must never hard-code hosts, users, home directories or personal paths.
Read configuration from environment variables with neutral defaults (for
example `/var/lib/magnus-skills/<skill>` or `/var/backups/magnus`), and
document each variable in the script's `--help`.

## Structure

```
packages/skills/
├── src/index.ts       # TS entry — exports getSkillsDir(), listManifests()
├── skills/            # Single source of truth — one directory per skill bundle
│   ├── cert-manager/
│   │   ├── manifest.json
│   │   ├── SKILL.md
│   │   └── certs.sh
│   └── …
├── package.json
└── tsconfig.json
```

`manifest.json` is the Magnus catalogue contract. `SKILL.md` is the Hermes Agent
runtime contract and is generated from the manifest by `npm run catalog` /
`npm run build`, following the Hermes Agent skills reference:
https://hermes-agent.nousresearch.com/docs/user-guide/features/skills

## Key Exports

### TypeScript (`@hivemagnus/magnus-skills`)

| Export            | Description                                        |
| ----------------- | -------------------------------------------------- |
| `getSkillsDir()`  | Returns the absolute path to the `skills/` directory |
| `listManifests()` | Reads all `manifest.json` files                    |
| `SkillManifest`   | Manifest interface                                  |

## Adding a New Skill

1. Create `skills/<slug>/manifest.json`:
   ```json
   {
     "name": "<slug>",
     "version": "1.0.0",
     "description": "What this skill does",
     "author": "Magnus",
     "entryPoint": "run.sh",
     "dependencies": [],
     "tags": ["category"]
   }
   ```
2. Create `skills/<slug>/run.sh` (the entry point script).
3. Make the entry point script executable.
4. Build the catalogue: `npm run build`.
5. The generated `SKILL.md` can be exposed to Hermes Agent by pointing a profile's
   `skills.external_dirs` at this repo's `skills/` directory or by syncing the
   selected skill through `magnus-agent`.

## Bundle Format

Each skill bundle is a directory under `skills/` containing:

- `manifest.json` — required Magnus catalogue metadata, schema documented below.
- `SKILL.md` — generated Hermes Agent instructions. Do not hand-edit unless the
  generator is updated too.
- `<entryPoint>` — the script the agent invokes (commonly `run.sh`).
- Any additional support files referenced by the entry point.

### `manifest.json` schema

| Field          | Type       | Required | Description                                                                  |
| -------------- | ---------- | -------- | ---------------------------------------------------------------------------- |
| `name`         | `string`   | yes      | Bundle slug (`kebab-case`); must match the directory name.                   |
| `version`      | `string`   | yes      | SemVer.                                                                       |
| `description`  | `string`   | yes      | One-line summary surfaced by `/api/v1/orchestra/skill-catalog`.               |
| `author`       | `string`   | yes      | Publisher (e.g. `magnus`).                                                    |
| `entryPoint`   | `string`   | yes      | Relative path inside the bundle; honour the script-parameter pattern below.  |
| `dependencies` | `string[]` | yes      | Host packages the script expects (`openssl`, `rsync`, …); may be empty.       |
| `tags`         | `string[]` | yes      | Free-form categorisation tags; may be empty.                                  |

The generated `SKILL.md` uses Hermes Agent's required format: frontmatter with
`name`, `description`, `version`, optional `platforms`, and Hermes metadata,
followed by progressive-disclosure instructions.

### `skills/index.json`

`skills/index.json` is a generated aggregate of every bundle's manifest plus
its directory name. It is the file the Control API reads to populate the
`/api/v1/orchestra/skill-catalog` endpoint without having to walk the bundle tree at
runtime. Shape:

```jsonc
{
  "schema": "https://agentskills.io/schema/v1",
  "generatedAt": "<ISO timestamp>",
  "count": <n>,
  "skills": [
    { "name": "...", "version": "...", "description": "...", "author": "...",
      "entryPoint": "...", "dependencies": [...], "tags": [...], "path": "..." }
  ]
}
```

Regenerate it and all generated `SKILL.md` files after adding, removing, or
editing a bundle:

```bash
npm run catalog
```

The generator overwrites `skills/index.json` and each bundle's generated
`SKILL.md`; put durable instruction changes in the manifest or generator. It
preserves `generatedAt` when catalogue content is unchanged and accepts
`SOURCE_DATE_EPOCH` for deterministic changed-catalogue builds. The
`catalog:check` command fails when generated catalogue files drift from source.
It has no runtime dependencies beyond Node.js `^24.22.1 || ^26.13.0`.

## Commands

| Task      | Command           |
| --------- | ----------------- |
| Build     | `npm run build`   |
| Catalog   | `npm run catalog` |
| Drift check | `npm run catalog:check` |
| Typecheck | `npm run typecheck` |
| Test      | `npm test` (manifest, entry point and index validation) |

## Conventions

- Each skill is a self-contained directory under `skills/`.
- The `manifest.json` is required and must include `name`, `version`, `description`, `entryPoint`.
- `SKILL.md` is generated. Keep custom instruction changes in the generator or
  manifest fields so rebuilds stay deterministic.
- Skill slugs use `kebab-case`.
- Entry point scripts are raw shell scripts (no transpilation needed).
- **All scripts target Ubuntu** (22.04+) — use `apt`, `ufw`, `systemctl`, `journalctl`, etc.

## Script Parameter Pattern

Every skill entry point script **must** implement the following parameter interface:

### Required Flags

| Flag           | Purpose                                       |
| -------------- | --------------------------------------------- |
| `-h`, `--help` | Print usage information and exit               |
| `-v`           | Increase verbosity (stackable: `-v`, `-vv`, `-vvv`) |

### Verbosity Levels

| Level | Variable       | Description                                      |
| ----- | -------------- | ------------------------------------------------ |
| 0     | (default)      | Summary output only                              |
| 1     | `-v`           | Debug — extra context and detail                 |
| 2     | `-vv`          | Trace — configuration files, audit data          |
| 3     | `-vvv`         | Detail — raw dumps, full command output          |

### Boilerplate Template

```bash
#!/usr/bin/env bash
# <skill-name> — Brief description
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "\$0") [OPTIONS] [ARGS...]

Description of what this skill does.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Summary output
  -v             Debug details
  -vv            Trace / config details
  -vvv           Full raw output

Examples:
  $(basename "\$0")
  $(basename "\$0") -vv
EOF
  exit 0
}

log_v1() { [[ \$VERBOSE -ge 1 ]] && echo "[DEBUG] \$*" >&2 || true; }
log_v2() { [[ \$VERBOSE -ge 2 ]] && echo "[TRACE] \$*" >&2 || true; }
log_v3() { [[ \$VERBOSE -ge 3 ]] && echo "[DETAIL] \$*" >&2 || true; }

while [[ \$# -gt 0 ]]; do
  case "\$1" in
    -h|--help) usage ;;
    -vvv) VERBOSE=3; shift ;;
    -vv) VERBOSE=2; shift ;;
    -v) VERBOSE=\$((VERBOSE + 1)); shift ;;
    --) shift; break ;;
    -*) echo "Unknown option: \$1" >&2; usage ;;
    *) break ;;
  esac
done

echo "=== Skill Name ==="
# ... skill logic here ...
```

### Guidelines

- Parse `-h`/`--help` and `-v`/`-vv`/`-vvv` **before** any positional arguments.
- Use `log_v1`, `log_v2`, `log_v3` for conditional output at each verbosity level.
- Default output (level 0) should be a concise summary suitable for automated consumption.
- Higher verbosity levels should progressively reveal more detail.
- Unknown flags should print an error and call `usage`.
- The `--` sentinel ends option parsing so positional args starting with `-` are safe.

## Hermes Agent Publishing

Hermes Agent treats `~/.hermes/skills/` as the primary local skill directory,
and it can also scan `skills.external_dirs` from `~/.hermes/config.yaml`.
Magnus publishes skills by keeping this package as the source of truth, then
having `magnus-agent` reconcile enabled skill assignments onto the local Hermes
Agent profile on the target system. Do not add a separate service for plugin or
skill publishing.
