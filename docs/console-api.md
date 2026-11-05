# Console API route inventory

[HiveXUI](https://github.com/ChefTaco/HiveXUI), the suite's static browser console, reaches the
control API directly, through a same-origin ingress, with a short-lived Oathweave resource token. This inventory is the ingress allowlist. It covers every route
mounted on the server, audited from the router files, and
`services/control-api/src/routes/console-inventory.test.ts` fails when a route is added, removed or
moved without updating it.

## Classes

| Class | Meaning | Rows | At the ingress |
|---|---|---|---|
| `browser` | A person's console drives it with a user token | 138 | Allow the exact method and path |
| `machine` | Agents, services and integrations, with their own credentials | 73 | Deny |
| `exclude` | Reachable with a user token, but no console needs it, or it was written for a server-side caller | 142 | Deny until a feature needs it and it is reviewed |
| `retired` | Always answers 404 or 410 | 64 | Deny |

The `Wave 1` column marks routes whose request and response shapes are published in
`packages/contracts/src/browser.ts`. Allow those first. Other `browser` rows are what the existing
dashboard also uses, and have no published contract yet.

`Auth` is what the route itself enforces: `user:<roles>` means `authMiddleware` plus a role check,
and `user:any` means any authenticated role. Path patterns use Hono syntax: `:name` is exactly one
path segment and a trailing `*` is the remainder. Paths are complete, including `/api/v1`.

`GET /api/docs/openapi.json` is the one browser route outside `/api/v1`. It is public, carries no secret
or host detail, and the console's API docs page reads it. A console that prefixes its API paths needs
this exact mapping, with no prefix rule: `GET /api/magnus/docs/openapi.json` to
`GET /api/docs/openapi.json`. Its response has no contract schema, so its `Wave 1` cell stays empty.

## Ingress requirements

- **Default deny.** Allow only the `browser` rows, matching method and pattern. Do not allow a prefix.
- **Check the explicit denies first.** A `:name` pattern also matches a literal segment, so
  `GET /api/v1/nodes/:nodeId` matches `GET /api/v1/nodes/scan-users`. See
  [Explicit denies](#explicit-denies).
- **Strip machine credentials.** Remove `x-api-secret` and `x-node-token` from browser requests. The
  server treats a valid `x-api-secret` as the system administrator before it looks at the bearer token.
- **Forward only what the API reads:** `Authorization`, `Content-Type`, `Accept`,
  `x-idempotency-key` and `x-trace-id`. Authorization may hold only a bearer token.
- **Normalize before matching.** Reject encoded slashes, dot segments and repeated slashes. If
  `MAGNUS_ROUTE_ALIASES_JSON` is set, the server rewrites paths before routing: review each alias
  against this list.
- **Keep it same-origin.** CORS stays as it is for this path. The API is not opened to other origins.
- **Do not buffer streams.** `Stream` rows are `text/event-stream` and need a bearer token, so a
  browser reads them with `fetch`, because `EventSource` cannot send the header. Oathweave streams close
  on logout and at token expiry: reconnect with a fresh token.

Rate limits key on the verified Oathweave subject, so browsers behind one ingress do not share a
bucket. Each subject still has one budget per prefix: `/hermes/*` allows 20 requests a minute and
`/orchestra/*` allows 30, so poll those installation reads sparingly.

## Authentication

| Variable | Purpose |
|---|---|
| `OATHWEAVE_ISSUER` | Exact `iss`. Refused at startup together with `IAM_CORE_URL` |
| `OATHWEAVE_JWKS_URL` | HTTPS key set that verifies signatures |
| `OATHWEAVE_USERINFO_URL` | HTTPS userinfo endpoint for online revocation |
| `MAGNUS_OATHWEAVE_IDENTITIES_JSON` | Array of `{issuer,subject,localUserId,role}` |
| `MAGNUS_HERMES_ENABLED` | The `hermes` capability. This is a server setting now, separate from the dashboard's |
| `MAGNUS_CONSOLE_BASE_PATH` | Prefix for console links in notifications, for example `/fleet` |

A token must have audience `magnus`, `actorType` `USER`, a `jti`, a `sessionId` and a lifetime of at
most 15 minutes. Logout takes effect within 15 seconds, on requests and on open streams.

A person needs exactly one link, matched on issuer and subject. A missing or duplicate link answers 403,
and so does a token with no permission the link allows. A token that fails verification answers 401 and
is never tried against another verifier.

| Link role | Token permission | Mapped role |
|---|---|---|
| `ADMIN` | `magnus:admin` | `ADMIN` |
| `ADMIN` or `OPERATOR` | `magnus:operate` | `OPERATOR` |
| Any | `magnus:view` | `VIEWER` |
| Anything else | | Rejected |

`localUserId` becomes the audit actor, and it does not need a row in the local users table.

`GET /api/v1/console/session` replaces the dashboard's environment checks and build-time values:

```json
{
  "success": true,
  "data": {
    "userId": "alice",
    "role": "OPERATOR",
    "capabilities": {
      "hermes": true,
      "terminal": false,
      "agentVersion": "1.2.3",
      "magnusVersion": "1.2.3",
      "securityConsoleUrl": null
    }
  }
}
```

`terminal` is true when a fleet gateway is deployed (`FLEET_GATEWAY_URL`, `FLEET_GATEWAY_TOKEN_SHA256`)
and this person holds an `ADMIN` link and `magnus:terminal`. It only says whether to offer the terminal.

## Web terminal

No route on this server offers a terminal, and `POST /api/v1/terminal/ticket` stays retired, so this
process never holds the SSH key. The [fleet gateway](../services/fleet-gateway/README.md) is a separate
service with its own endpoints, its own ingress mapping and its own security model. The `magnus:terminal`
permission grants nothing here.

## Browser contract export

```bash
npm run contracts:browser -- --output ./output/magnus-browser-contracts
```

This writes the committed `browser.ts` and a `provenance.json` with the revision and each file's
SHA-256. It refuses an existing directory and exports committed bytes, not the working tree. The
contract imports only `zod`, so it stays one file: it also carries a checked copy of the upgrade remedies
from `packages/contracts/src/upgrade-remedies.ts`.

## Secrets and roles

The server enforces these by role, so they hold for a raw response and not only a parsed one.

| Field | `ADMIN` | Below `ADMIN` |
|---|---|---|
| Role `envConfig` | Values and `envConfigKeys` | `envConfigKeys` only |
| Cron `environment` | Values and `environmentKeys` | `environmentKeys` only |
| Readiness `expectedFingerprints` | Yes | Absent |
| Readiness `secretFingerprint` | `match`, `state` and both fingerprints | `match` and `state` |
| `nodeManagerSecretFingerprint` in node `metadata` | Yes | Removed; `nodeManagerSecretState` stays |
| Hermes `apiServerKeyFingerprint`, `keyFingerprint` | Yes, with `apiServerKeyConfigured`, `keyConfigured` | The `Configured` boolean only |
| Node `token` | Only in the `POST /api/v1/nodes/register` response | Same, for `OPERATOR`. `VIEWER` is refused |

A `PATCH` below `ADMIN` merges environment values, because that caller only saw key names. A key left
out or left blank keeps its value, so sending back a redacted response changes nothing. Setting a value
adds or replaces that key. Removing a key takes an `ADMIN`, whose `PATCH` still replaces the whole map.

A node token is shown once. That response is `Cache-Control: no-store`, and the token is not in audit
detail or logs. No other route returns it. The contract's schema strips it from the parsed response.

`services/control-api/src/routes/console-secret-sweep.integration.test.ts` plants a value in each
sensitive column and reads every `browser` and `exclude` `GET` route as each role.

These remain, and are not closed by the rules above:

- `OPERATOR` can run commands (`POST /api/v1/commands`, `POST /api/v1/quick-command/:nodeId/exec`) and
  read files (`GET /api/v1/files/read`) on hosts. The role environment file a host received is
  therefore reachable to an `OPERATOR` through those routes, even though the API hides its values.
- Command lines, log messages and rollout metadata are free text, returned to any role.
- `GET /api/v1/library/files/:fileId` returns file content to any role.
- `GET /api/v1/self-update/status` returns the server's `repoRoot` path to any role.
- `Node.token` is stored in plaintext in the database.

Assistant conversations belong to whoever started them. The list and every `/assistant/conversations/:id`
route, the unread count and marking messages read answer only for the caller's own, for every role, and
someone else's conversation answers 404. No console feature reads other people's, so `ADMIN` has no
exception. The exception is the server's heartbeat conversation, which any role can read because it
describes the fleet and the anomaly page checks for it. The tool approval routes under
`/assistant/messages/:id` remain `ADMIN` or `OPERATOR` and are not limited to the owner.

`GET /api/v1/ops/timeline` returns each `href` relative to the dashboard's routes, without
`MAGNUS_CONSOLE_BASE_PATH`. A console at another path must map them.

## Dashboard features with no route here

The standalone dashboard computes these in its own server, so a static console needs another source or must drop them:

- `/api/federation` (fan-out over several control nodes) and `/api/control-nodes`
- `/api/terminal/*`, replaced by the [fleet gateway](../services/fleet-gateway/README.md)
- The Hermes dashboard proxy and the router admin proxy
- The mission-control Hermes tiles, computed from `/hermes/installations` in a server component

The dashboard's nodes page calls `POST /api/v1/discovery/scan` and its mission-control page reads
`GET /api/v1/heartbeat/stream/stats`. Both are `machine` here, so a console should not offer them
unless these rows change. `POST /api/v1/hermes/deploy` is retired and always answers 410.

## Browser-facing

| Method | Path pattern | Class | Auth | Wave 1 |
|---|---|---|---|---|
| GET | `/api/docs/openapi.json` | browser | `public` |  |
| POST | `/api/v1/agents/upgrade` | browser | `user:ADMIN` | yes |
| GET | `/api/v1/agents/upgrade/eligibility` | browser | `user:any` | yes |
| GET | `/api/v1/agents/upgrade/runs/:id` | browser | `user:any` | yes |
| POST | `/api/v1/agents/upgrade/runs/:id/retry` | browser | `user:ADMIN` | yes |
| POST | `/api/v1/agents/upgrade/runs/:id/stop` | browser | `user:ADMIN` | yes |
| GET | `/api/v1/anomalies` | browser | `user:any` | yes |
| GET | `/api/v1/anomalies/event/:id/correlation` | browser | `user:any` | yes |
| GET | `/api/v1/anomalies/summary` | browser | `user:any` | yes |
| GET | `/api/v1/ardent/installations` | browser | `user:ADMIN` |  |
| GET | `/api/v1/ardent/installations/:nodeId` | browser | `user:ADMIN` |  |
| GET | `/api/v1/ardent/installations/:nodeId/profiles/:name/*` | browser | `user:ADMIN` |  |
| POST | `/api/v1/ardent/installations/:nodeId/profiles/:name/action` | browser | `user:ADMIN` |  |
| GET | `/api/v1/ardent/installations/:nodeId/profiles/:name/artifacts/:artifactId` | browser | `user:ADMIN` |  |
| GET | `/api/v1/ardent/profiles` | browser | `user:ADMIN` |  |
| GET | `/api/v1/assistant/conversations` | browser | `user:any` | yes |
| GET | `/api/v1/assistant/insights` | browser | `user:any` | yes |
| GET | `/api/v1/assistant/insights/pins` | browser | `user:any` | yes |
| POST | `/api/v1/assistant/insights/pins` | browser | `user:ADMIN\|OPERATOR` | yes |
| DELETE | `/api/v1/assistant/insights/pins/:id` | browser | `user:ADMIN\|OPERATOR` | yes |
| GET | `/api/v1/assistant/shares/:token` | browser | `user:any` |  |
| GET | `/api/v1/audit` | browser | `user:any` | yes |
| GET | `/api/v1/audit/days` | browser | `user:any` | yes |
| GET | `/api/v1/codex/installations` | browser | `user:ADMIN` |  |
| GET | `/api/v1/codex/installations/:nodeId` | browser | `user:ADMIN` |  |
| POST | `/api/v1/codex/installations/:nodeId/device-auth` | browser | `user:ADMIN` |  |
| GET | `/api/v1/codex/installations/:nodeId/device-auth/:sessionId` | browser | `user:ADMIN` |  |
| POST | `/api/v1/codex/installations/:nodeId/device-auth/:sessionId/cancel` | browser | `user:ADMIN` |  |
| POST | `/api/v1/codex/installations/:nodeId/logout` | browser | `user:ADMIN` |  |
| POST | `/api/v1/codex/installations/:nodeId/update` | browser | `user:ADMIN` |  |
| GET | `/api/v1/commands` | browser | `user:any` | yes |
| POST | `/api/v1/commands` | browser | `user:ADMIN\|OPERATOR` | yes |
| GET | `/api/v1/commands/:commandId` | browser | `user:any` | yes |
| POST | `/api/v1/commands/:commandId/cancel` | browser | `user:ADMIN\|OPERATOR` | yes |
| GET | `/api/v1/commands/:commandId/result` | browser | `user:any` | yes |
| GET | `/api/v1/console/session` | browser | `user:any` | yes |
| GET | `/api/v1/cron` | browser | `user:any` | yes |
| POST | `/api/v1/cron` | browser | `user:ADMIN\|OPERATOR` | yes |
| DELETE | `/api/v1/cron/:cronId` | browser | `user:ADMIN\|OPERATOR` | yes |
| GET | `/api/v1/cron/:cronId` | browser | `user:any` | yes |
| PATCH | `/api/v1/cron/:cronId` | browser | `user:ADMIN\|OPERATOR` | yes |
| GET | `/api/v1/dependencies` | browser | `user:any` | yes |
| GET | `/api/v1/events/stream` | browser | `user:any` | yes Stream |
| GET | `/api/v1/files/read` | browser | `user:ADMIN\|OPERATOR` | yes |
| POST | `/api/v1/files/update` | browser | `user:ADMIN\|OPERATOR` | yes |
| GET | `/api/v1/health` | browser | `public` | yes |
| GET | `/api/v1/health/:nodeId/forecast` | browser | `user:any` | yes |
| GET | `/api/v1/hermes/installations` | browser | `user:any` | yes |
| GET | `/api/v1/hermes/installations/:id/profiles` | browser | `user:any` |  |
| GET | `/api/v1/hermes/profiles` | browser | `user:any` |  |
| GET | `/api/v1/library/categories` | browser | `user:any` |  |
| POST | `/api/v1/library/categories` | browser | `user:ADMIN\|OPERATOR` |  |
| DELETE | `/api/v1/library/categories/:categoryId` | browser | `user:ADMIN` |  |
| PATCH | `/api/v1/library/categories/:categoryId` | browser | `user:ADMIN\|OPERATOR` |  |
| POST | `/api/v1/library/deploy` | browser | `user:ADMIN\|OPERATOR` |  |
| GET | `/api/v1/library/files` | browser | `user:any` | yes |
| POST | `/api/v1/library/files` | browser | `user:ADMIN\|OPERATOR` | yes |
| DELETE | `/api/v1/library/files/:fileId` | browser | `user:ADMIN` |  |
| GET | `/api/v1/library/files/:fileId` | browser | `user:any` | yes |
| PATCH | `/api/v1/library/files/:fileId` | browser | `user:ADMIN\|OPERATOR` | yes |
| POST | `/api/v1/library/files/move` | browser | `user:ADMIN\|OPERATOR` |  |
| POST | `/api/v1/logs/query` | browser | `user:any` | yes |
| GET | `/api/v1/logs/stream` | browser | `user:any` | yes Stream |
| GET | `/api/v1/nodes` | browser | `user:any` | yes |
| DELETE | `/api/v1/nodes/:nodeId` | browser | `user:ADMIN` | yes |
| GET | `/api/v1/nodes/:nodeId` | browser | `user:any` | yes |
| PATCH | `/api/v1/nodes/:nodeId` | browser | `user:ADMIN\|OPERATOR` | yes |
| GET | `/api/v1/nodes/:nodeId/gpu` | browser | `user:any` | yes |
| GET | `/api/v1/nodes/:nodeId/health` | browser | `user:any` | yes |
| GET | `/api/v1/nodes/:nodeId/health/history` | browser | `user:any` | yes |
| GET | `/api/v1/nodes/:nodeId/health/timeseries` | browser | `user:any` | yes |
| POST | `/api/v1/nodes/:nodeId/system-updates/enable` | browser | `user:ADMIN\|OPERATOR` | yes |
| POST | `/api/v1/nodes/register` | browser | `user:ADMIN\|OPERATOR` | yes |
| GET | `/api/v1/nodes/system-updates/summary` | browser | `user:any` | yes |
| GET | `/api/v1/nodes/tailscale/summary` | browser | `user:any` | yes |
| GET | `/api/v1/notifications` | browser | `user:any` | yes |
| GET | `/api/v1/notifications/preferences` | browser | `user:any` | yes |
| PUT | `/api/v1/notifications/preferences` | browser | `user:any` | yes |
| POST | `/api/v1/notifications/read` | browser | `user:any` | yes |
| POST | `/api/v1/notifications/read-all` | browser | `user:any` | yes |
| GET | `/api/v1/notifications/unread-count` | browser | `user:any` | yes |
| GET | `/api/v1/ops/applications` | browser | `user:any` | yes |
| POST | `/api/v1/ops/applications/:id/canary` | browser | `user:ADMIN\|OPERATOR` | yes |
| GET | `/api/v1/ops/capacity-advice` | browser | `user:any` | yes |
| GET | `/api/v1/ops/dependency-health` | browser | `user:any` | yes |
| GET | `/api/v1/ops/hermes-effective-state` | browser | `user:any` |  |
| GET | `/api/v1/ops/incident-summary` | browser | `user:any` | yes |
| GET | `/api/v1/ops/incidents/:id/evidence` | browser | `user:ADMIN\|OPERATOR` | yes |
| GET | `/api/v1/ops/lessons` | browser | `user:ADMIN\|OPERATOR` | yes |
| POST | `/api/v1/ops/lessons` | browser | `user:ADMIN\|OPERATOR` | yes |
| GET | `/api/v1/ops/maintenance` | browser | `user:any` | yes |
| POST | `/api/v1/ops/maintenance` | browser | `user:ADMIN\|OPERATOR` | yes |
| POST | `/api/v1/ops/maintenance/:id/cancel` | browser | `user:ADMIN\|OPERATOR` | yes |
| GET | `/api/v1/ops/readiness` | browser | `user:any` | yes |
| GET | `/api/v1/ops/retention` | browser | `user:any` | yes |
| GET | `/api/v1/ops/storage-evidence/:nodeId` | browser | `user:ADMIN\|OPERATOR` | yes |
| GET | `/api/v1/ops/timeline` | browser | `user:any` | yes |
| GET | `/api/v1/orchestra/installations` | browser | `user:any` | yes |
| GET | `/api/v1/orchestra/profiles` | browser | `user:any` | yes |
| POST | `/api/v1/quick-command/:nodeId/exec` | browser | `user:ADMIN\|OPERATOR` | yes |
| GET | `/api/v1/remediation/executions` | browser | `user:any` | yes |
| POST | `/api/v1/remediation/executions/:id/approve` | browser | `user:ADMIN\|OPERATOR` | yes |
| GET | `/api/v1/remediation/rules` | browser | `user:any` | yes |
| POST | `/api/v1/remediation/rules` | browser | `user:ADMIN\|OPERATOR` | yes |
| DELETE | `/api/v1/remediation/rules/:id` | browser | `user:ADMIN` | yes |
| PATCH | `/api/v1/remediation/rules/:id` | browser | `user:ADMIN\|OPERATOR` | yes |
| POST | `/api/v1/remediation/trigger` | browser | `user:ADMIN\|OPERATOR` | yes |
| GET | `/api/v1/roles` | browser | `user:any` | yes |
| POST | `/api/v1/roles` | browser | `user:ADMIN\|OPERATOR` |  |
| DELETE | `/api/v1/roles/:roleId` | browser | `user:ADMIN` |  |
| GET | `/api/v1/roles/:roleId` | browser | `user:any` |  |
| PATCH | `/api/v1/roles/:roleId` | browser | `user:ADMIN\|OPERATOR` |  |
| POST | `/api/v1/roles/:roleId/apply` | browser | `user:ADMIN\|OPERATOR` |  |
| POST | `/api/v1/roles/:roleId/assign` | browser | `user:ADMIN\|OPERATOR` | yes |
| POST | `/api/v1/roles/:roleId/unassign` | browser | `user:ADMIN\|OPERATOR` | yes |
| GET | `/api/v1/roles/applications/list` | browser | `user:any` | yes |
| GET | `/api/v1/rollouts` | browser | `user:any` | yes |
| GET | `/api/v1/rollouts/:id` | browser | `user:any` | yes |
| POST | `/api/v1/rollouts/:id/abort` | browser | `user:ADMIN` | yes |
| POST | `/api/v1/rollouts/:id/pause` | browser | `user:ADMIN\|OPERATOR` | yes |
| POST | `/api/v1/rollouts/:id/resume` | browser | `user:ADMIN\|OPERATOR` | yes |
| POST | `/api/v1/scan/cron` | browser | `user:ADMIN\|OPERATOR` | yes |
| POST | `/api/v1/scan/skills` | browser | `user:ADMIN\|OPERATOR` |  |
| GET | `/api/v1/self-update/status` | browser | `user:any` | yes |
| GET | `/api/v1/self-update/version` | browser | `user:any` | yes |
| GET | `/api/v1/skills` | browser | `user:any` | yes |
| GET | `/api/v1/stats/overview` | browser | `user:any` | yes |
| GET | `/api/v1/system/updates` | browser | `user:any` |  |
| GET | `/api/v1/topology` | browser | `user:any` | yes |
| POST | `/api/v1/topology/scan` | browser | `user:ADMIN\|OPERATOR` | yes |
| GET | `/api/v1/webhooks` | browser | `user:ADMIN` | yes |
| POST | `/api/v1/webhooks` | browser | `user:ADMIN` | yes |
| DELETE | `/api/v1/webhooks/:id` | browser | `user:ADMIN` | yes |
| GET | `/api/v1/webhooks/:id` | browser | `user:ADMIN` | yes |
| PATCH | `/api/v1/webhooks/:id` | browser | `user:ADMIN` | yes |
| GET | `/api/v1/webhooks/:id/deliveries` | browser | `user:ADMIN` | yes |
| POST | `/api/v1/webhooks/:id/deliveries/:deliveryId/redeliver` | browser | `user:ADMIN` | yes |
| POST | `/api/v1/webhooks/:id/test` | browser | `user:ADMIN` | yes |

## Explicit denies

Each row is a non-browser route that a broader `browser` pattern also matches. Deny these first.

| Method | Path | Matched by |
|---|---|---|
| GET | `/api/v1/agents/upgrade/runs/latest` | `/api/v1/agents/upgrade/runs/:id` |
| GET | `/api/v1/ardent/installations/:nodeId/profiles/:name/context-adoptions/:releaseId` | `/api/v1/ardent/installations/:nodeId/profiles/:name/*` |
| GET | `/api/v1/ardent/installations/:nodeId/profiles/:name/context-release` | `/api/v1/ardent/installations/:nodeId/profiles/:name/*` |
| GET | `/api/v1/nodes/compare` | `/api/v1/nodes/:nodeId` |
| GET | `/api/v1/nodes/scan-users` | `/api/v1/nodes/:nodeId` |
| GET | `/api/v1/nodes/tags` | `/api/v1/nodes/:nodeId` |

## Machine-only

| Method | Path pattern | Class | Auth | Why |
|---|---|---|---|---|
| GET | `/` | machine | `public` | Public liveness probe for load balancers. |
| POST | `/api/v1/cron/managed-occurrences/admit` | machine | `node-token` | Agent scheduler coordination with the node credential. |
| POST | `/api/v1/cron/managed-occurrences/settle` | machine | `node-token` | Agent scheduler coordination with the node credential. |
| POST | `/api/v1/cron/managed-occurrences/status` | machine | `node-token` | Agent scheduler coordination with the node credential. |
| POST | `/api/v1/fleet-gateway/audit` | machine | `fleet-gateway-token` | Fleet gateway records terminal session metadata. |
| POST | `/api/v1/fleet-gateway/target` | machine | `fleet-gateway-token` | Fleet gateway resolves a node id to inventory facts. |
| POST | `/api/v1/discovery/scan` | machine | `user:ADMIN\|OPERATOR` | Discovery kept machine-only by instruction, though the nodes page calls it. |
| GET | `/api/v1/health/watchdog` | machine | `public` | Public off-host watchdog signal. |
| POST | `/api/v1/heartbeat` | machine | `node-token` | Agent heartbeat with the shared node credential. |
| GET | `/api/v1/heartbeat/stream/stats` | machine | `user:any` | Heartbeat surface kept machine-only by instruction, though mission-control reads it server-side and tolerates its absence. |
| GET | `/api/v1/hermes-registry/artifacts/:kind/:slug/:revision` | machine | `service-digest:hermes-registry-client` | Hermes registry, machine-only by instruction. |
| POST | `/api/v1/hermes-registry/capture` | machine | `service-digest:hermes-registry-client` | Hermes registry, machine-only by instruction. |
| POST | `/api/v1/hermes-registry/clients` | machine | `user:ADMIN` | Hermes registry, machine-only by instruction. |
| POST | `/api/v1/hermes-registry/core/receipts` | machine | `service-digest:hermes-registry-client` | Hermes registry, machine-only by instruction. |
| POST | `/api/v1/hermes-registry/core/slot` | machine | `service-digest:hermes-registry-client` | Hermes registry, machine-only by instruction. |
| POST | `/api/v1/hermes-registry/inventory` | machine | `service-digest:hermes-registry-client` | Hermes registry, machine-only by instruction. |
| GET | `/api/v1/hermes-registry/manifest` | machine | `service-digest:hermes-registry-client` | Hermes registry, machine-only by instruction. |
| GET | `/api/v1/hermes-registry/policy` | machine | `service-digest:hermes-registry-client` | Hermes registry, machine-only by instruction. |
| POST | `/api/v1/hermes-registry/policy/receipts` | machine | `service-digest:hermes-registry-client` | Hermes registry, machine-only by instruction. |
| PUT | `/api/v1/hermes-registry/profile-groups/:profileId` | machine | `user:ADMIN\|OPERATOR` | Hermes registry, machine-only by instruction. |
| GET | `/api/v1/hermes-registry/profiles` | machine | `service-digest:hermes-registry-client` | Hermes registry, machine-only by instruction. |
| POST | `/api/v1/hermes-registry/receipts` | machine | `service-digest:hermes-registry-client` | Hermes registry, machine-only by instruction. |
| POST | `/api/v1/hermes-registry/revisions` | machine | `user:ADMIN\|OPERATOR` | Hermes registry, machine-only by instruction. |
| POST | `/api/v1/hermes-registry/revisions/:kind/:slug/:revision/consent` | machine | `user:ADMIN` | Hermes registry, machine-only by instruction. |
| POST | `/api/v1/hermes-registry/sources/refresh` | machine | `user:ADMIN\|OPERATOR` | Hermes registry, machine-only by instruction. |
| GET | `/api/v1/hermes-registry/status` | machine | `user:any` | Hermes registry, machine-only by instruction. |
| POST | `/api/v1/hermes-registry/targets` | machine | `user:ADMIN\|OPERATOR` | Hermes registry, machine-only by instruction. |
| POST | `/api/v1/hermes-registry/tool-surface` | machine | `service-digest:hermes-registry-client` | Hermes registry, machine-only by instruction. |
| GET | `/api/v1/hiveskills/jobs/:id` | machine | `service-digest:hiveskills` | Registry executor with an endpoint-scoped credential. |
| POST | `/api/v1/hiveskills/jobs/:id` | machine | `service-digest:hiveskills` | Registry executor with an endpoint-scoped credential. |
| GET | `/api/v1/hiveskills/targets/:target` | machine | `service-digest:hiveskills` | Registry executor with an endpoint-scoped credential. |
| POST | `/api/v1/logs/ingest` | machine | `hmac` | Agent ingest with a per-node signed credential; the dashboard error reporter cannot supply it. |
| GET | `/api/v1/mcp` | machine | `user:any` | Read-only MCP integration, machine-only by instruction. |
| POST | `/api/v1/mcp` | machine | `user:any` | Read-only MCP integration, machine-only by instruction. |
| POST | `/api/v1/resource-leases/claim` | machine | `node-token` | Agent coordination with the node credential. |
| GET | `/api/v1/resource-leases/enrollment/:nodeId` | machine | `user:ADMIN\|OPERATOR` | Resource-lease enrollment, machine-only by instruction. |
| POST | `/api/v1/resource-leases/enrollment/:nodeId/api-attest` | machine | `user:ADMIN` | Resource-lease enrollment, machine-only by instruction. |
| GET | `/api/v1/resource-leases/enrollment/:nodeId/ardent-scope` | machine | `user:ADMIN\|OPERATOR` | Resource-lease enrollment, machine-only by instruction. |
| POST | `/api/v1/resource-leases/enrollment/:nodeId/ardent-scope/activate` | machine | `user:ADMIN` | Resource-lease enrollment, machine-only by instruction. |
| POST | `/api/v1/resource-leases/enrollment/:nodeId/begin` | machine | `user:ADMIN` | Resource-lease enrollment, machine-only by instruction. |
| POST | `/api/v1/resource-leases/enrollment/:nodeId/complete` | machine | `user:ADMIN` | Resource-lease enrollment, machine-only by instruction. |
| POST | `/api/v1/resource-leases/enrollment/:nodeId/refresh` | machine | `user:ADMIN` | Resource-lease enrollment, machine-only by instruction. |
| POST | `/api/v1/resource-leases/enrollment/:nodeId/scheduler-boundary-attest` | machine | `user:ADMIN` | Resource-lease enrollment, machine-only by instruction. |
| POST | `/api/v1/resource-leases/enrollment/dashboard/readiness` | machine | `service-secret:resource-drain` | Resource-lease enrollment, machine-only by instruction. |
| POST | `/api/v1/resource-leases/enrollment/dashboard/status` | machine | `service-secret:resource-drain` | Resource-lease enrollment, machine-only by instruction. |
| POST | `/api/v1/resource-leases/enrollment/dashboard/work/:workId/finish` | machine | `service-secret:resource-drain` | Resource-lease enrollment, machine-only by instruction. |
| POST | `/api/v1/resource-leases/enrollment/dashboard/work/:workId/start` | machine | `service-secret:resource-drain` | Resource-lease enrollment, machine-only by instruction. |
| POST | `/api/v1/resource-leases/enrollment/dashboard/work/reserve` | machine | `service-secret:resource-drain` | Resource-lease enrollment, machine-only by instruction. |
| POST | `/api/v1/resource-leases/enrollment/node-status` | machine | `node-token` | Resource-lease enrollment, machine-only by instruction. |
| POST | `/api/v1/resource-leases/enrollment/scheduler-status` | machine | `node-token` | Resource-lease enrollment, machine-only by instruction. |
| GET | `/api/v1/resource-leases/enrollment/work/:workId/historical` | machine | `user:ADMIN` | Resource-lease enrollment, machine-only by instruction. |
| POST | `/api/v1/resource-leases/enrollment/work/:workId/historical-reconcile` | machine | `user:ADMIN` | Resource-lease enrollment, machine-only by instruction. |
| POST | `/api/v1/resource-leases/enrollment/work/:workId/node-receipt` | machine | `node-token` | Resource-lease enrollment, machine-only by instruction. |
| POST | `/api/v1/resource-leases/enrollment/work/:workId/reconcile` | machine | `user:ADMIN` | Resource-lease enrollment, machine-only by instruction. |
| POST | `/api/v1/resource-leases/legacy-admission` | machine | `node-token` | Agent coordination with the node credential. |
| POST | `/api/v1/resource-leases/recovery-claim` | machine | `node-token` | Agent coordination with the node credential. |
| POST | `/api/v1/resource-leases/transfer/authority-snapshot` | machine | `node-token` | Agent coordination with the node credential. |
| POST | `/api/v1/security-integration/backups` | machine | `service-digest:security-backup` | Security integration, machine-only by instruction. |
| GET | `/api/v1/security-integration/inventory` | machine | `service-digest:security-inventory` | Security integration, machine-only by instruction. |
| GET | `/api/v1/security-integration/response/:id` | machine | `hmac` | Security integration, machine-only by instruction. |
| POST | `/api/v1/security-integration/response/execute` | machine | `hmac` | Security integration, machine-only by instruction. |
| GET | `/api/v1/security-integration/response/targets/:id/health` | machine | `hmac` | Security integration, machine-only by instruction. |
| GET | `/api/v1/security-integration/summary` | machine | `user:any` | Security integration, machine-only by instruction. |
| GET | `/api/v1/shared-resource-leases/:leaseId` | machine | `user:ADMIN\|OPERATOR` | Shared resource leases, machine-only by instruction. |
| POST | `/api/v1/shared-resource-leases/:leaseId/reconcile` | machine | `user:ADMIN` | Shared resource leases, machine-only by instruction. |
| POST | `/api/v1/shared-resource-leases/:leaseId/settle` | machine | `user:ADMIN\|OPERATOR` | Shared resource leases, machine-only by instruction. |
| POST | `/api/v1/shared-resource-leases/:leaseId/start` | machine | `user:ADMIN\|OPERATOR` | Shared resource leases, machine-only by instruction. |
| POST | `/api/v1/shared-resource-leases/:leaseId/unknown` | machine | `user:ADMIN\|OPERATOR` | Shared resource leases, machine-only by instruction. |
| GET | `/api/v1/shared-resource-leases/operation/:operationId` | machine | `user:ADMIN\|OPERATOR` | Shared resource leases, machine-only by instruction. |
| POST | `/api/v1/shared-resource-leases/reserve` | machine | `user:ADMIN\|OPERATOR` | Shared resource leases, machine-only by instruction. |
| POST | `/api/v1/team-approvals/decisions` | machine | `service-digest:approval-bridge` | Approval bridge only; rejects every other caller. |
| GET | `/api/v1/team-approvals/plans` | machine | `service-digest:approval-bridge` | Approval bridge only; rejects every other caller. |
| GET | `/api/v1/team-approvals/plans/:id` | machine | `service-digest:approval-bridge` | Approval bridge only; rejects every other caller. |

## Not exposed

| Method | Path pattern | Class | Auth | Why |
|---|---|---|---|---|
| GET | `/api/docs` | exclude | `public` | API documentation UI; not part of the console. |
| GET | `/api/v1/agents/upgrade/runs/latest` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/ai-schedules` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/ai-schedules` | exclude | `user:ADMIN\|OPERATOR` | No dashboard call site. Add when a console feature needs it. |
| DELETE | `/api/v1/ai-schedules/:id` | exclude | `user:ADMIN\|OPERATOR` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/ai-schedules/:id` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| PATCH | `/api/v1/ai-schedules/:id` | exclude | `user:ADMIN\|OPERATOR` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/ai-schedules/execute-due` | exclude | `user:ADMIN` | Scheduler trigger intended for automation. |
| GET | `/api/v1/alerts/rules` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/alerts/rules` | exclude | `user:ADMIN` | No dashboard call site. Add when a console feature needs it. |
| DELETE | `/api/v1/alerts/rules/:id` | exclude | `user:ADMIN` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/alerts/rules/:id` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| PATCH | `/api/v1/alerts/rules/:id` | exclude | `user:ADMIN` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/alerts/violations` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/anomalies/:id/resolve` | exclude | `user:ADMIN\|OPERATOR` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/anomalies/:nodeId` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/anomalies/:nodeId/summary` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/anomalies/correlations` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/anomalies/purge` | exclude | `user:ADMIN` | Bulk destructive maintenance with no console caller. |
| POST | `/api/v1/anomalies/resolve-node` | exclude | `user:ADMIN\|OPERATOR` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/anomalies/timeline` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/ardent/installations/:nodeId/profiles/:name/context-adoptions/:releaseId` | exclude | `user:ADMIN` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/ardent/installations/:nodeId/profiles/:name/context-release` | exclude | `user:ADMIN` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/assistant/chat` | exclude | `user:ADMIN\|OPERATOR` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| POST | `/api/v1/assistant/chat/stream` | exclude | `user:ADMIN\|OPERATOR` | No dashboard call site. Add when a console feature needs it. |
| DELETE | `/api/v1/assistant/conversations/:id` | exclude | `user:ADMIN\|OPERATOR` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/assistant/conversations/:id` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| POST | `/api/v1/assistant/conversations/:id/archive` | exclude | `user:ADMIN\|OPERATOR` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/assistant/conversations/:id/export` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| POST | `/api/v1/assistant/conversations/:id/fork` | exclude | `user:ADMIN\|OPERATOR` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| POST | `/api/v1/assistant/conversations/:id/read` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| DELETE | `/api/v1/assistant/conversations/:id/scratchpad` | exclude | `user:ADMIN\|OPERATOR` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/assistant/conversations/:id/scratchpad` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| POST | `/api/v1/assistant/conversations/:id/share` | exclude | `user:ADMIN\|OPERATOR` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| DELETE | `/api/v1/assistant/heartbeat-prompt` | exclude | `user:ADMIN` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/assistant/heartbeat-prompt` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| PUT | `/api/v1/assistant/heartbeat-prompt` | exclude | `user:ADMIN` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| POST | `/api/v1/assistant/messages/:id/approve` | exclude | `user:ADMIN\|OPERATOR` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| POST | `/api/v1/assistant/messages/:id/confirm` | exclude | `user:ADMIN\|OPERATOR` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| POST | `/api/v1/assistant/messages/:id/reject` | exclude | `user:ADMIN\|OPERATOR` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| POST | `/api/v1/assistant/messages/read` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/assistant/model-profiles` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| PATCH | `/api/v1/assistant/model-profiles` | exclude | `user:ADMIN` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/assistant/models` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/assistant/models/:name/context` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/assistant/settings` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| PATCH | `/api/v1/assistant/settings` | exclude | `user:ADMIN` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/assistant/unread` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/audit/commands/export` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/audit/export` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/audit/logs/export` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/audit/verify` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/auth/login` | exclude | `public` | Local password login; the console authenticates elsewhere. |
| POST | `/api/v1/commands/:commandId/reconcile-resource` | exclude | `user:ADMIN\|OPERATOR` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/commands/:commandId/resource-lease` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/credentials/:name/retire-previous` | exclude | `user:ADMIN` | Credential lifecycle action for reviewed runbooks; no console caller. |
| GET | `/api/v1/credentials/:name/status` | exclude | `user:ADMIN` | Credential lifecycle status for reviewed runbooks; no console caller. |
| GET | `/api/v1/credentials/rotations` | exclude | `user:ADMIN` | Credential lifecycle status for reviewed runbooks; no console caller. |
| POST | `/api/v1/cron/:cronId/managed` | exclude | `user:ADMIN` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/cron/scheduler-sources/reconcile` | exclude | `user:ADMIN` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/dependencies/scan` | exclude | `user:ADMIN\|OPERATOR` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/drift/:nodeId` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/drift/:nodeId/latest` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/drift/scan` | exclude | `user:ADMIN\|OPERATOR` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/fleet-checks/files` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/fleet-checks/latest` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/fleet-checks/runs` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/health/dependencies` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/health/details` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/health/forecast/at-risk` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/hermes/installations/:id` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/hermes/jobs` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/hermes/jobs/:id` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/hermes/profiles/:id/api-server/status` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| POST | `/api/v1/nodes/:nodeId/change-password` | exclude | `user:ADMIN\|OPERATOR` | Handles OS passwords in the body; no console caller. |
| POST | `/api/v1/nodes/:nodeId/provision-user` | exclude | `user:ADMIN\|OPERATOR` | Handles OS passwords in the body; no console caller. |
| POST | `/api/v1/nodes/:nodeId/repair-address` | exclude | `user:ADMIN\|OPERATOR` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/nodes/:nodeId/wazuh` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/nodes/compare` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/nodes/scan-users` | exclude | `user:ADMIN\|OPERATOR` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/nodes/tags` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/nodes/tags/bulk` | exclude | `user:ADMIN\|OPERATOR` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/nodes/wazuh/summary` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/ops/codex-fleet-status` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/ops/engineering/catalog` | exclude | `user:ADMIN\|OPERATOR` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/ops/engineering/delivery-assessment` | exclude | `user:ADMIN\|OPERATOR` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/ops/engineering/dependency-impact` | exclude | `user:ADMIN\|OPERATOR` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/ops/engineering/forecast-assessment` | exclude | `user:ADMIN\|OPERATOR` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/ops/engineering/restore-assessment` | exclude | `user:ADMIN\|OPERATOR` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/ops/engineering/runbook-assessment` | exclude | `user:ADMIN\|OPERATOR` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/ops/lessons/:id/supersede` | exclude | `user:ADMIN\|OPERATOR` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/ops/observations` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/ops/package-security-posture` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/ops/predictive-maintenance` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/ops/remediation-plan/classify` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/ops/trace-map` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/orchestra/installations/:id` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/orchestra/installations/:id/profiles` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/orchestra/jobs` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/orchestra/jobs/:id` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/orchestra/profiles/:id/api-server/status` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/predictions` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/predictions/:nodeId` | exclude | `user:any` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/profiling` | exclude | `user:ADMIN\|OPERATOR` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/profiling/:nodeId` | exclude | `user:ADMIN\|OPERATOR` | No dashboard call site. Add when a console feature needs it. |
| GET | `/api/v1/remediation/rules/:id` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/resource-leases/admission/:nodeId` | exclude | `user:ADMIN\|OPERATOR` | Operator runbook control for node admission fences; no console caller. |
| POST | `/api/v1/resource-leases/admission/:nodeId/close` | exclude | `user:ADMIN` | Operator runbook control for node admission fences; no console caller. |
| POST | `/api/v1/resource-leases/admission/:nodeId/release` | exclude | `user:ADMIN` | Operator runbook control for node admission fences; no console caller. |
| GET | `/api/v1/resource-leases/ssh-admission` | exclude | `user:ADMIN\|OPERATOR` | Server-side terminal admission decision. |
| GET | `/api/v1/roles/applications/:appId` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| POST | `/api/v1/rollouts` | exclude | `user:ADMIN\|OPERATOR` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/rollouts/:id/cancel` | exclude | `user:ADMIN` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/self-update/apply` | exclude | `user:ADMIN` | Legacy host self-update: 410 unless an environment flag re-enables it; pulls and rebuilds on the host. |
| POST | `/api/v1/self-update/check` | exclude | `user:ADMIN\|OPERATOR` | Legacy host self-update: 410 unless an environment flag re-enables it. |
| POST | `/api/v1/self-update/restart` | exclude | `user:ADMIN` | Legacy host self-update: 410 unless an environment flag re-enables it; restarts the service. |
| GET | `/api/v1/self-update/work/:workId` | exclude | `user:ADMIN\|OPERATOR` | No dashboard call site. Add when a console feature needs it. |
| POST | `/api/v1/skills` | exclude | `user:ADMIN\|OPERATOR` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| DELETE | `/api/v1/skills/:name{[a-zA-Z0-9_-]+}` | exclude | `user:ADMIN` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/skills/:name{[a-zA-Z0-9_-]+}` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| PATCH | `/api/v1/skills/:name{[a-zA-Z0-9_-]+}` | exclude | `user:ADMIN\|OPERATOR` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/skills/:name{[a-zA-Z0-9_-]+}/files/:fileName` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| PUT | `/api/v1/skills/:name{[a-zA-Z0-9_-]+}/files/:fileName` | exclude | `user:ADMIN\|OPERATOR` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/skills/installations/:nodeId` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| POST | `/api/v1/skills/push` | exclude | `user:ADMIN\|OPERATOR` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/skills/registry` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| DELETE | `/api/v1/skills/registry/:slug` | exclude | `user:ADMIN` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/skills/registry/:slug` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| POST | `/api/v1/skills/registry/:slug/publish` | exclude | `user:ADMIN\|OPERATOR` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| POST | `/api/v1/skills/registry/:slug/tags` | exclude | `user:ADMIN\|OPERATOR` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/skills/registry/:slug/versions` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/skills/registry/:slug/versions/:version` | exclude | `user:any` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| POST | `/api/v1/skills/registry/sync` | exclude | `user:ADMIN\|OPERATOR` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| POST | `/api/v1/system/updates/check` | exclude | `user:ADMIN\|OPERATOR` | No call site: an unused client wrapper only. Add when a console feature needs it. |
| GET | `/api/v1/users` | exclude | `user:ADMIN` | Local account administration; the console identity is managed elsewhere and has no caller here. |
| POST | `/api/v1/users` | exclude | `user:ADMIN` | Local account administration; the console identity is managed elsewhere and has no caller here. |
| DELETE | `/api/v1/users/:id` | exclude | `user:ADMIN` | Local account administration; the console identity is managed elsewhere and has no caller here. |
| GET | `/api/v1/users/:id` | exclude | `user:any (self or ADMIN, checked in handler)` | Local account administration; the console identity is managed elsewhere and has no caller here. |
| PATCH | `/api/v1/users/:id` | exclude | `user:ADMIN` | Local account administration; the console identity is managed elsewhere and has no caller here. |
| PUT | `/api/v1/users/:id/password` | exclude | `user:any (self or ADMIN, checked in handler)` | Local account administration; the console identity is managed elsewhere and has no caller here. |
| POST | `/api/v1/webhooks/dispatch` | exclude | `user:ADMIN` | Server-side event injection written for system callers. |
| GET | `/metrics` | exclude | `service-secret:metrics` | Metrics scrape endpoint with its own bearer token. |

## Retired

| Method | Path pattern | Class | Auth | Why |
|---|---|---|---|---|
| GET | `/api/v1/commands/:commandId/stream` | retired | `retired-410` | Permanent 410 stub after a 404 check; use events and result routes. |
| POST | `/api/v1/credentials/:name/rollout` | retired | `retired-410` | Permanent 410 stub. |
| POST | `/api/v1/credentials/rotate` | retired | `retired-410` | Permanent 410 stub. |
| ALL | `/api/v1/deploy/*` | retired | `retired-410` | Permanent 410 catch-all after authentication. |
| POST | `/api/v1/heartbeat/stream` | retired | `retired-410` | Permanent 410 stub, reachable without credentials. |
| ALL | `/api/v1/hermes/*` | retired | `retired-410` | Permanent 410 catch-all for retired SSH-backed operations. |
| POST | `/api/v1/nodes/:nodeId/migrate` | retired | `retired-410` | Permanent 410 stub. |
| ALL | `/api/v1/orchestra/*` | retired | `retired-410` | Permanent 410 catch-all; shadows the whole orchestra router. |
| GET | `/api/v1/orchestra/capabilities` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| GET | `/api/v1/orchestra/credential-pools` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| POST | `/api/v1/orchestra/credential-pools` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| DELETE | `/api/v1/orchestra/credential-pools/:id` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| PATCH | `/api/v1/orchestra/credential-pools/:id` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| POST | `/api/v1/orchestra/credential-pools/:id/attach` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| DELETE | `/api/v1/orchestra/credential-pools/attachments/:attachmentId` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| GET | `/api/v1/orchestra/cron-jobs` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| POST | `/api/v1/orchestra/cron-jobs` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| DELETE | `/api/v1/orchestra/cron-jobs/:id` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| PATCH | `/api/v1/orchestra/cron-jobs/:id` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| GET | `/api/v1/orchestra/hooks` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| POST | `/api/v1/orchestra/hooks` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| DELETE | `/api/v1/orchestra/hooks/:id` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| PATCH | `/api/v1/orchestra/hooks/:id` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| POST | `/api/v1/orchestra/jobs/:id/cancel` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| GET | `/api/v1/orchestra/mcp-servers` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| POST | `/api/v1/orchestra/mcp-servers` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| DELETE | `/api/v1/orchestra/mcp-servers/:id` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| PATCH | `/api/v1/orchestra/mcp-servers/:id` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| POST | `/api/v1/orchestra/mcp-servers/:id/attach` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| DELETE | `/api/v1/orchestra/mcp-servers/attachments/:attachmentId` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| GET | `/api/v1/orchestra/messaging-bindings` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| POST | `/api/v1/orchestra/messaging-bindings` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| DELETE | `/api/v1/orchestra/messaging-bindings/:id` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| PATCH | `/api/v1/orchestra/messaging-bindings/:id` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| GET | `/api/v1/orchestra/overview` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| GET | `/api/v1/orchestra/plugins` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| POST | `/api/v1/orchestra/plugins` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| DELETE | `/api/v1/orchestra/plugins/:id` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| GET | `/api/v1/orchestra/providers` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| PUT | `/api/v1/orchestra/providers` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| POST | `/api/v1/orchestra/providers/test` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| GET | `/api/v1/orchestra/roles` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| POST | `/api/v1/orchestra/roles` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| DELETE | `/api/v1/orchestra/roles/:id` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| GET | `/api/v1/orchestra/roles/:id` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| PATCH | `/api/v1/orchestra/roles/:id` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| POST | `/api/v1/orchestra/roles/:id/apply` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| GET | `/api/v1/orchestra/roles/:id/child-preview` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| GET | `/api/v1/orchestra/skill-assignments` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| POST | `/api/v1/orchestra/skill-assignments` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| DELETE | `/api/v1/orchestra/skill-assignments/:id` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| PATCH | `/api/v1/orchestra/skill-assignments/:id` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| POST | `/api/v1/orchestra/skill-bundles/apply` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| POST | `/api/v1/orchestra/skill-bundles/preview` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| GET | `/api/v1/orchestra/skill-catalog` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| GET | `/api/v1/orchestra/skill-catalog/:slug/audit` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| POST | `/api/v1/orchestra/skill-catalog/:slug/quarantine` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| POST | `/api/v1/orchestra/skill-catalog/install` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| GET | `/api/v1/orchestra/toolset-policies` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| PUT | `/api/v1/orchestra/toolset-policies` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| DELETE | `/api/v1/orchestra/toolset-policies/:id` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| PATCH | `/api/v1/orchestra/toolset-policies/:id` | retired | `retired-410` | Shadowed: the hermes catch-all is mounted first on this prefix, so this always returns 410. |
| ALL | `/api/v1/security-fusion/*` | retired | `retired-410` | Permanent 410 stub, or 404 when the mode is off; moved to the security console. |
| POST | `/api/v1/terminal/ticket` | retired | `retired-410` | Permanent 410 stub after authentication; the fleet gateway carries the terminal. |
