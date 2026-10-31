# AGENTS.md: Magnus UI (`apps/dashboard`)

Guidance for contributors and coding agents working on `@hivemagnus/magnus-ui`. The repository root
`AGENTS.md` (privacy rules, commit conventions, gates) applies here too. Read it first.

## What this is

The Next.js web console for the Magnus control plane: fleet and node inventory, commands, files,
logs, audit, rollouts, incidents, Ardent and Codex agent pages, and optional Hermes Agent pages. It
talks only to the Magnus Control API (`@hivemagnus/magnus-server`) through server-side proxy routes,
and ships to npm as a prebuilt standalone server with the `magnus-ui` CLI.

## Stack

| Area | Choice |
| --- | --- |
| Framework | Next.js 16 App Router, React 19, standalone output |
| Runtime | Node.js `^24.22.1 \|\| ^26.13.0` |
| Language | TypeScript strict mode |
| Styling | Tailwind CSS v4 with the theme tokens in `src/app/globals.css` |
| Tests | Vitest (`src/**/*.test.ts(x)`), Playwright (`tests/`) |

## Commands

```bash
npm run dev          # HTTPS dev server on :3000 (expects ../../certs/server.{crt,key})
npm run typecheck
npm run lint
npm test             # Vitest
npm run build        # next build
npm run stage        # stage dist/app for packaging (also runs on npm pack)
npm run test:e2e     # Playwright, see playwright.config.ts
```

## Layout

```text
bin/magnus-ui.mjs          CLI: start | check | env-schema, --env-file
server-tls.mjs             HTTPS wrapper around the standalone server.js (Hermes WebSocket bridge)
runtime-*.mjs              Plain-ESM helpers shared by the server, the wrapper and the CLI
  runtime-environment.mjs  Canonical environment schema (drives `env-schema` and the docs)
  runtime-integrations.mjs Optional integration detection
scripts/stage-package.mjs  Builds the npm payload in dist/app
src/app/                   Routes and route handlers (api/proxy injects API_SECRET server-side)
src/components/            UI primitives (components/ui) and feature components
src/lib/                   Auth, API clients, terminal sessions, navigation (routes.ts)
src/proxy.ts               Session validation and route guard
tests/                     Playwright specs
deploy/magnus-ui.service   Example systemd unit
```

## Rules

- **Configuration comes from the runtime environment.** Never hard-code hosts, users or URLs, and
  never add a fallback to a real host. Add every new variable to `runtime-environment.mjs` and
  `.env.example`.
- **Integrations are optional.** The security console, Hive Router, Hive IAM login and Hermes Agent
  are detected in `runtime-integrations.mjs`. When one is not configured, hide its navigation
  (`visibleNavGroups` in `src/lib/routes.ts`), show a clear "not configured" state on its pages and
  return 503 (proxies) or 404 (deep links). Read integration state at request time, never at build
  time: the published build is configured by whoever installs it.
- Browser code calls same-origin routes only. Secrets (`API_SECRET`, session and credential keys)
  stay server-side; never expose them through `NEXT_PUBLIC_*`.
- Keep login fail-closed: Redis-backed throttling and the authentication audit log are required.
- Terminal and proxy code audits metadata only, never terminal contents or request bodies.
- Keep high-risk command and file workflows previewable (dry run or preview first).
- Build UI from the primitives in `src/components/ui/` and the theme tokens; avoid stock Tailwind
  palette colours. Respect `prefers-reduced-motion`.
- Packages imported directly by `server-tls.mjs` or `runtime-*.mjs` must be runtime
  `dependencies` and listed in `DEPENDENCY_PACKAGES` in `scripts/stage-package.mjs`. Everything
  else is bundled by Next.js and belongs in `devDependencies`.
- Test fixtures use `example.com` hosts, documentation IP ranges and obviously fake secrets.

## Before you commit

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

For packaging changes also run `npm pack` and start the result with
`npx magnus-ui start --env-file <file>` from a clean directory.
