# AGENTS.md - magnus-agent

Read the repository root `AGENTS.md` first. Its privacy rules apply here too.

## What this is

`packages/agent` (`@hivemagnus/magnus-agent`, bin `magnus-agent`) is the
node-local management daemon. It enrolls a host with the Control API, sends
heartbeats, and serves authenticated management routes on port 4100. It is not
an LLM runtime. Hermes Agent, the Codex CLI and Ardent are separate programs
that the agent can inspect and manage when they are configured.

## Stack

| Area | Choice |
| --- | --- |
| Framework | Hono v4 on `@hono/node-server` |
| Runtime | Node.js `^24.22.1 \|\| ^26.13.0`, ESM |
| Language | TypeScript strict, NodeNext imports with `.js` extensions |
| Auth | `x-node-token` shared secret; signed command results |
| TLS | Verified outbound TLS through `verifiedFetch()` / `controlApiFetch()`; optional `CONTROL_API_CA_PATH` |

## Commands

```bash
npm run dev
npm run build
npm run typecheck
npm test
```

The package has no database. The Control API stores fleet state.

## Project map

```text
src/
  index.ts              CLI entry: start (default), check, env-schema, --env-file
  cli-args.ts           side-effect-free argument parsing
  start.ts              listener, background loops, shutdown
  env.ts                environment validation (configurationErrors)
  env-catalog.ts        machine-readable env schema
  privileged.ts         MAGNUS_AGENT_PRIVILEGED gating for root-only features
  server.ts             Hono app and route registration
  agent.ts              heartbeat loop
  credential-renewal.ts optional HiveMem token / Tailscale cert renewal
  hermes-sync.ts        optional Hermes registry reconciliation job
  collectors/           health, logs, drift, Docker, GPU, OTel, Tailscale
  executors/            commands, cron, files, skills, Hermes, Codex, Ardent
  security/             native completion registry (mirrored by the server)
  updater/              retired self-update routes (410)
deploy/                 example systemd units
```

## Rules

- **Configuration comes from the environment.** Never hard-code hosts, users,
  home directories, service units or credential paths. Allowlists, such as the
  `MAGNUS_AGENT_RENEWAL_*` variables, are empty by default.
- **Optional executors stay optional.** Hermes, Codex, Ardent and HiveMem code
  paths must report "not installed / not configured" cleanly when their tools
  or settings are absent, and must never block startup.
- **Privileged mode.** Anything that needs root (system cron, accounts, package
  installs, systemd units, chown of other users' files, sudo) must be gated
  with `src/privileged.ts`: mount `requirePrivileged(feature)` on its routes,
  list it in `PRIVILEGED_FEATURES`, and skip its background work when
  `agentPrivileged()` is false. Never escalate through `sudo`. Add a gating test.
- Owner accounts come only from explicit settings such as `HERMES_USER`,
  `CODEX_USER` and `ARDENT_OWNER_USER`. Do not add generic fallbacks.
- When you add an environment variable, add it to `src/env-catalog.ts` and
  `.env.example`.
- File routes must keep denying agent state, secrets and the TLS key. Child
  processes never inherit agent credentials (`utils/child-env.ts`).
- `src/security/native-completion-registry.ts` must stay byte-identical with
  the server's copy. The server pins its SHA-256 in a test.
- Signed proof domains and route paths are wire contracts with the server.
  Change both sides together.
- Do not reintroduce the retired IAM collector, PAM gate, sudo event shipper
  or `/api/iam/*` routes. Host-access IAM belongs to Hive.
- Do not add a second LLM runtime inside the agent.
- Tests use fake data only: `example.com` hosts, `192.0.2.0/24` addresses and
  `/home/operator` paths.

## Writer proofs

The authenticated GET `/api/v1/commands/host-local-writer-proof` signs a
nonce-bound view of the durable one-way mutation drain and its retained
counts. The authenticated GET `/api/v1/cron/os-scheduler-writer-proof` signs
the scheduler's durable drain and its complete, stable source inventory. It
does so only when all sources are supported and quiescent. The Control API
compares each proof with the current enrolled barrier. Neither proof settles
retained effects. `/api/v1/commands/mutation-inventory` exposes bounded
retained claim metadata, read only.
