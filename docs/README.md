# Magnus documentation

Start with the [root README](../README.md) for installation and the quick start. Each package's
README is the reference for its installation, configuration and environment variables, and its
`AGENTS.md` holds the rules for editing it.

## Architecture

- [Architecture](APP_ARCHITECTURE.md): the console, the server, the agent, Ardent, and how requests
  and credentials flow between them.
- [Hermes Agent management](APP_ARCHITECTURE_HERMES.md): desired state, reconciliation through the
  node agent, managed configuration and the plugin API.
- [Hermes registry](HERMES_REGISTRY.md): revisioned skills, plugins, MCP servers and tool policy,
  staged rollouts and host enrollment.
- [Codex CLI management](APP_ARCHITECTURE_CODEX.md): version checks, updates and ChatGPT sign-in for
  the Codex CLI on managed hosts.

## Commands and coordination

- [Command receipts and recovery](COMMAND_RECEIPTS.md): durable per-node receipts, uncertain
  outcomes and signed reconciliation.
- [Command resource leases](COMMAND_RESOURCE_LEASES.md): durable ownership of node commands, node
  enrollment, and shared repository, provider and GPU leases.

## Operations

- [Observability](OBSERVABILITY.md): metrics, suggested objectives and alerts, data retention,
  application probes and Hermes proxy security events.
- [Example application probes](examples/application-probes.json).
- [Script guide](../scripts/README.md): repository checks and local cleanup.

## Package references

| Package | Reference |
| --- | --- |
| `@hivemagnus/magnus-ui` | [apps/dashboard/README.md](../apps/dashboard/README.md) |
| `@hivemagnus/magnus-server` | [services/control-api/README.md](../services/control-api/README.md) |
| `@hivemagnus/magnus-agent` | [packages/agent/README.md](../packages/agent/README.md) |
| `@hivemagnus/ardent` | [packages/ardent/README.md](../packages/ardent/README.md) |
| `@hivemagnus/magnus-contracts` | [packages/contracts/README.md](../packages/contracts/README.md) |
| `@hivemagnus/magnus-skills` | [packages/skills/README.md](../packages/skills/README.md) |

## Documentation checks

`npm run docs:check` checks that every package has a README and an `AGENTS.md` and appears in the
package maps of the root README, the root `AGENTS.md` and the architecture guide, that local
Markdown links resolve, that console routes named in the documentation exist in the built Next.js
route manifest, and that the console's environment table matches its runtime configuration. The
route check needs a console build (`npm run dashboard:build`). After changing the console's
environment schema, run `npm run docs:generate`. `npm run docs:links` runs only the checks that
need no build.
