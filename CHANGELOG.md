# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/).


## [Unreleased]

A supervised agent no longer leaves an unknown command owner behind when it refuses a command, and
an ADMIN can settle an unknown non-Ardent command from the API and the console. The OpenAPI document
covers every route, and the console's mission-control Hermes counts come from a new ADMIN route. The
standalone console re-encrypts control-node credentials left under the legacy `JWT_SECRET`-derived
key when it starts. No migration, and no new setting.

### Upgrade notes

- **Upgrade the node agents, then the server and console.** A supervised agent
  (`MAGNUS_EXECUTION_SUPERVISOR_ENABLED=true`, as a full-node install sets it) now refuses a command
  outside the command completion registry with 409 `UNREGISTERED_COMMAND` before anything starts,
  instead of running it in a transient `magnus-exec-*.service` unit and then holding it as an
  unknown outcome. Such commands never succeeded on a supervised agent; they now fail cleanly.
- Leases that earlier agents left `unknown` this way are not settled by the upgrade: settle each
  with the new ADMIN decision (see below), and stop the leftover units of settled commands
  ([UPGRADING.md](UPGRADING.md#unreleased-refused-commands-and-non-ardent-reconciliation)).
- **HiveSkills executor: Oathweave service tokens, static bearer deprecated.** Nothing changes until
  you add a `HIVESKILLS_SERVICE` link. Add it only once the server and the fleet gateway both run
  this release (an earlier one refuses the unknown link role at startup), and remove it before
  rolling back. Keep `tokenSha256` until the registry sends Oathweave tokens, then drop it.
- Upgrade the server before the console: the console's mission-control Hermes tiles read the new
  `GET /api/v1/hermes/summary` and show "Hermes Agent data unavailable" against an older server.
- Scripts or integrations that read the error bodies of the shared-credential, security inventory
  and backup, MCP, AI schedule or remediation-rule routes: they now answer the standard
  `{ success: false, error: { code, message } }` envelope, with the same status codes (see Changed).
- **Console: reload open Hermes dashboards after the upgrade.** A dashboard tab or frame opened
  before it keeps calling the old URLs, which now redirect or need a grant; reconnecting the frame
  fixes it. Inside the sandbox, dashboard preferences (theme, language) last only until the frame
  reloads, and clipboard writes from the frame may be refused. Nothing to configure.

### Added

- HiveSkills executor routes (`/api/v1/hiveskills/jobs/:id`, `/api/v1/hiveskills/targets/:target`)
  accept an Oathweave client-credentials token: audience `magnus`, the permission
  `magnus:hiveskills`, a service principal only, from a client linked in
  `MAGNUS_OATHWEAVE_IDENTITIES_JSON` with the new role `HIVESKILLS_SERVICE` whose `localUserId` names
  the registry in `MAGNUS_HIVESKILLS_DEPLOYMENTS_JSON`. A person's token, an Ardent service client,
  another audience, a missing permission or a registry without a grant is refused before anything is
  admitted, and a refused Oathweave token is never tried as the static credential. The link reaches
  no other route. The audit actor stays `service:hiveskills:<registryId>`, so jobs admitted with
  either credential reconcile with the other; `skill.push` records `authentication` (`oathweave`
  with the client ID, or `static`). `tokenSha256` is now optional, so a registry can rely on
  Oathweave alone ([server README](services/control-api/README.md#hiveskills-execution-bridge)).
- `@hivemagnus/magnus-oathweave`: `isServiceLink` and `OATHWEAVE_SERVICE_LINK_ROLES`. A person never
  authenticates or acts (`x-acting-subject`) through any service link.
- **Console: legacy control-node credentials are re-encrypted at start.** Saved control-node API
  secrets and tokens still encrypted under the old `JWT_SECRET`-derived key (and any never
  encrypted) are re-encrypted under `CONTROL_NODE_CREDENTIAL_KEY` before the console serves a
  request: idempotent, after a `0600` backup of `.magnus/control-nodes.json`, verified by
  decrypting every new value, written atomically and logged without values. A value that does not
  decrypt, or a `CONTROL_NODE_CREDENTIAL_KEY` that does not decrypt the values already stored under
  it, leaves the file unchanged, and the console keeps reading it as before. `magnus-ui
  credentials` prints the file it checked and counts what remains (exit 1 while any legacy value
  does, 3 when there is no state file), `--reencrypt` runs the step without a restart, and
  `magnus-ui check` warns about it. The rewrite runs only as the file's owner (`magnus-ui
  credentials` run as root first drops to that user and group; any other account is refused) and
  holds `control-nodes.json.lock`, which the console's control-node saves and read-time migrations
  now take as well, inside the store's write queue. The lock carries the holder's pid and a nonce;
  only a lock whose holder is gone is taken over, and only its holder removes it
  ([UPGRADING.md](UPGRADING.md#unreleased-legacy-control-node-credentials-re-encrypted-at-console-start)).
- `POST /api/v1/commands/{commandId}/reconcile-resource` takes an ADMIN's decision
  `{ disposition: effects_verified | no_effect_verified, reason }` for any command that is not an
  Ardent action, as the Ardent `command-reconcile` action does for Ardent actions: the node's own
  result or decision, or a signed ledger trace that proves the command never ran, settles the owner
  first; only an outcome the node agent itself records as `unknown` takes the decision, which the
  server signs for that node and the agent records under its execution lock. Managed scheduler
  occurrences and skill publications are refused (`RETAINED_EVIDENCE_REQUIRED`), since they settle
  only from their own retained evidence. Every attempt is audited as `command.resource_reconcile`. Operators can still only read receipts or submit an
  assertion already signed for the node.
- Console: the Ardent installations page reconciles a held node command through that route, with the
  same review and confirmation as an Ardent action, instead of pointing at the API. It offers no
  decision for a scheduler occurrence or skill publication (`reconcilable: false` on the owner).
- Contracts: `CommandReconcileDecisionSchema`, `CommandReconcileDecisionResultSchema` and the optional
  `reconcilable` flag on `ArdentCommandOwnerSchema`.
- `POST /api/v1/discovery/scan` is rate limited to 6 scans a minute per caller (fail closed), now that it
  is a browser route.
- `GET /api/v1/hermes/summary` (any role, like the lists it counts) returns the mission-control Hermes counts (installations,
  healthy installations, profiles, running gateways), computed by the server over the same lists
  `GET /hermes/installations` and `GET /hermes/profiles` return, so HiveXUI can show the tiles
  without its own server. The console's mission-control page reads it instead of counting the lists
  itself. It is not served under the deprecated `/orchestra` alias.
- Browser contract: `hermesSummaryResponseSchema`, `heartbeatStreamStatsResponseSchema`,
  `discoveryScanRequestSchema` and `discoveryScanResponseSchema`, with route entries for
  `GET /hermes/summary`, `GET /heartbeat/stream/stats` and `POST /discovery/scan`.
- **The OpenAPI document covers every mounted route.** The 123 routes that had no entry (assistant,
  AI schedules, MCP, anomalies, predictions, drift, topology, profiling, alerts, remediation,
  rollouts, fleet checks, credentials, security integration, node utilities, managed cron, resource
  leases, fleet gateway and the Hermes reads) are documented from their handlers: roles, parameters,
  request and response schemas and the errors they return. Routes the browser contract publishes take
  their schemas from `@hivemagnus/magnus-contracts/browser`. `undocumented-routes.json` is gone: the
  route test now fails for any mounted route without an entry.
- `npm run openapi:check` validates the document as OpenAPI 3.1 (every `$ref` resolves), fails on an
  undeclared tag or an unknown security scheme, and generates TypeScript types from it with
  `openapi-typescript`, so a client can always be generated. The repository ships no generated
  client of its own API.
- Docs: [Hosting the Hermes dashboard in HiveXUI](docs/HERMES_DASHBOARD_HIVEXUI.md), a design note.

### Changed

- `npm run docs:check` (and so `npm run verify` and CI) fails when a document names a version that
  is no longer current (`scripts/check-doc-versions.mjs`, tests in `npm run docs:test`): Magnus
  package and image versions, "pins Ardent X" (must match the agent's `@hivemagnus/ardent`
  dependency), links into a Hive suite release, and "Hive X.Y.Z pins …" claims, which name no version
  because the signed suite release manifest is their only source. `CHANGELOG.md` and `UPGRADING.md`
  (per-release history) are exempt. `docs/ARDENT.md` no longer ties the extension release order to
  Ardent 3.2.0.
- **Standard error envelope.** `/api/v1/credentials/*` (400 `UNKNOWN_CREDENTIAL`, 410
  `CREDENTIAL_ROTATION_RETIRED` and `CREDENTIAL_ROLLOUT_RETIRED`), `GET /security-integration/inventory`
  and `POST /security-integration/backups` (401 `UNAUTHORIZED`, 400 `VALIDATION_ERROR`, 409
  `BACKUP_UPLOAD_ACTIVE`, 503 `BACKUP_TRANSFER_FAILED`), `POST /mcp` (400 `UNSUPPORTED_METHOD`, 404
  `UNKNOWN_TOOL`), `GET /ai-schedules/:id` and `GET /remediation/rules/:id` (404 `NOT_FOUND`) answered
  errors as a bare string or `{ error, message }`; they now use `{ success: false, error: { code, message } }`
  like every other route. Status codes are unchanged. Neither the console nor HiveXUI read the old shapes.
- `GET /security-integration/inventory` skips a node that is not a valid target and lists it in a new
  `skipped` array (`{ id, name, reason }`, reason `agent_tls_required` or `invalid_target`), instead of
  failing the whole export with 500. Contracts: `securityInventorySkippedSchema` and an optional `skipped`
  on `securityInventoryExportSchema`.
- The fleet check routes (`GET /fleet-checks/runs`, `/latest`, `/files`) return the server's log
  `directory` to ADMIN only; other roles, including the read-only plugin and fleet-check credentials,
  get the same body without it.
- Marking the shared heartbeat conversation read takes ADMIN or OPERATOR. Read state is one flag per
  message, shared by everyone, so a VIEWER could clear it for every user: `POST /assistant/conversations/:id/read`
  now answers 403 to a VIEWER for that conversation, and `POST /assistant/messages/read` leaves its
  messages unread for a VIEWER. A caller's own conversations are unchanged.
- `PATCH /assistant/settings` and `PATCH /assistant/model-profiles` validate their bodies (types,
  enums and bounds; the read-only settings fields a client echoes back are ignored, and unknown
  fields are no longer stored).
- Audited now: assistant heartbeat prompt changes (`assistant.heartbeat_prompt.update` with the
  length only, `.reset`), settings (`assistant.settings.update`, without the system prompt text) and
  model routes (`assistant.model_profiles.update`); AI schedule `ai_schedule.create`, `.update`,
  `.delete`, and every run, from the scheduler or `POST /ai-schedules/execute-due`, as
  `ai_schedule.run` with its outcome; a `POST /drift/scan` whose agent call failed (`drift.scan`
  with status `error`); and anomaly changes: `anomaly.resolve`, `anomaly.resolve_node` (node,
  metric and number resolved) and `anomaly.purge` (`retentionDays` and number deleted).
- Shared-credential status: `configured` (false for `NODE_MANAGER_SECRET` in node-key enforce mode
  without one), and `activeFingerprint` is null then.
- Console route inventory: `POST /api/v1/discovery/scan` (ADMIN or OPERATOR) and
  `GET /api/v1/heartbeat/stream/stats` (any role) move from `machine` to `browser`, with the same
  authentication as before, so a static console can offer the nodes page's network scan and the
  mission-control heartbeat stream panel. An ingress that follows the inventory allows them, and
  `GET /api/v1/hermes/summary`, from this release. The rest of `/heartbeat` and `/discovery` stays
  machine-only.
- Documentation, env examples and CLI output call the integrations by their current names:
  Oathweave (formerly Hive IAM) and Emberpath (formerly Hive Router). `magnus-server check` lists
  `External IAM` (marked deprecated when on) and `Model router`, and `magnus-ui check` lists
  `Emberpath admin (deprecated)` and `OIDC login`. No variable is renamed: `HIVE_OAUTH_*`,
  `HIVE_ROUTER_*` and `IAM_*` keep working, as does the `hive-router` application-probe kind.
- Console CI: the browser suite also runs the sign-in, navigation, overview, API docs and webhook
  specs, a sign-in lockout test (five wrong passwords, then even the right one gets `429` with
  `Retry-After` until the window ends) and an axe-core (`@axe-core/playwright` 4.14.0) WCAG 2.1 AA
  scan of 28 console pages and the command palette that fails on serious or critical findings.

### Security

- **Console: the embedded Hermes dashboard and router admin UI no longer run with console
  authority.** Both proxies (`/api/hermes/dashboard`, `/api/hive-router/dashboard`) serve every
  response with a `sandbox` Content Security Policy without `allow-same-origin`, and the Web Gateway
  frame drops `allow-same-origin`, so the dashboard's script runs in an opaque origin, also in its own
  tab. The entry URL needs the console session, only from the console itself or a typed address, and
  redirects to `…/_frame/<grant>/…`: a grant signed with a key derived from `SESSION_SECRET`, scoped
  to that dashboard (and Hermes installation), valid for 10 minutes (never past the console session)
  and void once that session ends. The console frame renews it through `postMessage` before it
  expires, and a reload with the console cookie re-mints it, so a grant copied from a log or the
  history is useless within minutes. Frame requests and the Hermes WebSocket bridge accept only the
  grant (and `Origin: null` for the sandboxed page); they ignore console cookies and set none. An
  open Hermes WebSocket (the PTY included) re-checks its console session every 30 seconds and closes
  when it is signed out or revoked. The frame policy adds `connect-src 'self'`. The Hermes session
  token stays on the server per console session and installation (the page sees a placeholder), the
  router's cookies likewise, and signing out clears both (signing out everywhere, only that
  user's). An expired grant still loads static build files; that exemption and every forwarded
  path are decided on one re-encoded, traversal-free path, so encoded traversals
  (`%2e%2e`, `%252e%252e`, `..%2f`, `%5c`) never reach an API.
- **Console: cross-site API reads are refused.** Any `/api` request with `Origin: null`, and any
  cross-site or same-site `/api` request that is not a navigation, gets 403
  `cross_site_request_refused`, as cross-site writes already did. Navigations (the sign-in callback)
  and the public endpoints are unchanged.

### Deprecated

- The static HiveSkills executor bearer (`tokenSha256` in `MAGNUS_HIVESKILLS_DEPLOYMENTS_JSON`).
  It keeps working beside an Oathweave link; the server logs a warning the first time each registry
  uses it.

### Fixed

- Invalid JSON answered 500 instead of 400 `VALIDATION_ERROR` on `POST /assistant/chat`,
  `/assistant/chat/stream` and `/assistant/messages/read`, `PATCH /assistant/settings` and
  `/assistant/model-profiles`, `POST /anomalies/resolve-node`, and on `PUT /assistant/heartbeat-prompt`
  (also when `content` is not a string).
- `POST /anomalies/purge` accepts only a whole `retentionDays` from 1 to 3650 (default 30); zero or a
  negative value deleted every resolved anomaly. A body that is not valid JSON answers 400 instead of
  purging with the default; only an empty body keeps it.
- `GET /nodes/:nodeId/health/timeseries?metric=disk` was always 0: it read `usePercent`, but agents
  report `usagePercent`.
- `GET /credentials/NODE_MANAGER_SECRET/status` and `POST …/retire-previous` answered 500 in node-key
  enforce mode without a shared node secret; they now answer `configured: false` (retire still removes
  a previous value left from an earlier rotation), and `GET /credentials/rotations` lists a leftover
  record of it the same way.
- `GET /hermes/profiles/:id/api-server/status` (and its `/orchestra` alias) answers 404 for an unknown
  profile instead of 500.
- Browser contract: `topologyScanRequestSchema` caps `probeTimeoutMs` at 15000, as the server does.
- Console: the discovery scan result is typed with the server's `version` field (it was typed as
  `agentVersion`).
- Console: the router admin proxy no longer rewrites an asset URL twice (`/assets/` became
  `…/dashboard/api/hive-router/dashboard/assets/`).
- Console: the `/dashboard-plugins/*` and `/kanban` rewrites into the Hermes proxy are gone; they
  could not work from the sandboxed frame, which reaches the dashboard through its frame URL.
- HiveSkills executor routes refuse a target or a registry named like an inherited object property
  (`constructor`, for example) with 403 instead of an internal error.
- Agent: a supervised agent refuses a command it cannot prove finished (no completion registry
  entry, or a registered command without its fence) before its ledger claim, before the mutation
  barrier records anything and before the server is asked to confirm the claim. A managed request
  gets a signed `executed: false` refusal, so the server releases the lease as `not-dispatched`
  and records the command as failed with nothing run, instead of keeping an `unknown` lease that
  blocks every later Ardent action and the activation quiescence check. No transient unit is
  started, so none is left to hold a later enrollment drain at `supervisor-unverified`.
- Console accessibility (found by the new axe scan): icon-only buttons on the nodes, node detail and
  operations pages have names; the file, log and audit pickers have labels; muted text, the sidebar
  version and the remediation buttons meet WCAG AA contrast; a meter without a value is no longer
  announced as a meter; the security page no longer nests a second `main` landmark; the file path
  picker is a keyboard-reachable button; node software versions sit in a description list.
- Agent docs: the privileged unit's omitted `ProtectKernelModules`, `ProtectClock` and `MemoryMax`
  are explained precisely (they are no boundary for a root agent and would break kernel upgrades,
  GPU collection and running commands), and `PrivateTmp` is described as it works: commands the
  agent starts share its private `/tmp`, emptied on restart, while supervised commands, Embermend
  actions and Codex updates run in their own units with the host `/tmp`.

## [3.6.0] - 2026-11-28

The server adopts `@hivemagnus/hive-common` 0.11.1: optional `MAGNUS_TRUSTED_PROXIES` for rate
limiting behind a proxy, validated request IDs, a stricter and deprecated Hive IAM mode, and a
per-process rate-limit fallback when Redis is unavailable. Ardent stays 3.6.0. No migration.

### Upgrade notes

- **Hive IAM mode (`IAM_CORE_URL`) is deprecated** and is removed in 4.0.0; move to Oathweave mode
  (`OATHWEAVE_ISSUER`). Until then its tokens must also carry a `jti` claim and an `aud` that is
  exactly `IAM_TOKEN_AUDIENCE` (a single string, not a list that contains it). Oathweave's
  `/api/v1/auth/public-key` tokens already do; the server logs a deprecation warning at startup.
- **Request IDs are validated.** An inbound `x-request-id` is reused only when it is 1-128
  characters of `A-Z a-z 0-9 . _ : @ / + = -`; anything else gets a generated UUID. `x-hive-request-id`
  and `x-correlation-id` are accepted as aliases. Generated IDs are UUIDs instead of nanoid strings.
- **Rate limits** keep their budgets, keys, Redis store and `429` body. When Redis is unavailable,
  routes that are not fail-closed are now limited per process with the same budget instead of
  unlimited, and an IPv6 client is keyed by its canonical address.

### Added

- `MAGNUS_TRUSTED_PROXIES` (optional): proxies whose `X-Forwarded-For` the rate limiter believes
  (addresses, CIDR ranges, `loopback`, `private`, `linklocal`), read from the right past every
  trusted hop. Unset keeps the current behaviour: the socket peer is the client. An invalid entry is
  refused at startup.

### Changed

- Server: adopt `@hivemagnus/hive-common` 0.10.0 (fleet gateway and Oathweave package bumped too).
  The HiveMem service token uses `/oathweave` `createServiceTokenProvider()` (a failed token request
  now backs off for 5 seconds); request IDs and trace context use `/hono` `requestContext()`, and
  `tracing` reuses its span; secret comparisons use `/secrets`; redaction runs `/log` `redact()`
  plus Magnus's own key and text rules, so everything masked before is still masked; the rate limiter
  uses `/rate-limit` (`enforceRateLimit()` over a Redis store, `createRateLimiter()` as the fallback,
  `resolveClientAddress()`).
- Server: the Hive IAM verifier requires `jti` and an exact single audience.
- Server: adopt `@hivemagnus/hive-common` 0.11.1 (fleet gateway and Oathweave package bumped too).
  The rate limiter's Redis window is now `/rate-limit` `createRedisSlidingWindowStore()` (same keys,
  budgets, `Retry-After` and `429` body). Each window keeps at most the newest `max + 1` entries, so a
  flood of refused requests no longer grows the sorted set, and an error reply from Redis is now
  treated as Redis unavailable (503 on fail-closed routes, the per-process fallback elsewhere); it
  used to be read as allowed.
- Server: redaction uses `/log` `redact()` with Magnus's key names (`keyPattern`,
  `maskNonStrings: 'listed'`) and the 0.11.0 `redactText()`, which masks names that only end in a
  secret word. Such a pair now keeps its name: `NODE_TOKEN=[REDACTED]` instead of `NODE_[REDACTED]`,
  `token=[REDACTED]` instead of `[REDACTED]`, and a short bearer credential shows as
  `Bearer [REDACTED]`. Every value masked before is still masked; Magnus keeps three text rules
  HiveCommon does not cover (an `sk-` key or `Bearer` glued to a word character, a bearer of under
  four characters, and a secret value that continues after `&`).

### New environment variables

Optional (server):

- `MAGNUS_TRUSTED_PROXIES`: proxies whose `X-Forwarded-For` the rate limiter believes; unset keeps
  limiting by the socket peer.

### Migration impact

None.

## [3.5.1] - 2026-11-28

Magnus pins Ardent 3.6.0. No Magnus code, route or setting changes, and no migration.

### Upgrade notes

Order: Magnus node agents, then the Magnus server and console, then managed Ardent profiles when you
choose to move them.

- **Node agents stage Ardent 3.6.0 for managed profiles.** The 3.5.1 node agent is built and tested
  against Ardent 3.6.0 (management API types, journal policy), and 3.6.0 is the Ardent version to
  stage and install for profiles. Existing profiles keep running their installed Ardent until an
  operator upgrades them; a 3.5.1 agent still manages Ardent 3.5.1 profiles.
- **Ardent readiness answers `not_ready` with its 503.** From Ardent 3.6.0 a profile's
  `GET /health/ready` reports `status: not_ready` with a 503 (it said `degraded`); status codes are
  unchanged and `GET /api/v1/memory/status` still says `degraded`. The generated Ardent client types
  in `@hivemagnus/magnus-contracts` follow, and no Magnus code reads that word. External monitors
  that matched `degraded` in an Ardent readiness body should match the status code or `not_ready`.
- **Ardent 3.6.0 retention options are profile configuration only.** `retention.min_profile_mb`,
  `retention.peer_sessions` and `ardent prune --min-size-mb/--peer-sessions/--vacuum` add no
  management routes, so the node agent's Ardent allowlists are unchanged. The journal schema and
  journal policy version are unchanged.
- **No migration.** Upgrading from 3.5.0 needs nothing beyond the packages; from an earlier release,
  follow the 3.5.0 and 3.4.0 upgrade notes.

### Changed

- Pin `@hivemagnus/ardent` 3.6.0 (root and node agent, agent shrinkwrap) and regenerate the Ardent
  management API types: the readiness `status` enum is `ready | not_ready`.

### Migration impact

None.

## [3.5.0] - 2026-11-27

New Agent and agent definition installs deliver the Emberpath client key an Emberpath alias model
needs, and a new route sets or rotates that key on an existing agent. One fast migration.

### Upgrade notes

Order: Magnus node agents, then the Magnus server and console, then HiveXUI. Ardent stays at 3.5.1,
so managed Ardent profiles need no upgrade.

- **Upgrade node agents to 3.5.0 (studio level 6) before creating agents with an Emberpath alias.**
  The key reaches the new profile's `.env` through the node agent action `model-credential-set`, which
  only a 3.5.0 agent has. New Agent, definition installs and Set Emberpath key answer 409
  `AGENT_UPGRADE_REQUIRED` on a node agent below studio level 6; agents without an Emberpath alias are
  not affected.
- **Clients must send `emberpath_client_key` for an Emberpath alias.** `POST /api/v1/ardent/agents`
  and the agent definition install and validate routes answer 400 `EMBERPATH_KEY_REQUIRED` without it
  (a definition's preflight reports `SECRET_UNBOUND`), instead of creating an agent whose every model
  request Emberpath refuses with 401. HiveXUI's key field (New Agent, resume, Set Emberpath key and
  Create agent from definition) arrives in the HiveXUI release after 0.14.0; HiveXUI 0.14.0 and older
  cannot create an Emberpath-alias agent against a 3.5.0 server. The key is created by an operator in
  Emberpath; Magnus never issues one, never stores it and never returns it.
- **The key is sent only to an explicitly configured `MAGNUS_ARDENT_EMBERPATH_URL`** (409
  `EMBERPATH_NOT_EXPLICIT` for a discovered Emberpath). Set it on the server before using an alias.
- **Repair existing alias agents** created by an earlier Magnus (their model requests fail with 401)
  with `POST /api/v1/ardent/installations/:nodeId/profiles/:name/model-credential` (ADMIN) or HiveXUI's
  Set Emberpath key, after their node agent is on 3.5.0. The profile restarts.
- **`ardentAgentOperationSchema.kind` gains `model-credential`.** Clients that list or show Ardent
  operations should accept it.
- **One fast migration** (see Migration impact below). Hive suite upgrades that manage Magnus need
  `--allow-migrations`.

### Added

- **Set Emberpath key on an existing agent.** `POST
  /api/v1/ardent/installations/:nodeId/profiles/:name/model-credential` takes `{"emberpath_client_key":
  "…"}` and sets or rotates the Emberpath client key of a running agent whose model is an Emberpath
  alias at `MAGNUS_ARDENT_EMBERPATH_URL`, so agents created before New Agent delivered keys can be
  repaired without editing their `.env` by hand. ADMIN, or a linked service identity acting for an
  ADMIN. It checks the key as New Agent does (400 `EMBERPATH_KEY_REQUIRED`, 409
  `EMBERPATH_NOT_EXPLICIT`, 409 `AGENT_UPGRADE_REQUIRED` below studio level 6, 422
  `EMBERPATH_KEY_INVALID`, `EMBERPATH_KEY_FORBIDDEN` or `EMBERPATH_ALIAS_UNAVAILABLE`), refuses a
  profile whose model is not such an alias (409 `MODEL_NOT_EMBERPATH`) or that is stopped (409
  `PROFILE_NOT_RUNNING`), then runs an operation of the new kind `model-credential` that writes the key
  through `model-credential-set`, sets `providers.llamacpp.api_key_env` and restarts the profile. The
  start is audited as `ardent.agent.model-credential` without the key, which is never stored, logged
  or returned.

### Fixed

- **New Agent delivers the Emberpath client key an alias model needs.** An agent created with an
  `emberpath_alias` got Emberpath's URL and the alias but no client key, so every model request was
  refused with 401. `POST /api/v1/ardent/agents` (and the agent definition install and validate
  routes) now take `emberpath_client_key`, the key an operator creates in Emberpath (Emberpath lets
  only a recently signed-in person create one, never a service token, so Magnus does not issue keys).
  Without it New Agent answers 400 `EMBERPATH_KEY_REQUIRED` ("Emberpath key missing") and a
  definition's preflight reports `SECRET_UNBOUND`. Magnus checks the key with Emberpath's model list
  first (422 `EMBERPATH_KEY_INVALID`, `EMBERPATH_KEY_FORBIDDEN` or `EMBERPATH_ALIAS_UNAVAILABLE`),
  sends it only to an explicitly configured `MAGNUS_ARDENT_EMBERPATH_URL` (409
  `EMBERPATH_NOT_EXPLICIT` otherwise), holds it in memory only, and `config-save` writes it to the new
  profile's `.env` as `ARDENT_LLAMA_API_KEY` through the new node agent action
  `model-credential-set` (studio level 6). The key is never stored in the operation, audited, logged
  or returned. Resume takes `emberpath_client_key` in its body when the key has not reached the
  profile and the server no longer holds it (409 `EMBERPATH_KEY_REQUIRED`).
- **Set Emberpath key operations are accepted by the database.** The `ardent_agent_operations` kind
  check allowed only `deploy`, `hivemem` and `definition`, so every `model-credential` operation would
  have failed with 500 when it was created. A migration widens the check, the service's operation kinds
  now come from the contracts enum, and the PostgreSQL integration test covers every kind in it.
- Magnus reports the manager address for Wazuh 5 agents configured with an endpoint. Legacy Wazuh
  agent configurations still report their server addresses.

### Migration impact

- `20261127120000_ardent_agent_operation_model_credential_kind` (fast): widens the
  `ardent_agent_operations` kind check to `model-credential`. Existing rows already satisfy it and are
  unchanged. It is safe under a 3.4.1 server after a downgrade.

## [3.4.1] - 2026-11-26

The code of 3.4.0, published with container images. The 3.4.0 npm packages are on npm, but its
container images were pushed by digest and never tagged, so there are no `3.4.0` image tags; use
`3.4.1`. Upgrading from 3.4.0 needs nothing; from an earlier release, follow the 3.4.0 upgrade notes.

### Fixed

- **The release images job tags the scanned digest again.** Its published-digest check pulled the
  pushed index for `amd64` and then for `arm64` under the same digest reference, which the classic
  Docker image store refuses ("cannot overwrite digest"), so every image failed before its tags moved.
  The job now removes each architecture's local copy before pulling the next, and a workflow test
  pins that.

### Migration impact

None beyond 3.4.0's two migrations.

## [3.4.0] - 2026-11-26

### Upgrade notes

Order: Magnus node agents, then the Magnus server and console, then managed Ardent profiles.

- **Upgrade node agents before the control server.** A 3.4.0 server pushes files (file pushes, role
  applications, library skill deploys) only through the agent's restricted write and refuses an agent
  that does not advertise `restrictedFileWrite` 2 with 409 `AGENT_FILE_WRITE_UNSUPPORTED`, writing
  nothing (failing closed is intended). In the other direction a 3.4.0 agent refuses writes to system
  paths until the server sends `adminWrite`, and an older server ignores the new agent's Ardent task
  filters (lists come back unfiltered), so finish the server upgrade soon after the agents.
- **File writes are stricter.** Writing system paths (`/etc`, `/root`, `/var/lib`, `/var/spool`,
  `/boot`, `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, any `.ssh` directory) needs the ADMIN role, on
  the requested path and on the symlink-resolved destination (403 `SENSITIVE_PATH_ADMIN_ONLY`);
  OPERATOR accounts that pushed files there need an ADMIN to do it. `/dev` is refused like `/proc` and
  `/sys`, and paths must be absolute. Writes into a directory owned by an account other than root, the
  agent or the file's owner, or through a component every account can write without the sticky bit,
  are refused (409 `PATH_CHANGED`). An overwrite replaces the file (new inode), so hard links to it
  are not updated.
- **`IAM_CORE_URL` must be HTTPS** unless its host is loopback (or the development-only
  `ALLOW_INSECURE_HTTP` is set): the server refuses to start with plain HTTP to any other host, so
  switch it before upgrading. Hive IAM RS256 tokens must carry `exp` and `iat` and live at most
  24 hours.
- **AI tools that need approval pause on every path.** Non-streaming `POST /assistant/chat`, approval
  continuations, insights and scheduled AI operations save such a call as a pending approval instead of
  running it, and `POST /assistant/messages/:id/confirm` checks the tool policy again. A scheduled
  operation that ran `execCommand`, `writeFile`, `runSkill`, `createSkillDraft` or `generateRunbook`
  unattended now stops there and records it in `lastError`. A stored tool policy is merged with the
  defaults (fails closed), and disabled tools are refused however a call arrives.
- **Agent request body limit.** Agents answer 413 `PAYLOAD_TOO_LARGE` for bodies over
  `MAGNUS_AGENT_BODY_LIMIT_BYTES` (default 16 MiB); raise it on a node only if you push larger files
  or skill payloads to it.
- **Pinned Hermes installer.** `POST /hermes/install` runs only the hash-checked `install.sh` of one
  pinned Hermes Agent commit (v0.23.4) and, as root, runs it as the account that owns the target
  Hermes home. Set both `HERMES_INSTALL_COMMIT` and `HERMES_INSTALL_SCRIPT_SHA256` to install another
  commit on one node.
- **Hermes discovery uses only the configured owner.** Set `HERMES_USER` on a node whose Hermes lives
  in another account's home; the agent no longer searches `SUDO_USER`, `USER` or `/home`.
- **Agent command `args` are literal.** Each `args` entry of `POST /api/v1/commands/execute` is quoted
  as one argument; move shell syntax (pipes, redirects, `&&`) from `args` into `command`.
- **Re-run `sudo magnus-agent install-service`** on each node to apply the tighter systemd unit
  (`LockPersonality`, `RestrictRealtime`, `SystemCallArchitectures=native`, `TasksMax=4096`) and the
  agent's own Node.js binary for supervised commands.
- **Backup pruning deletes.** `MAGNUS_BACKUP_KEEP` (server and startup auto-migrate) and
  `keepBackups` (`magnus upgrade`) now delete older dumps; before, one dump per release or upgrade step
  stayed forever. Copy any old dump you want to keep out of the backup directory first.
- **Console.** `SESSION_SECRET` is declared required, and the expired `JWT_SECRET` session fallback
  (`ALLOW_LEGACY_SESSION_SECRET`) and the `DASHBOARD_LOGIN_USERNAME`/`DASHBOARD_LOGIN_PASSWORD` login
  are removed; delete them from the console environment. Set `DASHBOARD_TRUSTED_PROXIES` when the
  console runs behind a reverse proxy, so login throttling sees the client. Non-GET `/api/*` requests
  need a same-origin `Origin` or `Sec-Fetch-Site` (browsers send one; scripts that send neither are
  unaffected).
- **Compose.** `docker/compose.yml` runs the server and console read-only with `cap_drop: [ALL]` and a
  `/tmp` tmpfs, and pins PostgreSQL and Redis by digest. A deployment that adds its own writable paths
  to either container needs a volume or tmpfs for them; update the digests together with the tag when
  you move PostgreSQL or Redis.
- **Alert rule node filters match exactly.** IDs and names match exactly or as a `*` glob; a filter
  that relied on substring matching (`web` for `web1`) needs `web*`.
- **Other behaviour changes.** Local session tokens issued before the upgrade stay valid until they
  expire (`JWT_EXPIRY`); a password change ends the account's other sessions. An unexpected 5xx says
  only "An unexpected error occurred" (read the server log for details). Without Redis, agent upgrade
  runs answer 503 `AGENT_UPGRADE_LOCK_UNAVAILABLE`. `DELETE /remediation/rules/:id` answers 409
  `RULE_HAS_EXECUTIONS` for a rule that ran; disable it instead. TypeScript consumers of the
  `@hivemagnus/magnus-contracts` root entry point see the single, server-accurate shapes of five
  shared schemas.
- **New opt-in settings** (unset keeps the previous behaviour): `MAGNUS_HISTORY_RETENTION_DAYS`
  (history retention), `MAGNUS_AI_SCHEDULER_ENABLED` (server-side AI scheduler) and
  `MAGNUS_API_SECRET_BYPASS` (`loopback` or `off` limits the `x-api-secret` ADMIN bypass; use one of
  them when HiveXUI with Oathweave is the browser client). `MAGNUS_AGENT_FILE_ROOTS` optionally limits
  the agent file API to listed directories.
- **Ardent 3.4 and 3.5.** Magnus pins Ardent 3.5.1. Ardent 3.4.0 and later refuse a management token
  without the `Bearer` scheme, which this node agent always sends: upgrade the Magnus node agents
  before moving a managed profile to Ardent 3.4 or later. The new Ardent operations (task pages and
  filters, metrics, peer credential reload, management token rotation) need node agents at `studio`
  level 5. Ardent 3.4.0's 1 MiB management body limit does not affect Magnus (every body the node
  agent sends a profile stays at or under 300 KB). Ardent 3.4.0 applies `execution.max_parallel_tasks` above 4 (up to 16); set 4 to keep the
  previous concurrency. Profiles that New Agent or a definition install creates keep
  `a2a.provider` Magnus; existing profiles report Ardent after their Ardent upgrade unless you set
  `a2a.provider`. Ardent 3.5.0 resumes durable Codex threads on Codex CLI 0.172.0
  (`providers.codex.durable_threads: false` opts a profile out). With Ardent 3.5.1 a task's
  `task.done` arrives after its last journal event, and can lag by up to about 10 s for direct
  research tasks. Native snapshots classify journals with the pinned Ardent's own policy; a table,
  column or state it does not classify still blocks automatic activation.
- **Two migrations** (see Migration impact below). Hive suite upgrades that manage Magnus need
  `--allow-migrations`.

### Changed

- **Ardent 3.5.1.** The pins move to `@hivemagnus/ardent` 3.5.1 (through 3.5.0, which resumes durable
  Codex threads on Codex CLI 0.172.0; `providers.codex.durable_threads: false` opts a profile out).
  3.5.1 fixes a task stream race: `task.done` now arrives after the task's last journal event, and can
  lag by up to about 10 s for direct research tasks. The management API, journal policy (version 1)
  and Emberfold 0.4.0 are unchanged, so the generated Ardent client types, the journal module's policy
  and the context overlay are the same.
- Dependabot now opens one grouped weekly pull request (group `hivemagnus`) for `@hivemagnus/*` package updates, so suite package bumps arrive together. Repository configuration only; nothing to do when upgrading. The repository's own `@hivemagnus/magnus*` workspace packages are ignored; a grouped bump of a server or console dependency still needs `npm run locks:generate` for the shrinkwraps before it merges.
- **Ardent 3.4.0.** The node agent and New Agent stage `@hivemagnus/ardent` 3.4.0 (pins in the root and
  agent `package.json` and the agent `npm-shrinkwrap.json`), and the generated Ardent client types follow
  its management API (task pages and filters, metrics, credential reload, HiveCommon health bodies,
  `providers?probe=codex`). The native-snapshot journal module is Ardent 3.4.0's (policy version 1
  still): a bound outbound A2A call is finished, a `ready` or `reconciling` recovery row counts only
  while its task runs, and Mattermost history an earlier Ardent seeded is not work.
- **Context adoption overlays Emberfold 0.4.0**, the engine Ardent 3.4.0 depends on (it was 0.1.0); the
  context release reports `engine_version: 0.4.0`, and `ArdentContextReleaseSchema` accepts both.
- **Node agent `studio` level 5** and `capabilities.task_filters: 1` in the Ardent installation report.
- **Ardent 3.3.0.** The node agent and New Agent stage `@hivemagnus/ardent` 3.3.0 (pins in the root and
  agent `package.json` and the agent `npm-shrinkwrap.json`). The generated Ardent client types gain the
  optional `task_states` and `jobs.last_tick_error` fields of `GET /api/v1/status`; no route or action
  changes.
- **Native snapshots use Ardent's journal policy.** The stopped-profile snapshot check no longer keeps
  its own list of Ardent tables and states. It runs Ardent's read-only journal inspector
  (`@hivemagnus/ardent/journal`, policy version 1) on the private copy of each SQLite file, so a new
  Ardent table is classified by the Ardent release that creates it. The agent build copies that module
  from the pinned Ardent into `dist/native-snapshot/journal.js` and reads it with Node's built-in SQLite;
  Ardent stays a development dependency of the agent.

### Added

- **Ardent 3.4.0 operations through Magnus** (node agent `studio` 5, Ardent 3.4.0; see
  [docs/ARDENT.md](docs/ARDENT.md#ardent-340-operations-studio-5)):
  - `GET …/profiles/:name/tasks` passes `after` (the previous page's `next`), `limit` and the task
    filters `state`, `context` (now also `peer` and `scheduled`), `caller`, `since` and `until` on, each
    checked first; a filter on an older node agent answers 409 `AGENT_UPGRADE_REQUIRED` instead of an
    unfiltered list.
  - `GET …/profiles/:name/metrics` (ADMIN people) answers the profile's OpenMetrics text.
  - `peer-credential-reload` (ADMIN people) has a running profile re-read its A2A peer tokens without a
    restart, with an optional `overlap_seconds` for replaced inbound tokens.
  - `management-credential-rotate` (ADMIN people) rotates a running profile's management token without
    a restart: the node agent writes a new random token into the profile's `.env` and switches the
    gateway to it with the token in use, and writes the previous one back when Ardent refuses.
- **Server-side AI scheduler.** `MAGNUS_AI_SCHEDULER_ENABLED=true` runs due AI scheduled operations every
  minute from the server (off by default; `POST /ai-schedules/execute-due` still works). Every caller
  claims an occurrence with a compare-and-set on `nextRunAt` before it runs, so two concurrent calls no
  longer run the same operation twice, and a failed run waits for its next occurrence. Scheduled
  operations no longer run tools that need approval (`execCommand`, `writeFile`, `runSkill`, ...)
  unattended: a run that reaches one stops there and records it in `lastError`.
- **History retention for the tables that only grew.** `MAGNUS_HISTORY_RETENTION_DAYS` (unset by default:
  nothing changes) deletes, once a day, finished commands and their results, finished webhook
  deliveries, resolved alert violations, finished cron executions, completed managed cron occurrences,
  resolved anomaly events (which lets health retention prune the snapshots they held) and AI
  conversations older than that many days. Commands a rollout, an unsettled resource lease, a managed
  cron occurrence or an Embermend operation still names are kept, as is every unresolved row and every
  conversation with a tool call still awaiting approval.

### Security

- **Console proxy keeps the upstream content isolation headers.** `/api/proxy/*` now relays
  `Content-Security-Policy`, `Content-Disposition`, `X-Content-Type-Options`, `Cache-Control` and the
  range/digest headers from the Control API instead of rebuilding the response with only
  `Content-Type`, and marks every proxied response `nosniff`. Ardent artifact content keeps its
  `default-src 'none'; sandbox` policy and `attachment` disposition through the console.
- **Pinned Hermes installer.** The node agent's `POST /api/v1/hermes/install` no longer pipes the
  upstream `main` branch's `install.sh` into bash. It downloads the script from one pinned commit,
  checks its SHA-256 before running it, installs that same commit (`--commit`), and as root runs it as
  the account that controls the target Hermes home. The pin lives in
  `packages/agent/src/executors/hermes-install-pin.ts`; `node scripts/update-hermes-install-pin.mjs
  [tag]` moves it, and `HERMES_INSTALL_COMMIT` with `HERMES_INSTALL_SCRIPT_SHA256` overrides it on one
  node.
- **Agent request body limit.** The node agent reads a request body at most once, up to
  `MAGNUS_AGENT_BODY_LIMIT_BYTES` (default 16 MiB), before it verifies the request signature, and
  answers 413 `PAYLOAD_TOO_LARGE` for anything larger, whether declared by `Content-Length` or sent
  chunked. The same limit applies under the deprecated shared secret.
- **AI tool approval applies on every chat path.** The non-streaming tool loop (`POST /assistant/chat`,
  the fallback for providers other than Ollama, the continuation after an approval or rejection, and the
  insights and scheduled-operation services) now pauses on a tool that needs approval and saves it as a
  pending approval, as the streaming path already did. Tools disabled in the tool config are refused
  however a call arrives, including calls written as text, on both paths and again when an approval runs.
- **The AI tool approval policy fails closed.** A stored policy is merged with the defaults: a list it
  leaves out keeps its default, and `execCommand`, `writeFile`, `runSkill`, `createSkillDraft` and
  `generateRunbook` always require approval unless the policy denies them.
- **`GET /profiling/:nodeId` accepts only `type=heap`, `cpu` or `process`** (400 otherwise), refuses
  agent redirects, and writes a `node.profile` audit event.
- **Hive IAM key fetch.** `IAM_CORE_URL` must be HTTPS; HTTP is accepted only for a loopback host or with
  the development-only `ALLOW_INSECURE_HTTP`. The RS256 public key is fetched with a 5 s timeout and
  without following redirects. A token with several IAM roles gets the highest Magnus role they map to,
  not the first one listed.
- **Isolated rehearsals authenticate no agent request.** With `HIVE_REHEARSAL=true`, every server-to-agent
  request is refused before it is signed, reads included (profiling, storage evidence), not only those
  sent through the node SDK.
- **A password change ends the account's local sessions.** Locally issued tokens now carry a stamp of
  the password they were issued for; `PUT /users/:id/password` invalidates every session with an older
  stamp (immediately in the answering process, within 30 s elsewhere) and returns a fresh `token` to a
  caller who changed their own password. Changing your own password needs the current one for admins
  too, and an admin can no longer deactivate their own account. User and node-password audit events
  record the socket peer instead of a client-supplied `x-forwarded-for`.
- **`MAGNUS_API_SECRET_BYPASS=off|loopback|on`** (default `on`, the previous behaviour) limits where the
  `x-api-secret` ADMIN bypass is honoured. `loopback` accepts it only from a loopback socket peer, never
  judged by forwarding headers; `off` ignores the header, so callers need a bearer token.
- **Hive IAM tokens need an expiry.** RS256 tokens from Hive IAM must carry `exp` and `iat`, and live at
  most 24 hours (`exp - iat`).
- **Cindertrace response requests are accepted once.** The bridge records each verified nonce for two
  minutes, so a captured signed request can no longer be replayed inside the 60 s timestamp window.
- **Unexpected errors answer with a generic message.** A 5xx that is not an intended `HttpError` keeps its
  code but says only "An unexpected error occurred"; the full (redacted) text stays in the server log.
- **Log forwarding authenticates with the node key.** `POST /logs/ingest` accepts a batch signed with
  the node's key (or, outside enforce mode, the shared node secret), and the batch must name that node
  (403 `NODE_IDENTITY_MISMATCH` otherwise). The per-node HMAC `x-log-token` stays accepted from agents
  that do not sign their batches.
- **Anonymous refusals no longer write a log row each.** A 4xx answered to a request with no signed-in
  user and no node credential is counted (`httpUnauthenticatedRejectionsTotal` on `/metrics`) and
  summarized once a minute instead of being stored and streamed one row at a time.
- **Confirming a pending AI tool call checks the tool policy again.** `POST /assistant/messages/:id/confirm`
  refuses to run a tool that was disabled or denied after it went pending (for a natural-language
  command, `execCommand` too), as `POST /assistant/messages/:id/approve` already did.
- **AI tool results are redacted** (API keys, tokens, passwords, bearer values, private keys) before
  they reach the model provider, the conversation store or share links; shared conversations redact
  rows stored before this change on the way out.
- **AI `execCommand` and `runSkill` go through the durable command queue.** Each call is a
  `RemoteCommand` row dispatched by the command worker (signed request, receipt and result checks),
  authored and audited as the user who approved it rather than `ai-assistant`, and linked to the
  conversation (`correlationId`). The destructive-command check judges command words instead of
  substrings, so `grep halted` is no longer refused while `/sbin/reboot` and `systemctl poweroff` are.
- **Agent command arguments are passed literally.** `POST /api/v1/commands/execute` without the
  execution supervisor, and the supervisor's shell path for unregistered commands, joined `args` onto
  the command with spaces and no quoting, so an argument containing a space, quote or `;` changed
  meaning. `command` stays a shell string; each entry of `args` is now quoted as one argument, the same
  as the supervisor's `shell: false` path for registered commands. Arguments with NUL bytes get 400.
- **Hermes discovery uses only the configured owner.** The agent no longer looks for a Hermes home
  under `SUDO_USER`, `USER` or every directory in `/home`; it looks under `HERMES_USER` (or the older
  `HERMES_OWNER`), the agent's own home and the fixed `/opt` paths.
- **Atomic, symlink-safe agent file writes.** `POST /api/v1/files/write` truncated the target in
  place after a path check, following symlinks, so a crash could leave a half-written file and a swap
  between check and write was followed. It now writes a temporary file in the same directory
  (`O_EXCL|O_NOFOLLOW`), syncs it and renames it over the target, keeping the existing file's mode,
  owner and group. `GET /files/read` opens with `O_NOFOLLOW` and judges the opened file. A path that
  changes during the operation gets 409 `PATH_CHANGED`.
- **Optional file API allowlist.** `MAGNUS_AGENT_FILE_ROOTS` (comma-separated absolute directories)
  limits `/api/v1/files/*` to those directories, symlinks resolved; `magnus-agent check` reports it.
- **Agent-side file backups.** `POST /api/v1/files/write` accepts `backup: true`: only after the path
  and roots check passes, the existing file is copied to `<file>.magnus-backup.<UTC timestamp>` in the
  same directory (exclusive temporary file, fsync, rename; mode, owner and times kept), then the new
  content is written. A failed backup writes nothing, a refused path leaves no file behind, and the
  response carries `backupPath`. The agent advertises this as `features.restrictedFileWrite: 1` on
  `GET /api/v1/ping`.
- **Agent self-upgrades are confirmed only when the agent's own API answers.** A version on trial
  was confirmed by its first accepted heartbeat, which is outbound, so a version with a broken
  listener or TLS setup was kept and could then not be reached. It is now confirmed only after a
  signed probe of its own `GET /api/v1/health/check` over the real listener reports the new version
  (loopback, trusting only the certificate in `TLS_CERT_PATH`, or `MAGNUS_AGENT_SELF_URL` with full
  certificate checks). Otherwise the
  launcher reverts it when the confirm window ends.
- **Console refuses cross-site state changes.** Every non-GET `/api/*` request to the standalone console
  (proxy, terminal, control nodes, login) must carry an `Origin` equal to `DASHBOARD_PUBLIC_ORIGIN` or
  to its own host, or a same-origin `Sec-Fetch-Site`; otherwise 403 `cross_site_request_refused`.
  `SameSite=Lax` alone did not stop a sibling subdomain. Clients that send neither header (scripts)
  are unaffected.
- **Anonymous login attempts no longer lock the administrator out.** Past the per-username budget
  (10 per 15 minutes across all sources) a wrong password is throttled, but the correct one signs in;
  the per-source and per-source-and-username limits still apply before the password is checked.
  `DASHBOARD_TRUSTED_PROXIES` (addresses or CIDR ranges) lets the console attribute requests from a
  listed reverse proxy to the client in its `X-Forwarded-For`, so clients behind a proxy no longer
  share one source bucket.
- **Console `/api/health` answers only its status to anonymous callers.** The login source, SSH and
  credential metadata and the session-secret source are returned only to a local administrator session
  (not to viewers, operators or named Hive sessions),
  and misconfigured credentials give `unhealthy` (503) instead of an unhandled 500.
- **The fleet-gateway image installs a locked dependency graph.** Its runtime stage ran `npm install`
  against caret ranges, so the service that holds the SSH key got a new graph on every build. The
  gateway now carries `services/fleet-gateway/npm-shrinkwrap.json` and the image installs it with
  `npm ci`, as the server and console images do; `npm run check:packs` and `locks:refresh` cover it.
- **Released images are scanned as pushed.** The publish job built and scanned each architecture,
  then rebuilt for the push. The rebuild is now pushed by digest only, the job runs and Trivy-scans
  that exact digest on both architectures, and only then moves the `X.Y.Z`, `X.Y` and `X` tags to it
  (no rebuild); a failed scan leaves no tag. The unused `id-token: write`
  permission is gone from the images job.
- **Container hardening.** App code in the server, console, gateway and agent images is root-owned,
  so the runtime user cannot rewrite it. `docker/compose.yml` runs the server and console with
  `cap_drop: [ALL]`, a read-only root filesystem and a `/tmp` tmpfs, pins the PostgreSQL and Redis
  images by digest, and keeps the Redis password off the `redis-server` command line (a private config
  file inside the container, the password quoted so spaces and quotes work; the health check uses
  `REDISCLI_AUTH`).
- **`POST /files/update` enforces its sensitive-path policy.** The path must be absolute and is
  normalized before any check (`//etc/...` and `/./` no longer slip past a prefix; `..` and NUL are
  refused), and the agent receives the normalized path. Writing system paths (`/etc`, `/root`,
  `/var/lib`, `/var/spool`, `/boot`, `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, any `.ssh` directory)
  now needs the ADMIN role; `/dev` joins `/proc` and `/sys` as refused. `GET /files/read` also requires
  an absolute path.
- **File pushes go only through the agent's restricted write.** The server no longer copies the target
  with a shell `cp` before writing, nor falls back to a shell write on agents without `/files/write`:
  it asks the agent to make the backup (`backup: true`) after its own path check, so a refused write
  leaves nothing behind. Agents that do not advertise `restrictedFileWrite` in their ping are refused
  with `AGENT_FILE_WRITE_UNSUPPORTED` and nothing is written. Role applications and library skill
  deploys use the same write and lose their shell fallback too. The server also tells the agent whether
  an ADMIN asked (`adminWrite`), so the agent can apply the system-path rule to the destination it
  resolves, symlinks included; it needs an agent that advertises `restrictedFileWrite` 2.
- **The agent upgrade run lock no longer falls back to process memory.** Without Redis, `POST
  /agent-upgrades/runs` and `magnus-server agents upgrade` answer 503 `AGENT_UPGRADE_LOCK_UNAVAILABLE`
  instead of taking a lock only this process can see. A run whose lock renewals fail for two thirds of
  the lease, or whose lock another holder took, stops after its current nodes.
- **Console-wide Content Security Policy.** Every console page now sends a policy that limits scripts,
  connections, forms and frames to the console's own origin, forbids plugins and `<base>` changes, and
  refuses framing by other sites. The embedded Hermes and router dashboards may be framed only by the
  console itself.
- **Agent file writes are bound to the directory they were checked against.** `/files/write`
  checked the parent directory by path and then reused the path, so a local account able to swap a
  component between check and write could redirect a privileged write outside the allowed roots.
  The agent now refuses paths through a component owned by another account or writable by every
  account (without the sticky bit), holds the checked directory open, and proves its identity and
  roots immediately before and after the backup and replacement renames; a mismatch gets 409
  `PATH_CHANGED` and removes only the agent's own file.
- **The agent applies the ADMIN-only system-path rule to the real destination.** The Control API judged
  the requested path, but the agent resolved symlinks afterwards, so a link under an ordinary path
  could carry an OPERATOR's write into `/etc` or a `.ssh` directory. `/files/write` now takes
  `adminWrite` (sent by the Control API, true only for an ADMIN; missing counts as false) and applies
  the shared `filePathPolicy` (new in `@hivemagnus/magnus-contracts`) to the request and to the
  verified, symlink-resolved destination, refusing a sensitive one without it (403
  `SENSITIVE_PATH_ADMIN_ONLY`, nothing created). Ping reports `features.restrictedFileWrite: 2`.

### Fixed

- **Installer backup pruning deletes old dumps.** `magnus upgrade` kept the newest dump of every label,
  and every upgrade step has its own label, so no dump was ever deleted. It now keeps the newest
  `keepBackups` dumps plus the one the current upgrade's rollback restores.
- **Server backup pruning deletes old dumps.** `magnus-server backup` and startup auto-migrate kept the
  newest dump of every label, and labels name a version, so one dump per release stayed forever. They now
  keep the newest `MAGNUS_BACKUP_KEEP` dumps, the new one included.
- **Hermes core rollout accepts upstream's semver release tags** (`v0.23.4`) as well as the older date
  tags; the stable-release check refused every current release as invalid.
- The AI `getHealthHistory` tool caps its window at 168 hours, the dashboard-stats tool reads only the
  last hour of snapshots, and AI share links (`ttlHours`) and tool-round budgets (`maxToolRounds`) are
  clamped. Conversation summary failures are logged instead of being swallowed.
- **Agent commands no longer wait on stdin.** The in-process command path closes stdin, as the
  supervisor already did, so a command that reads it ends at once instead of at its timeout.
- **Supervised commands use the agent's Node.js.** The execution supervisor, the supervised Codex
  update and the Embermend worker ran `/usr/bin/node`; they now run the binary the agent itself runs on
  (the one `install-service` writes into the unit), so nvm and `/usr/local/bin` installs work.
- **Malformed JSON gets 400 from the agent.** About 20 agent routes (commands, Hermes, Embermend,
  workspaces, security response) answered a body that is not JSON with 500.
- **Tighter generated agent unit.** `install-service` and the example unit add `LockPersonality`,
  `RestrictRealtime`, `SystemCallArchitectures=native` and `TasksMax=4096` in privileged mode too. The
  agent README explains which options privileged mode leaves out and that `PrivateTmp` gives commands a
  private `/tmp`. Re-run `sudo magnus-agent install-service` to apply it to an existing node.
- **Agent log batches are node-signed.** The agent signs each `/logs/ingest` batch with its node key
  over the exact body, as it signs heartbeats, and sends `LOG_INGEST_TOKEN` only when it is set. The
  agent catalogue no longer generates a random `LOG_INGEST_TOKEN` (the server expects a per-node HMAC,
  so a random value never authenticated), and `ENABLE_LOG_FORWARDING=true` no longer requires it.
  The catalogue and `.env.example` document how the per-node value is derived for a Control API that
  checks only the token.
- **Agent file writes accept `mode`, `owner` and `group`.** A new file was always root-owned `0600`
  under the unit's `UMask=0077`; `mode` (octal string) now sets its permissions, and `owner`/`group`
  set its ownership in privileged mode (403 `AGENT_NOT_PRIVILEGED` otherwise).
- The console's environment schema and generated README table now list `DASHBOARD_ADMIN_PASSWORD`
  (and `_B64`, which take precedence over the Argon2id hash), `SSH_HOST_KEY_PINNING` (`warn` connects
  despite a changed host key), `SSH_HOST_KEYS_FILE`, `TERMINAL_AUDIT_DIR`,
  `DASHBOARD_DEPENDENCY_TIMEOUT_MS`, `LOCAL_SESSION_GENERATION` and the test-only
  `MAGNUS_CONTROL_NODES_CONFIG_DIR`.
- **One definition of the shared contract shapes.** `@hivemagnus/magnus-contracts` exported
  `apiErrorSchema`, `dependencyHealthSchema`, `fleetReadinessNodeSchema`, `incidentSummarySchema` and
  `timelineItemSchema` twice, with different shapes. The root entry point now re-exports the browser
  contract's definitions, which match what the server sends: `error.code` is optional and
  `error.details` is kept, `timelineItem.type` is an enum and `node` may be null, and the readiness
  node and incident summary carry their full fields.
- The agent's native systemd, root and Docker tests now run in CI (a dedicated job), and the obsolete
  Emberfold bootstrap workflow is gone: Emberfold publishes from its own repository with provenance,
  so Magnus no longer runs another repository's verify and publish with the long-lived bootstrap token.
- **Refused log batches are reported, and no longer refresh the node's server keys.** A log batch the
  Control API refuses (401/403, typically a missing or wrong `LOG_INGEST_TOKEN` on a server that does
  not yet verify node-signed batches) is dropped with an error at most every 10 minutes that counts
  the lost entries; it no longer counts as a node-key refusal, which re-fetched the pinned server
  keys every five minutes.
- The agent build's review of the bundled Ardent journal module now also sees double-quoted and bare
  side-effect imports, and a test exercises the built module against A2A task and team-claim rows.
- **Closing a managed terminal waits for its process group to empty.** Right after `systemctl stop`
  the unit's cgroup could still report populated, and closing a just-opened terminal then failed with
  `group-populated` and blocked the next terminal. The agent now waits up to 5 s for the group to
  empty, then SIGKILLs the whole group and waits 3 s more; the completion receipt is still issued
  only once the group is empty.
- **Skill scripts no longer abort when not run as root.** Under `set -euo pipefail`, an assignment
  such as `COUNT=$(find … | wc -l)` stopped the whole script when `find`, `du`, `findmnt` or `grep`
  hit a directory it could not read or found nothing (disk-cleaner, security-auditor, cron-manager,
  package-manager, update-manager, mount-inspector and others), and so did a report pipeline whose
  `grep` matched nothing or whose `head` closed it early. Report-only probes now tolerate that;
  backup checksums and the news-reporter prompt filter still fail closed.
- **Skill entry points exit 2 on an unknown flag** (usage on stderr) instead of printing usage and
  exiting 0. The disk-cleaner manifest now says it reports and deletes nothing.
- **The embedded router admin proxy is bounded.** `/api/hive-router/dashboard` read request and
  response bodies without a limit and kept only the first `Set-Cookie`. It now applies
  `DASHBOARD_PROXY_BODY_LIMIT_BYTES` to requests (413), stops at 16 MiB of router response (502) and
  relays every cookie. It is deprecated: current Emberpath (formerly Hive Router) has no admin UI.
- The console login page drops its unused MFA step and announces errors as an alert; the command
  palette and the keyboard shortcut reference are modal dialogs for assistive technology. The
  unreachable `/governor/share/<token>` page is gone (nothing links to it). Documentation now calls
  Hive Router Emberpath and points named login at OIDC providers such as Oathweave.
- **Expired console credential fallbacks are gone.** The `JWT_SECRET` session fallback
  (`ALLOW_LEGACY_SESSION_SECRET`) and the `DASHBOARD_LOGIN_USERNAME`/`DASHBOARD_LOGIN_PASSWORD` login
  stopped working on 2026-10-01; their code, settings and documentation are removed, and
  `SESSION_SECRET` is now declared required. `JWT_SECRET` is still read to decrypt control-node
  credentials stored before the dedicated key (re-encrypt them with
  `apps/dashboard/scripts/migrate-control-node-credentials.mjs` before that fallback can go).
- `docs/PUBLISHING.md` now describes how images are built, scanned and tagged (prereleases get their
  `X.Y.Z-<pre>` tag).
- `x-api-secret` and shared node-secret checks cache the decrypted credential rotation state until the
  state file changes, instead of reading, parsing and decrypting it on every attempt.
- **`POST /logs/query` pages correctly.** The cursor is now an opaque `(timestamp, id)` keyset that
  matches the result order, so pages no longer skip or repeat rows; a bare row id from an older client
  still works. `since` and `until` must be ISO 8601 date-times (400 otherwise, not a 500), as must
  ingested `timestamp`s, and an ingest batch holds at most 1000 entries.
- Webhook create/update/dispatch, alert rule create/update, `POST /topology/scan` (probe timeout
  at most 15000 ms), `POST /drift/scan` and `POST /assistant/insights/pins` validate their bodies: bad
  values answer 400 instead of 500, and a pinned insight can no longer replace its generated `id`.
- **The unreachable Orchestra router is gone.** Its 55 routes were shadowed by the Hermes catch-all
  and always answered 410; the code, its schemas, its OpenAPI entries and its inventory rows are
  removed. `/orchestra/*` stays a deprecated alias of the Hermes reads (installations, profiles, jobs)
  and now shares their rate-limit budget (20 a minute) instead of having its own 30.
- A route test calls every `user:*` row of the console route inventory with VIEWER, OPERATOR and ADMIN
  sessions and checks each answer against the row's `auth` column.
- **The OpenAPI document covers more of the API and stays honest.** It now describes webhooks, the audit
  exports and chain verification, node account provisioning and password changes, and ten more
  `/ops` reads, and eight integration routes lost a doubled `/api/v1` prefix. A route test fails when
  a mounted route has no entry or an entry names a route that is not mounted;
  `services/control-api/src/openapi/undocumented-routes.json` lists the 123 routes still without one
  and may only shrink.
- The server, fleet gateway and Oathweave verifier use `@hivemagnus/hive-common` 0.7.0. The fleet gateway
  shrinkwrap is regenerated for it. For Magnus this
  means: concurrent `GET /health/ready` requests share one run of the readiness checks, the suite
  registry client refuses a response over 1 MiB, and the Oathweave userinfo check reads at most 64 KiB.
- **One active alert violation per rule and node.** After the cooldown a rule reminds on its existing
  active violation (updating its value) instead of inserting another active row, and the cooldown is
  counted from the last reminder. Alert rule node filters match node IDs and names exactly, or as a
  glob with `*`; `web1` no longer matches `web10`.
- **Deleting a remediation rule keeps its history.** `DELETE /remediation/rules/:id` answers 409
  `RULE_HAS_EXECUTIONS` for a rule that has executions (approval plans, results and in-flight runs);
  disable it instead. A rule that never ran is still deleted.
- **Paused rollouts no longer starve the reconciler.** Each tick visits the 100 oldest created or
  running rollouts and a rotating window of 25 paused ones.
- The command and rollout reconcilers and the agent upgrade audit writer log the failure they hit
  instead of a fixed "reconciliation pending" line.
- `remote_commands` has an index on `(status, createdAt)` for the 5-second command reconciler, and
  `remediation_executions` restrict the deletion of their rule in the database as well.

### New environment variables

All optional:

- Server: `MAGNUS_HISTORY_RETENTION_DAYS`, `MAGNUS_AI_SCHEDULER_ENABLED`, `MAGNUS_API_SECRET_BYPASS`.
- Node agent: `MAGNUS_AGENT_BODY_LIMIT_BYTES`, `HERMES_INSTALL_COMMIT`, `HERMES_INSTALL_SCRIPT_SHA256`,
  `MAGNUS_AGENT_FILE_ROOTS`.
- Console: `DASHBOARD_TRUSTED_PROXIES`.

Removed (console): `ALLOW_LEGACY_SESSION_SECRET`, `DASHBOARD_LOGIN_USERNAME`,
`DASHBOARD_LOGIN_PASSWORD`; `SESSION_SECRET` is now declared required.

### Migration impact

Two fast migrations. `magnus upgrade` and startup auto-migrate back up PostgreSQL and apply them;
a Hive suite upgrade that manages Magnus needs `--allow-migrations`.

- `20261126120000_remote_command_status_index` builds one index on `remote_commands(status,
  createdAt)` (seconds for a few million rows; command inserts wait while it builds).
- `20261126120100_remediation_execution_restrict` replaces one foreign key so that a remediation
  rule with executions cannot be deleted; no rows change.

Downgrade: both are compatible with 3.3.x code, which ignores the index. A 3.3.x server that tries
to delete a remediation rule with executions gets a database error instead of erasing that history.

## [3.3.6] - 2026-11-25

### Security

- The node agent ships `fast-xml-parser` 5.12.1 and `fast-xml-builder` 1.3.2 in its
  standalone dependency lock. These versions include upstream fixes for
  [GHSA-7cfw-w2rf-f3jc](https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-7cfw-w2rf-f3jc)
  and [GHSA-g62r-xqpr-7fwx](https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-g62r-xqpr-7fwx).

**New environment variables:** None.

**Migration impact:** None.

## [3.3.5] - 2026-11-24

### Changed

- **Ardent 3.2.1.** The node agent and New Agent stage `@hivemagnus/ardent` 3.2.1 (pins in the root and
  agent `package.json` and the agent `npm-shrinkwrap.json`). The runtime, its management API and its
  dependencies are unchanged from 3.2.0; the release fixes `@hivemagnus/ardent-client`, whose `viaMagnus`
  now takes `apiBase` to reach Magnus through a Hive console (`https://<console>/api/magnus`, which the
  suite ingress maps to `/api/v1`). No route, action or settings change.

## [3.3.4] - 2026-11-24

### Fixed

- **Portable agent-definition installs work.** Magnus 3.3.0 records a definition install as an Ardent
  operation of kind `definition`, but the operations table's check constraint allowed only `deploy` and
  `hivemem`, so every `POST /api/v1/ardent/agent-definitions/install` failed with 500 after its preflight
  passed, before anything was created on the node. The migration
  `20261124190000_ardent_agent_operation_definition_kind` widens the constraint; existing rows already
  satisfy it. No settings change.

## [3.3.3] - 2026-11-24

### Fixed

- **Native snapshots of Ardent 3.2.0 profiles resume.** The agent's offline journal check accepts only
  tables it knows, and Ardent 3.2.0 added ten. Every 3.2.0 profile therefore counted as unsupported
  work: a Hive native backup or upgrade captured the profile and then refused to start it again
  ("pending, uncertain or unsupported work"), holding the suite. The check now knows them:
  `tool_invocations` (`dispatched` is in flight, `failed_unknown` uncertain), `task_recovery` (`ready`
  and `reconciling` active, `awaiting_decision` and `unsupported` uncertain) and `artifact_transfers`
  (queued, transferring and verifying active) by state; execution checkpoints, ancestry, renditions,
  hook failures and catch-up gaps as passive; catch-up runs and recovery publications as ledgers. A
  channel post that catch-up recorded as `skipped_stale` is not pending. Unknown tables and states
  still hold. No migrations and no settings change.

## [3.3.2] - 2026-11-24

### Fixed

- **An Ardent task stream opened through a Hive console no longer fails with 400.** The console's
  ingress forwards `Last-Event-ID` on every Magnus request, empty when the client sent none, and the
  task stream relay refused the empty value as an invalid cursor. An empty or blank `Last-Event-ID`
  (or `after`) now means no cursor, so the stream starts from the beginning; a malformed one is still
  refused. No migrations and no settings change.

## [3.3.1] - 2026-11-24

### Fixed

- **The agent dependency report checks Emberpath at its model API.** Magnus probed Emberpath at the
  root `health/live` of its endpoint. Behind a console that serves Emberpath only under `/v1` (a Hive
  console), that root belongs to another service, so Emberpath was reported usable without being reached.
  It now requires `GET <endpoint>/models` to answer (200, or a JSON 401 or 403 without a key) and takes
  the version and capabilities from root health only when that health does not name another service. A
  model API that does not answer reports `missing` with its reason. No migrations and no settings change.

## [3.3.0] - 2026-11-24

### Added

- Portable agent definitions (`hive-agent-definition/1`). `@hivemagnus/magnus-contracts` exports the
  schema (also as `@hivemagnus/magnus-contracts/agent-definition`) with canonical-JSON SHA-256 digests
  of the definition and its persona, `verifyAgentDefinition()`, `sealAgentDefinition()` and the
  credential-pattern guard `credentialLikePaths()`. `GET /api/v1/ardent/installations/:nodeId/profiles/:name/definition`
  exports a profile: persona, runtime, the reviewed extensions its plugins load, its enabled HiveSkills
  releases, the portable configuration and the bindings and secrets (names only) a target needs.
  `POST /api/v1/ardent/agent-definitions/validate` answers a preflight (`MISSING_BINDING`,
  `SKILL_VERSION_UNAVAILABLE`, `EXTENSION_NOT_REVIEWED`, `RUNTIME_INCOMPATIBLE`, `CAPABILITY_MISSING`,
  `SECRET_UNBOUND`), and `POST /api/v1/ardent/agent-definitions/install` runs New Agent for the
  definition (operation kind `definition`, with `extensions-install` and pinned `skill-install` steps)
  only once the preflight passes, finishing when the running agent's persona digest and skill receipts
  match. A credential-like value anywhere is refused with 422 `DEFINITION_CONTAINS_CREDENTIAL`.
  ADMIN, or a service identity acting for an ADMIN.
- `skill-install` takes `pinned: true` to install an exact HiveSkills release that is not promoted,
  through the HiveSkills pinned-release routes as Magnus's enrolled target
  (`MAGNUS_ARDENT_HIVESKILLS_TARGET`, `MAGNUS_ARDENT_HIVESKILLS_TARGET_TOKEN_FILE`). The archive must
  match the digest HiveSkills states and its `X-Content-SHA256` header. Without a target, or when the
  HiveSkills in use came from the Hive Registry rather than `MAGNUS_ARDENT_HIVESKILLS_URL`, such a
  release answers 409 `SKILL_VERSION_UNAVAILABLE`: the target token is sent only to the explicit setting.
- Dependency discovery for Ardent agents. `GET /api/v1/ardent/dependencies` (ADMIN or a linked service
  identity) reports HiveMem, HiveSkills and Emberpath as `usable`, `missing`, `unsupported` or
  `awaiting_configuration`, with their source (`override`, `registry` or `none`), endpoint, service
  capabilities and reason. An explicit `MAGNUS_ARDENT_*` URL wins; otherwise, with
  `MAGNUS_HIVE_REGISTRY_URL` and `MAGNUS_HIVE_REGISTRY_TOKEN_FILE`, the Hive Registry's record of the
  installed product. The report refreshes every five minutes and on `?refresh=true`. When the setting
  is unset, New Agent and the definition installer use a resolved Emberpath, and `skill-install` a
  resolved HiveSkills for promoted releases. Magnus sends its own credentials only to explicitly
  configured endpoints: a HiveMem found only in the Registry is reported `awaiting_configuration`
  and never used for enrollment, and a definition's `provided` model key needs an explicit Emberpath.
  Discovery never enrolls, installs or enables anything.
- The node agent reports the reviewed extensions retained beside the Ardent runtime (`extensions` in
  its Ardent inventory) and serves a profile's HiveSkills receipts (`GET /ardent/profiles/:name/skill-receipts`).
- Ardent 3.2.0 runtime contracts through Magnus (node agent `studio` level 4). New profile reads
  `tasks/:id/recovery`, `tasks/:id/lineage`, `artifacts/:sha256/renditions`, `artifacts/:sha256/manifest/v2`,
  `artifacts/imports` and `artifacts/imports/:id`; new actions `task-recovery` (resolve a task held for a
  decision) and `artifact-import` (pull an artifact from an A2A peer), with the same access as
  `task-pause`. `GET …/profiles/:name/artifacts/:sha256/content` relays artifact transfer v2 unbuffered with
  the artifact's media type and name, `Range`/`If-Range`, 206, 416, `ETag`, `Repr-Digest` and
  `X-Content-SHA256`; the whole artifact stays under `MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES`. The `.bin`
  route is unchanged.
- Each profile in the Ardent inventory reports its Ardent `version` and `capabilities`
  (`recovery`, `lineage`, `artifact_transfer`), from its own status or else the installed package, and
  the installation's `capabilities` are `{studio: 4, recovery: 1, lineage: 1, artifact_transfer: 2}`.
  A profile older than Ardent 3.2.0 answers the new reads and actions with 409 `unsupported_capability`
  and `error.details` `{capability, required_version, installed_version}`; its other operations are
  unchanged. `@hivemagnus/magnus-contracts` exports `ardentProfileCapabilities()`,
  `ARDENT_RUNTIME_GATES` and the new request schemas.
- `task-submit`, `mission-submit` and `preview-submit` take an optional top-level `execution` (an
  execution context v1, or the `x-hive-execution` header). Magnus passes it to a profile with
  `capabilities.lineage` 1, in the body and as `x-hive-execution`, and drops it when it is invalid or the
  profile is older; it never refuses a request for it. `x-request-id` and `traceparent` reach the profile.
- New Agent and definition installs write `ARDENT_INSTANCE_REF=<node id>.<profile>` into the new profile's
  `.env` before it first starts (node agent action `instance-ref-set`), and `package-install` writes it into
  every profile after an install.

### Changed

- `@hivemagnus/ardent` 3.2.0 (root and agent pins, agent shrinkwrap) and the regenerated Ardent client
  types. Release any extension package that pins an exact Ardent peer for 3.2.0 before this Magnus release: a managed
  upgrade reinstalls retained extensions with strict peers and holds the runtime when a peer differs.
- `@hivemagnus/hive-common` 0.6.0.

### Security

- Agent definition export: the `omitted` list no longer echoes configuration text. A skill or plugin name is shown only when it is a plain identifier; anything else (a path, a URL, free text) becomes `plugin #n (sha256:<12 hex>)`, and the whole response, not only the definition, is checked for credential-like text before it is returned.

### New environment variables

All optional (server):

- `MAGNUS_HIVE_REGISTRY_URL` and `MAGNUS_HIVE_REGISTRY_TOKEN_FILE`: Hive Registry discovery of Ardent
  dependencies; unset turns discovery off.
- `MAGNUS_HIVE_REGISTRY_ALLOW_HTTP`: allow a plain-http Registry on its private network.
- `MAGNUS_ARDENT_HIVESKILLS_TARGET` and `MAGNUS_ARDENT_HIVESKILLS_TARGET_TOKEN_FILE`: the HiveSkills
  target used for pinned, non-promoted skill releases (sent only to `MAGNUS_ARDENT_HIVESKILLS_URL`).

## [3.2.1] - 2026-11-21

### Fixed

- The `npm-shrinkwrap.json` in `@hivemagnus/magnus-server` and `@hivemagnus/magnus-ui` now
  holds only the production graph. npm installs a dependency's whole shrinkwrap, so in 3.2.0 a
  native install recorded the packages' development tooling in its lock as `extraneous`
  (98 server and 383 console entries, never loaded), and `npm audit` reported moderate
  `minimatch` findings in the console's eslint. The installed packages and versions are
  unchanged. `npm run locks:generate` keeps only what the dependencies, optional dependencies and
  required peers reach, and `npm run check:packs` refuses a lock with development entries.

## [3.2.0] - 2026-11-20

### Added

- `GET /api/v1/system/installation` (ADMIN only, `Cache-Control: no-store`) reports the server
  version, the Node.js version and whether it runs from an npm install or an image or source
  build, and lists every runtime dependency whose installed version differs from the
  `npm-shrinkwrap.json` the server package ships, with the path in the lock, the expected and
  the installed version. It finds the copy Node actually loads, so a native install that resolved
  `effect` 3.20.0 under `@prisma/config` while the signed build has 3.22.1 (the 3.1.4 and 3.1.5
  case) is listed. The browser contract publishes it as `systemInstallationResponseSchema`.

### Changed

- `@hivemagnus/magnus-server` and `@hivemagnus/magnus-ui` now ship a standalone
  `npm-shrinkwrap.json`, generated from the workspace lock CI tests (`npm run locks:generate`)
  with the packages' own overrides applied. A native `npm install` (and `magnus upgrade`) now
  gets exactly that graph, nested under `node_modules/@hivemagnus/magnus-server` and
  `node_modules/@hivemagnus/magnus-ui`, instead of resolving every range again; an install no
  longer needs its own `effect` override. The server and console images install the packed
  tarballs from the same lock (`scripts/shrinkwrap-install-lock.mjs`), so an image and a native
  install of one release run the same dependency graph. `npm run check:packs` refuses a stale
  lock, a lock that does not honour an exact override, and a packed install that differs from
  its lock.

## [3.1.6] - 2026-11-20

### Security

- The server no longer registers an HTTP `upgrade` listener. The retired Control API terminal
  kept one only to answer `/api/v1/terminal` upgrades with `410 Gone`. It returned early for every
  other path, and Node does not time out a socket handed to an `upgrade` listener, so each upgrade
  request to any other path stayed open until the client went away. A request with a malformed
  `Host` header also threw inside the listener and stopped the server. Without the listener, Node
  handles upgrade requests as ordinary HTTP: an upgrade to any path, `/api/v1/terminal` included,
  gets the same response as a plain request to it (`401` without credentials), and the usual
  request and keep-alive timeouts apply. The server no longer depends on `ws`.
- The standalone console now answers every HTTP upgrade request. Next.js deliberately leaves an
  upgrade that matches no route open, and Node applies no timeout to it, so an upgrade to any path
  outside the Hermes bridge stayed open until the client went away; such upgrades now get `404`.
  The console also routed upgrades through a URL built from the `Host` header, so a malformed
  `Host` threw inside the listener and left that socket open too. Upgrade routing now parses only
  the request target, and an unparsable target gets `400`.
- `@hono/node-server` is now 2.1.11 (`^2.1.11` in the server, fleet gateway and agent). Both
  advisories fixed since 2.1.8 (GHSA-8wcc-wqxr-28qp and GHSA-qhm2-7mpr-ghjp) need Hono's WebSocket
  option, which no Magnus listener enables.

## [3.1.5] - 2026-11-20

### Security

- The server image now carries `effect` 3.22.1, which fixes a high-severity ReDoS in
  `Schema.TemplateLiteral` (CVE-2026-121707) found in 3.20.0. `effect` comes only through
  Prisma's config loader (`prisma` 7.10.1 → `@prisma/config` 7.10.1 pins `effect` 3.20.0 exactly,
  and no Prisma 7 release moves it), which the Prisma CLI uses to read the server's own
  `prisma.config.ts`; Magnus passes it no untrusted input. The repository and the
  `magnus-server` image force 3.22.1 with an npm override. Overrides do not reach installs of the
  published package, so a native install (`npm install @hivemagnus/magnus-server` or
  `magnus upgrade`) still resolves 3.20.0 unless its own `package.json` adds
  `"overrides": { "@prisma/config": { "effect": "3.22.1" } }`. The agent, console and fleet
  gateway do not depend on `effect`.

## [3.1.4] - 2026-11-19

### Security

- `ws` is now 8.23.0 (`^8.23.0` in the server and the console), which fixes a high-severity
  memory-exhaustion issue (GHSA-37g9-w4hg-h9qr) in 8.22.2 and earlier. The console's Hermes Agent
  WebSocket bridge (`server-tls.mjs`) uses `ws`; it is off unless `MAGNUS_HERMES_ENABLED=true` and
  only accepts an authenticated session to an approved target, but consoles with it on should
  upgrade. The node agent's standalone lock moves to 8.23.0 too; there `ws` is a development-only
  dependency (through `@hivemagnus/ardent`) and is not installed with the published agent.
- Development tooling: Vite 8.3.8 and Rolldown 1.2.19 (GHSA-p4f5-76q4-ffq7 needs a reachable Vite
  dev server; Magnus only uses Vite through Vitest). Neither ships in a published package.

### Changed

- `@hivemagnus/hive-common` is now `^0.5.1` in the server, the fleet gateway and the Oathweave
  package. 0.5.1 makes the health-path trailing-slash trim and the error-code cleaning in
  `parseHiveError()` linear (both regexes were quadratic on crafted input). Magnus serves its
  health probes on fixed routes and does not parse peer errors with it, so neither was reachable
  here; 0.5.0's other fixes (bounded log redaction, URL credential masking) apply as well.

## [3.1.3] - 2026-11-17

### Changed

- Pin `@hivemagnus/ardent` 3.1.4 (`@hono/node-server` 2.1.6 or later) for the server, the node
  agent and its standalone lock. The Ardent management API is unchanged, so the generated client
  and the node agent's route allowlists are unchanged.

### Removed

- The server no longer validates `SECURITY_FUSION_RECEIPT_SIGNING_KEY`, an optional setting of the
  retired Security Fusion local mode that nothing read. It is also no longer part of the
  distinct-secret checks. A leftover value in a server's `.env` is ignored, like the other retired
  local-mode settings (`SECURITY_FUSION_EVIDENCE_DIR`, `SECURITY_FUSION_CONTAINMENT_COMMAND` and
  `SECURITY_FUSION_MATTERMOST_URL`, `_BOT_TOKEN` and `_CHANNEL_ID`): startup and
  `magnus-server check` accept it whatever its value, so it can be deleted at any time.

## [3.1.2] - 2026-11-17

### Fixed

- `docker/compose.yml` defaults `MAGNUS_VERSION` to `3`, the current major, instead of `1`. A
  release test now keeps the Compose default and `docker/.env.example` on the package major.
- `magnus-server --help` names `--allow-major` in the `agents upgrade` summary, as
  `magnus-server agents --help` already did.

### Removed

- `magnus-server env-schema` no longer lists the retired Security Fusion local-mode settings
  (`SECURITY_FUSION_RECEIPT_SIGNING_KEY`, `SECURITY_FUSION_EVIDENCE_DIR`,
  `SECURITY_FUSION_CONTAINMENT_COMMAND` and `SECURITY_FUSION_MATTERMOST_*`), and
  `SECURITY_FUSION_MODE` documents only `off` and `remote`. The dead local-mode secret check is
  gone from startup validation; `SECURITY_FUSION_MODE=local` is still refused with migration
  instructions.

## [3.1.1] - 2026-11-15

### Fixed

- Quick commands reject unsupported operations before registering work or dispatching to a node,
  with actionable guidance. The existing Magnus status button maps only its exact fixed arguments
  to a registered read-only service diagnostic with supervised completion evidence. Existing uptime
  receipts retain their original registry authority; prior uncertain commands require independent
  reconciliation and are never replayed or relabeled.

### Changed

- Update runtime dependencies: `@hono/node-server` 2.1.8 (server, fleet gateway and agent),
  `dotenv` 18.0.10, `jose` 6.2.17, `ws` 8.22.2, `bullmq` 6.7.5 and `next` 16.4.6. The root
  `@hono/node-server` override and the agent's standalone shrinkwrap now pin 2.1.8.

## [3.1.0] - 2026-11-15

### Added

- A root-only native snapshot CLI discovers every managed Ardent profile, captures complete
  stopped profile/runtime state, verifies protected bundles, and stages same-host restores before
  promotion. Source service enablement and initial active state are retained. Pending or uncertain
  work stays preserved and blocks activation; interrupted sessions keep their recovery journal.
  SQLite checks use private database/WAL copies without touching source sidecars. An explicit,
  pinned recovery command can re-observe a refused initial quiescence while retaining its exact
  failed journal; it never restarts work or replays capture or restore.

### Fixed

- Node software version checks use an authenticated read-only metadata endpoint instead of a
  generic shell command. The agent reports installed package metadata and its running Node.js
  and agent versions without executing discovered software or package-update hooks. Older agents
  return explicit update guidance; there is no command fallback. Package-update counts read only
  the local APT cache and report its last successful refresh time when known; checking never
  refreshes repositories or installs packages.
- The node agent signs managed terminal completion receipts with its node key when sending them
  to Magnus or returning them through the terminal relay. Closing a restricted terminal no longer
  leaves its verified completion held by a server that requires node signatures. Retained receipt
  bytes and their original HMAC remain unchanged; retrying settlement after an interruption signs
  the same completion evidence without reopening the shell.

### Upgrading

- 3.0.x (and any release from 2.10.2) upgrades to 3.1.0 in place: the server with `magnus upgrade`, agents with `magnus-server agents upgrade --to 3.1.0`. Either side can go first. Until an agent is on 3.1.0, the node's software read answers `SOFTWARE_STATUS_UNAVAILABLE` with update guidance (no command runs), and `magnus-agent native-snapshot` is not available on that node.

**New environment variables:** None.

**Migration impact:** No datastore migrations.

## [3.0.3] - 2026-11-15

### Fixed

- Node agent: installing or updating the Ardent package (**Update package** in the console, the `package-install` action) failed on an owner account that had never had anything under the install prefix's parent, such as a fresh account without `~/.local/share` for the default `~/.local/share/ardent`. Since 2.4.0 the agent created its private staging directory beside the prefix with `mkdir -m 700` and no `-p`, so the owner command failed when that parent was missing. The agent now first creates, as the owner, each missing directory between the owner home and that parent, one level at a time and each as a new 0700 directory (never `mkdir -p`). Every level, new or existing, must resolve to a directory inside the owner home before the next is touched, so a symbolic link that leads out of the home (or nowhere) is refused and nothing is created through it; a link to a directory inside the home still works, as before. The staging directory itself is still created without `-p`, so one that already exists fails.

### Upgrading

- 3.0.2 (and any release from 2.10.2) upgrades to 3.0.3 in place: agents with `magnus-server agents upgrade --to 3.0.3`, the server with `magnus upgrade`. Only the agent changed; either side can go first. Retry a failed **Update package** after the agent is on 3.0.3.

**New environment variables:** None.

**Migration impact:** No datastore migrations.

## [3.0.2] - 2026-11-15

3.0.0 retired the shared node secrets from every path but two: the server still needed
`RESULT_SIGNING_SECRET` for the console drain finding it records for itself and to fetch writer
proofs, and an agent still needed `COMMAND_RECONCILIATION_SECRET` to read the historical-mutation
settlements it stored with it. 3.0.2 removes both needs. See `docs/NODE_CREDENTIALS.md`,
"Retiring the shared keys".

### Added

- Node agent: `COMMAND_RECONCILIATION_PREVIOUS_SECRET`, a verify-only slot for the shared reconciliation key. Historical-mutation settlements (`.magnus/mutation-barrier/historical-*.json`) and recorded command reconciliations stored with it keep verifying; nothing new is signed with it, and new settlements use the node-local reconciliation key. It must differ from every other secret, including `COMMAND_RECONCILIATION_SECRET`.
- Node agent: `magnus-agent historical-settlements list [--json] [--check]` reports every stored settlement: whether it verifies with the node-local keys alone, only with a shared key, or with no key the agent holds, whether the request record it settles is still retained, and whether the agent honours it. `--check` exits 1 while any settlement needs a shared key, verifies with none, or is refused.
- Node agent: `magnus-agent historical-settlements reseal [--apply]` MACs the settlements that verify only with a shared key again with the node-local keys (observation and receipt with the result key, the decision with the reconciliation key). What a settlement settles, its boot proof and its timing are unchanged; afterwards the shared key and its previous slot can be removed.
- Node agent: `magnus-agent historical-settlements prune --unverifiable [--with-records] [--apply]` moves settlements that no key of this agent verifies (or that are not settlements) out of the mutation barrier. Without `--with-records` the record each one settled stays and counts as unknown again until it is settled anew; with it, that record is moved too, but only when its bytes are the ones the settlement names and it was accepted before the current kernel boot.
- Both writing commands are dry runs without `--apply`, need root with it, take the barrier's lock (the agent can keep running), keep a file owner's ownership, and keep every file they replace or remove, with a `manifest.json`, in a new 0700 directory under `$AGENT_INSTALL_DIR/.magnus/historical-settlement-archive/`. Nothing is deleted.
- `magnus-agent --env-file` may be given more than once; an earlier file wins.

### Changed

- Server: the console drain finding the server records for itself when no console participant exists (`RESOURCE_ENROLLMENT_DASHBOARD_PARTICIPANT=absent`) is signed with the server's Ed25519 key, in a protocol of its own (`magnus.server-own-evidence.v1`, so it can never pass as node evidence or as a decision for an agent), as `serverSignature` with the signing key's id. It keeps verifying after a server-key rotation. It used to be an HMAC with `RESULT_SIGNING_SECRET`, and the server refused absent-mode drains without that key (`503 RESOURCE_PARTICIPANT_UNCONFIGURED`); without a readable server key it now answers `503 SERVER_KEY_UNAVAILABLE`.
- Server: the host-local mutation and OS scheduler writer proofs (the transfer-authority snapshot's independent writer coverage) are fetched from the agent whether or not `RESULT_SIGNING_SECRET` is set. Agents sign them with their node key; without the shared key the server used to skip the fetch, so both writer classes stayed `unverified`.
- Server: `RESULT_SIGNING_PREVIOUS_SECRET` verifies on its own. Findings and evidence stored with the shared key (console drain findings written by 3.0.1, and, under an explicit `compat` or `warn`, HMAC-only agent evidence: drain receipts, writer proofs, terminal receipts, results, refusals and absences) verify with `RESULT_SIGNING_SECRET` or with `RESULT_SIGNING_PREVIOUS_SECRET`, so the shared key can be moved to the previous slot. Before, the previous key counted only next to a current one. It is now in the server's environment catalogue.
- Node agent: the execution supervisor also refuses and unsets `RESULT_SIGNING_PREVIOUS_SECRET` and `COMMAND_RECONCILIATION_PREVIOUS_SECRET` in a command's environment, and child processes never inherit the latter.

### Upgrading

- 3.0.1 upgrades to 3.0.2 in place: the server with `magnus upgrade`, agents with `magnus-server agents upgrade --to 3.0.2` (same major; no `--allow-major`). Either side can go first: a 3.0.2 server reads the console findings 3.0.1 stored and fetches writer proofs from 3.0.1 agents, and a 3.0.1 server receives the same node-signed evidence from 3.0.2 agents.
- Nothing changes until an operator moves a key. Then, on the server: replace `RESULT_SIGNING_SECRET=` with `RESULT_SIGNING_PREVIOUS_SECRET=` (same value) and restart. On each agent: replace `COMMAND_RECONCILIATION_SECRET=` with `COMMAND_RECONCILIATION_PREVIOUS_SECRET=`, restart, run `magnus-agent historical-settlements reseal --apply` as root, check with `historical-settlements list --check`, then remove `COMMAND_RECONCILIATION_PREVIOUS_SECRET`. Settlements no key verifies: `historical-settlements prune --unverifiable` (add `--with-records` to retire the records they settled).
- A stored settlement the agent cannot verify is not only reported: every read of the mutation barrier that consults settlements fails on it, so on that node `GET /api/v1/commands/mutation-inventory` and `GET /api/v1/commands/host-local-writer-proof` answer 409, its enrollment drain is refused (`inventory-failed`) and `historical-mutation-cli inspect` stops. Managed requests, upgrades and readiness are not affected. Removing the shared key without the previous slot does this to every settlement signed with it.
- A server rolled back to 3.0.1 does not read the console findings 3.0.2 signed with its key: refresh the console participant of a draining node after a rollback (findings expire with their 30-second challenge anyway). A 3.0.1 agent reads re-sealed settlements (it verifies with the node-local keys too).

### New environment variables

- Server, optional, secret: `RESULT_SIGNING_PREVIOUS_SECRET` (verify-only previous value of `RESULT_SIGNING_SECRET`).
- Node agent, optional, secret: `COMMAND_RECONCILIATION_PREVIOUS_SECRET` (verify-only previous value of `COMMAND_RECONCILIATION_SECRET`).

**Migration impact:** No datastore migrations.

## [3.0.1] - 2026-11-14

3.0.0 left no supported way to move an existing agent from 2.10.x to 3.0.x: the managed upgrade
stayed within a major and a 2.10.2 agent refused a major request. 3.0.1 adds an explicit,
server-signed path. See `docs/NODE_CREDENTIALS.md`, "Moving agents across a major version".

### Added

- `magnus-server agents upgrade --to <X.Y.Z> --allow-major`, and `allowMajor` in `POST /api/v1/agents/upgrade` (and in `GET /api/v1/agents/upgrade/eligibility`): agents of another major version are selected too, and each request that crosses a major carries a `majorAuthorization`, an Ed25519 signature with the server key (authorization kind `agent-major-upgrade`) over the node id, the package, the version the agent runs, the target version, the tarball integrity and an expiry one hour ahead. The agent verifies it against the server key it pins, so a signature for another node, version change or tarball does not verify, and the shared node secret never authorizes a major. A retry keeps the run's `allowMajor`; the run start audit records it and the nodes it moves across the major. Without `--allow-major` such nodes stay `MAJOR_VERSION`, as before.
- The dry run (`--dry-run`, **Check**, `dryRun`) judges agents as the run would: 2.10.3 and later with an active node key are eligible; agents 2.10.0 to 2.10.2, which cannot verify the authorization, are listed as `MAJOR_NEEDS_STEPPING_STONE` (the CLI prints `Needs a stepping stone first: <node> (2.10.2 -> 2.10.3)`); a node without an active key as `MAJOR_NEEDS_NODE_KEY`. New upgrade problem codes: `MAJOR_NEEDS_STEPPING_STONE`, `MAJOR_NEEDS_NODE_KEY`, `SELF_UPGRADE_MAJOR_UNAUTHORIZED` (an agent refused the authorization) and `SERVER_KEY_UNAVAILABLE` (the server could not sign it; nothing is sent). A strict client must accept them.
- Node agent: the 3.0.1 agent accepts a major self-upgrade on the same terms as the 2.10.3 agent (only with a valid authorization, only with a bound key) and reports `majorUpgradeAuthorization: 1` in its self-upgrade status, so the next major can be crossed the same way.
- The upgrade end-to-end test (CI) installs the published 2.10.2 agent next to this server, moves it to the published 2.10.3 with an ordinary managed upgrade from this server, checks that without `--allow-major` it is left out and that with it the stepping stone is named, and then moves it to this release with `--allow-major`.
- Release tooling: a release older than npm's `latest` is published under the dist-tag `maintenance-<major>.<minor>` instead of `latest`.

### Changed

- The console's agent upgrade dialog points at the cross-major procedure instead of a manual upgrade on each node; the remedies of `MAJOR_VERSION` and `SELF_UPGRADE_REFUSED` say how to authorize a major.

### Upgrading

- A 3.0.0 server upgrades to 3.0.1 in place (`magnus upgrade`); a 2.10.2 server follows "Upgrading to 3.0.0" in `docs/NODE_CREDENTIALS.md` with `--allow-major`, straight to 3.0.1.
- Then, on the server host, for a fleet on 2.10.x agents:
  1. `magnus-server agents upgrade --to 3.0.1 --allow-major --dry-run` lists who needs the stepping stone;
  2. `magnus-server agents upgrade --to 2.10.3` (a patch within 2.10, from this server; 2.10.3 is on npm under `maintenance-2.10`);
  3. `magnus-server agents upgrade --to 3.0.1 --allow-major`.
- Rotate the server key only after the agents are on 3.0.x.

**New environment variables:** None.

**Migration impact:** No datastore migrations.

## [3.0.0] - 2026-11-14

3.0.0 is a major release: per-node credentials, phase 3 (`enforce`). See
`docs/NODE_CREDENTIALS.md`, "Upgrading to 3.0.0".

### Breaking changes

- `NODE_AUTH_MODE` defaults to `enforce` on the server and on the agent (it was `compat`). In enforce mode:
  - the shared node secret (`x-node-token`) is refused on every node route in both directions, and is no longer sent: the server signs every request to an agent, and an agent with a bound key sends only its signature. A signed request that also carries the shared secret (what 2.10.2 agents and servers send) is judged by the signature alone;
  - evidence that carries only the shared-key HMAC (`RESULT_SIGNING_SECRET`) is refused, and decisions the server makes for a node (command reconciliations, scheduler enrollment stages, scheduler-source settlements) are signed with the server key only and refused when they come back with only the `COMMAND_RECONCILIATION_SECRET` HMAC;
  - `POST /api/v1/node-enrollment/legacy-upgrade` answers `410 LEGACY_UPGRADE_CLOSED` before it looks at any credential, whatever `NODE_AUTH_LEGACY_UPGRADE_UNTIL` says; new nodes enroll with a one-time token;
  - `NODE_AUTO_REGISTER` defaults to off;
  - `POST /api/v1/cron/scheduler-sources/reconcile` (the reviewer-signed settlement) answers `409 NODE_AUTH_ENFORCED`; use the two-ADMIN approval below.
- **Start-up guard.** A server whose `NODE_AUTH_MODE` is unset refuses to start (exit 1) while any real node has no active key, only revoked keys, an agent that does not sign its evidence, or an agent 2.10.0/2.10.1 (whose managed requests enforce cannot reach). The message names the nodes and the two ways out: enroll or upgrade them, or set `NODE_AUTH_MODE=compat` explicitly. The internal `__control-api__` and `__dashboard__` nodes and decommissioned nodes never count. `magnus upgrade` switches back by itself when the new release does not start.
- An explicit `NODE_AUTH_MODE=compat` or `warn` keeps working for this major and logs `DEPRECATED` at start; both are removed, with `NODE_MANAGER_SECRET`, `RESULT_SIGNING_SECRET` and `COMMAND_RECONCILIATION_SECRET`, in the next major.
- `NODE_MANAGER_SECRET` and `RESULT_SIGNING_SECRET` are no longer required by the server or the agent unless the mode is an explicit `compat` or `warn` (they are still honoured when set). `magnus init` of 3.0.0 no longer generates them, and `docker/compose.yml` no longer requires them.
- The fleet summary gains the blocker code `AGENTS_NEED_UPGRADE`. A strict client must accept it.
- 3.0.0 upgrades only from 2.10.2 (`minUpgradeFrom`). Agents 2.9.x and older are not supported by a server in enforce mode.

### Upgrade order

1. Server on 2.10.2, every agent on 2.10.2 or later (each with a bound key: `nodeCredential.state: active`). Agents 2.10.0 and 2.10.1 move to 2.10.2 with the console's **Upgrade agents** or `magnus-server agents upgrade`.
2. Optional, recommended: set `NODE_AUTH_MODE=warn` on the 2.10.2 server, restart it, and use the fleet normally for a day, so that remaining uses of the shared secret show up before they are refused.
3. Confirm `GET /api/v1/node-credentials/summary` reports `enforceReady: true` (no blockers).
4. Remove `NODE_AUTH_MODE` from the server's environment and upgrade the server to 3.0.0 (`magnus upgrade --allow-major`). It applies no migration. The start-up guard checks the inventory first: if a node would be locked out, the server does not start, names the nodes, and `magnus upgrade` switches back to 2.10.2 by itself.
5. Then the agents. A 2.10.2 agent with a key keeps working with a 3.0.0 server in enforce mode, so there is no hurry. Moving an agent to 3.0.0 crosses a major version, which no automatic path does: the console's **Upgrade agents** and `magnus-server agents upgrade` list such nodes as `MAJOR_VERSION`, and a 2.10.2 agent refuses the request (`SELF_UPGRADE_REFUSED`). Upgrade those agents by hand on each node; new nodes install 3.0.0 directly and enroll with a token. Two things wait for a 3.0.0 agent on a node: the two-ADMIN scheduler-source settlement (a 2.10.2 agent answers `409 AGENT_UPGRADE_REQUIRED` in enforce mode; settle under an explicit `NODE_AUTH_MODE=compat` if one is needed sooner), and server-key rotation, which pins a staged key from the heartbeat only on 3.0.0 agents (rotate after the agents are on 3.0.0; see `docs/NODE_CREDENTIALS.md`, "Rotating the server key").

**Hive installations:** a Hive suite installs Magnus by the exact versions and digests in its signed manifest. Hive 3.8.1 ships Magnus 2.10.2. Do not point a Hive installation at Magnus 3.0.0 by hand: wait for the Hive suite release whose notes list Magnus 3.0.0, and follow its upgrade notes.

### Rollback

- Set `NODE_AUTH_MODE=compat` on the 3.0.0 server and restart it: the shared node secret is accepted (and sent where needed) again, as in 2.10.2. Set the same in an agent's `.env` for that agent to accept it again.
- Or `magnus rollback` to 2.10.2: there is no migration to undo, the server key file and the database are read as they are, and 3.0.0 agents keep working with it (they sign; 2.10.2 verifies).
- Before downgrading an agent below 3.0.0, keep `RESULT_SIGNING_SECRET` in its `.env`: records it MACed with its node-local key cannot be read by 2.10.x.

### Added

- Server-key rotation: `POST /api/v1/node-credentials/server-key/stage`, `/promote` and `/retire` (ADMIN), and `magnus-server node-auth server-key status|stage|promote|retire`. A staged key is pinned by agents from the heartbeat reply's `serverKeyIds` before the server signs with it; promote waits until every keyed agent reported pinning it (`409 SERVER_KEY_NOT_PINNED`, or `force`); the replaced key stays an accepted audience for a grace period (default 7 days); a retired key's private part is destroyed and its public key kept, so decisions it signed keep verifying on the server and on agents. An agent that missed a promotion is refused once and pins the new key by itself. The summary carries `serverKeyRotation`.
- Two-ADMIN scheduler-source settlement: `POST /api/v1/cron/scheduler-sources/reconcile-requests`, `.../:id/approve` and `.../:id/reject`. One ADMIN person requests with a reason, a different one approves within 15 minutes, and the server signs the settlement for the node with its server key (new authorization kind `scheduler-source-settlement`). It replaces the reviewer's `COMMAND_RECONCILIATION_SECRET` signature, a key that agents held too. Agents 3.0.0 advertise `features.schedulerSourceAuthorizations`.
- The fleet summary reports `modeExplicit`, `modeDeprecated` and `deprecationNotice`, and counts real nodes only.
- Agents MAC their own records (command ledger, historical mutation observations, receipts and decisions) with node-local keys in `$AGENT_INSTALL_DIR/identity` when the shared keys are absent, and read records signed with the shared keys (also as `RESULT_SIGNING_PREVIOUS_SECRET`), so a ledger written by 2.10.x stays readable without being rewritten.
- The upgrade end-to-end test starts from the release's `minUpgradeFrom`, runs the fleet in an explicit compat, lets the guard admit enforce once the node is keyed, and rotates the server key with the agent reachable throughout.

### Changed

- A new agent without a shared secret logs that it waits for `magnus-agent enroll --token`, answers a shared-secret request with `401 NODE_SIGNATURE_REQUIRED` instead of `500 CONFIG_ERROR`, and does not attempt the legacy upgrade.
- `magnus-server` start-up logs the mode and whether it is the default, and the server key with a staged or replaced one.
- `magnus-agent acceptance` works without `NODE_MANAGER_SECRET`: it signs the probe with the node key (and refuses to run with neither).

**New environment variables:** None. `NODE_AUTH_MODE` and `NODE_AUTO_REGISTER` change their defaults; `NODE_MANAGER_SECRET` and `RESULT_SIGNING_SECRET` become optional outside an explicit compat or warn.

**Migration impact:** No datastore migrations.

## [2.10.2] - 2026-11-14

### Fixed

- Managed HTTP to an enrolled node whose agent has a node key. Agents 2.10.0 and 2.10.1 authenticated `POST /api/v1/commands/managed-http` twice (for `/api/v1/*` and for the route itself), and the second pass refused the nonce the first had just claimed, so every signed managed request answered `401 NODE_AUTH_REPLAY` before anything ran: agent upgrades from the console or `magnus-server agents upgrade`, Embermend, skills and other mutations of such a node failed, and the server kept each lease `unknown`. Nodes that are not enrolled use the direct routes and were not affected, nor were agents without a key.
  - Agent: one request is authenticated once, however many times the middleware is mounted on its route. A nonce is still accepted once: a replay of the same signed request is refused.
  - Server: an agent of 2.10.0 or 2.10.1 with a key is reached without upgrading it first. The server checks with an unsigned `GET` of the managed route, which runs nothing, that the agent accepts the shared secret, then sends the managed request with the shared secret only, as `compat` and `warn` allow, and counts the use under `outbound`. The resource claim, fence and ledger receipt still decide what runs. In server `enforce` mode, or when the agent enforces its key, nothing is sent and the request fails as not dispatched with `AGENT_MANAGED_HTTP_NEEDS_UPGRADE`. Other agents get signed requests as before. See `docs/NODE_CREDENTIALS.md`.
  - A lease left `unknown` by such a refusal is settled as `not-dispatched` from the agent's signed ledger account: by the readiness monitor past the lease deadline, or at once with `magnus-server agents doctor --heal`.
- Node agent: the `hermes-cli` check of `GET /api/v1/health/check` no longer runs `hermes --version` with a 2.5-second limit, which failed on nodes where that command is slow and so made the agent `degraded` and its upgrade acceptance probe fail. It reads Hermes discovery's cached version probe and answers within 2 seconds: the cached version, or that the binary answers `hermes profile list` (recently, or in a liveness check it starts and shares) while the version probe is pending or ran out of time.

**New environment variables:** None.

**Migration impact:** No datastore migrations.

## [2.10.1] - 2026-11-14

### Fixed

- Node agent: Hermes discovery no longer reports a working Hermes as `degraded` (gateway `unknown`, no version) when its version command is slow. Since 2.10.0 a root agent runs a user-installed Hermes as its owner, and on some installs `hermes version` is not a command while `hermes --version` takes most of a minute, longer than the 10-second limit each form had, so discovery found no runnable Hermes. Now:
  - The version probe runs once per binary and caches its result per resolved executable, its size, modification time and inode, the Hermes home and the account it runs as. It runs again when the binary changes, after Magnus installs, updates or removes Hermes, and at most daily otherwise; a binary that disappears is forgotten.
  - The probe has 90 seconds across both forms and runs in the background. Discovery waits for it up to 10 seconds, as before, then checks that Hermes answers `hermes profile list` (whose output it reuses for the profile list) and reports it as runnable with no version. When the probe finishes, the agent refreshes its Hermes snapshot so the next heartbeat carries the version. A probe that fails or runs out of time leaves the version empty; it no longer makes a trusted, working Hermes look missing. The rules for which account runs Hermes are unchanged.
  - Hidden entries are no longer reported as profiles: a hidden directory such as `profiles/.deleted` in a Hermes home appeared as a profile named `.deleted` when discovery found no runnable Hermes and fell back to reading the profiles directory. Profile names from `hermes profile list` follow the same rule.

## [2.10.0] - 2026-11-13

### Added

- Per-node credentials, phase 1 (`compat`). Each node agent now has its own Ed25519 key and the server has a signing key; requests in both directions are signed for exactly one node, with a timestamp, a single-use nonce and the hash of the body. `docs/NODE_CREDENTIALS.md` explains the model, the migration and the rollback. Nothing has to be done on a node:
  - An upgraded agent creates its key in `$AGENT_INSTALL_DIR/identity/node.key` (mode 0600) and binds it to its node with the shared node secret, after its first accepted heartbeat and never while a self-upgrade is on trial. The server binds a node's first key only when the node is in the inventory, has no key yet, the request comes from the address recorded for the node, and the upgrade window is open (30 days from the first start of this release, or `NODE_AUTH_LEGACY_UPGRADE_UNTIL`). Each binding is audited and raises a notification with the key fingerprint; a second agent that asks to bind the same node is refused with 409 and a critical notification.
  - Once a node has a key, the shared node secret can no longer speak for it: a request with `x-node-token` that names that node is refused with `401 NODE_CREDENTIAL_REQUIRED`. With a signature, the node is the key's node, and a body that names another node (`fqdn`, `nodeFqdn`, `nodeId`) is refused with `403 NODE_IDENTITY_MISMATCH`, so a heartbeat can no longer rename or re-address another node.
  - The server signs every request to an agent and stops sending the shared secret to a node once its agent reports, in a signed heartbeat, that it pins the server's key. An agent verifies a signed request (made for this node, fresh, not replayed, exact method, path, query and body) and still accepts the shared secret.
  - Old and new versions mix freely: an older agent keeps working on the shared secret against this server, and this agent keeps working against an older server and binds its key once the server is upgraded.
  - New commands: `magnus-agent enroll --token`, `magnus-agent identity show|rotate|reset`. New server routes: `GET /api/v1/node-enrollment/server-key`, `POST /api/v1/node-enrollment/legacy-upgrade|enroll|rotate`, and for administrators `GET /api/v1/nodes/:nodeId/credentials`, `POST /api/v1/nodes/:nodeId/enrollment-token`, `.../credentials/revoke` and `.../credentials/reset`. `POST /api/v1/nodes/register` also returns a one-time `enrollmentToken`. Node reads carry `nodeCredential` (`state` `none`, `active` or `revoked`; the key fingerprint for administrators); `nodeManagerSecretState` is unchanged.
  - `NODE_AUTH_MODE` on the server: `compat` (default), `warn` (also logs each use of the shared secret) and `enforce` (signatures only, opt-in). The agent's own `NODE_AUTH_MODE` arrives in phase 2 below.
- Per-node credentials, phase 2 (`warn`). The default mode stays `compat`; see `docs/NODE_CREDENTIALS.md`.
  - Signed evidence: an agent with a bound key also signs its evidence with the node key (`nodeSignature`: command results, refusals and absences, fence proofs, node session and terminal receipts, agent and scheduler drain receipts, host-local and OS scheduler writer proofs, scheduler stage and settlement receipts), over the same canonical payload as the `RESULT_SIGNING_SECRET` HMAC plus its node id and key id. The canonical payloads now live in one module shared byte-for-byte by the server and the agent, with cross-wire vectors. The server verifies the node key first and binds the evidence to the node it is about; it accepts the HMAC only while the node's agent does not sign evidence (it says so in its signed heartbeats) and the mode is not `enforce`. The agent signs only after the server's heartbeat reply says it verifies such signatures, so an older server never sees the new field.
  - Command reconciliation decisions (ADMIN `command-reconcile`, Embermend owner settlement) and scheduler enrollment stages are signed with the server key for the one node they are for (`serverSignature`). An agent of this release verifies them against the key it pins and advertises `features.serverAuthorizations`; `COMMAND_RECONCILIATION_SECRET` is only needed for older agents. Reviewer-signed scheduler source settlements still use it.
  - Agent-side enforce: with `NODE_AUTH_MODE=enforce` and a bound key, the agent refuses requests that carry only `x-node-token` on every `/api/v1/*` route, and HMAC-only decisions. Its in-process managed dispatch no longer uses the shared secret, and the upgrade acceptance probe signs with the node key. This closes access from one node's `.env` to another node's management API.
  - Pending bindings: an automatic binding refused for its address is kept for an administrator: `GET /api/v1/node-credentials/pending-bindings`, `POST .../pending-bindings/:id/approve|reject` (audited).
  - Shared-credential accounting per node and channel (`request`, `evidence`, `outbound`): node reads carry `nodeCredential.evidenceSigning` and `nodeCredential.legacyUse`; `GET /api/v1/node-credentials/summary` lists counts and what blocks `enforce`. In `warn` mode each use is audited once a day per node and channel (`node.credential.legacy_use`) and the readiness probe reports a failing non-critical `node-credentials` check while anything blocks `enforce`.
  - `GET /api/v1/node-credentials/downgrade-check?nodeId=<id>&to=<version>` names the credential reset an older agent needs first.
  - `magnus-agent enroll --token-file <path>` (`-` for standard input) keeps the enrollment token off the process table; `--token` still works.
  - `magnus-server agents ...` reads the server's package `.env` like `start`, signs agent requests with the server's own key file and prints its fingerprint; a command-line process never creates a server key of its own.
- Server: `POST /api/v1/nodes/:nodeId/credentials/revoke` and `.../credentials/reset` take an optional `reason` (1 to 500 characters), recorded in the audit event with the acting user, and an optional `x-idempotency-key` header (a repeat answers `409 DUPLICATE_REQUEST`). Their responses also say what the change leaves behind: a revoke adds `state`, `agentRefused`, `sharedSecretAccepted` and `resetAvailable`, a reset adds `state`, `sharedSecretAccepted` and `legacyUpgradeOpen`, each with a `detail` sentence. `revoked` and `removed` are unchanged.
- Server: `NODE_AUTO_REGISTER=false` stops adding unknown agents that present the shared node secret to the inventory. The default (`true`) is the previous behaviour.

### Security

- Browser API: an `ADMIN` can now list, revoke and reset a node's keys from a browser UI such as HiveXUI. `GET /api/v1/nodes/:nodeId/credentials`, `POST /api/v1/nodes/:nodeId/credentials/revoke` and `POST /api/v1/nodes/:nodeId/credentials/reset` moved from `exclude` to the `browser` class, ADMIN only, with schemas in the browser contract (`docs/console-api.md`). Why: none of them returns a secret, and the server checks the role on each request, so an `OPERATOR` or `VIEWER` is refused whatever the UI shows; node, plugin, fleet-check, shared-resource and Ardent service credentials are refused on them as before. Issuing an enrollment token stays out of the browser class because its response is a secret, and so do the shared-secret lifecycle routes under `/api/v1/credentials/:name`, the terminal and password logins. The route inventory test fails if another credential route joins the browser class without review. Ingresses that follow the browser allowlist will now allow these three routes.
- Node agent: drift file checks refuse the agent's `identity` directory, so a content or hash check cannot be used to probe the node key.
- Node agent: a root agent no longer runs a Hermes executable, or runs one against a Hermes home, that another account controls as root. Hermes discovery (every heartbeat cycle), the Hermes management routes and the `hermes-cli` health check now run such an executable as the account that owns it or its home, with that account's own `HOME` and session bus. Before, any local account with a home directory could place a `hermes` file there and have the agent run it as root. A Hermes installed for a user is therefore run as that user from now on; a root-owned install with a root-owned home is unchanged. The health-check probes no longer inherit agent credentials, and `OTEL_EXPORTER_OTLP_HEADERS` is no longer passed to child processes.
- Skills: `backup-manager` writes archives and checksums readable only by the invoking account (a default run archives `/etc`), purges only its own archives directly in the destination, and validates the retention. `news-reporter` sends the API key in a header read from stdin instead of the URL, validates its settings, bounds the request time and filters every remote field.
- Server: creating a skill no longer lets a name or entry point with path separators write outside the skills directory, and skill file reads and writes can no longer reach a sibling skill whose name starts with the same text. Skill names must be letters, digits, underscores and hyphens; an entry point must be a plain file name.
- Fleet assistant: approving, rejecting or confirming a pending tool call now requires read access to its conversation (the owner, or any operator for the shared fleet heartbeat); for anyone else it answers 404. Two concurrent decisions on the same call can no longer both run the tool, and confirming a command is audited with the person who confirmed it.
- Fleet assistant: `runSkill` refuses a skill name or action that is not a plain name before it builds the node-side command. The file tools also refuse private keys, certificates, `.npmrc`, databases, dumps and the `certs`, `state`, `artifacts` and `backups` directories.
- Server: the audit, command and log CSV exports quote every cell and stop a spreadsheet from evaluating a cell as a formula. A quote in an actor, target or node value previously shifted that row's columns.

### Changed

- Track Ardent 3.1.3 (Mattermost, Telegram, llama.cpp stream and artifact staging fixes). Its management API is unchanged, so the node-agent Ardent routes are unchanged.
- Console: Hive IAM sign-in now explains a refused client. Oathweave requires a confidential client to authenticate when it exchanges an authorization code, so a console whose client is registered as confidential must set `HIVE_OAUTH_CLIENT_SECRET` (a public PKCE client needs no secret; the console has always sent the PKCE verifier, and the secret when configured). When the identity service answers `invalid_client`, the console logs that the secret is missing or wrong instead of failing silently. The environment reference and `docs/APP_ARCHITECTURE.md` describe both registrations.

### Fixed

- Node agent: log forwarding no longer stalls for good when the server rejects a batch. Journal messages that journalctl prints as byte arrays (lines with colour escapes, for example) are decoded, and a batch the server answers with 400, 413 or 422 is dropped instead of being re-queued ahead of every later entry.
- Node agent: a non-numeric `OTEL_FLUSH_INTERVAL_MS` or `HERMES_DISCOVERY_INTERVAL_MS` falls back to the default instead of becoming a one-millisecond timer or a rediscovery on every heartbeat. The disk probe runs `df` without a shell and does not start another while an earlier one is stuck on a dead mount. `GET /api/v1/traces?limit=` handles non-numeric and negative values.
- Server: a log stream that the server ends (revoked or expired identity session) now releases its keep-alive timer and log subscription. Each such stream previously left both behind until the server restarted.
- Server: scheduled AI operations compute their next run from all five cron fields. Step values such as `*/15` in the minute or hour field were refused with an unexplained 400, and the day-of-month, month and day-of-week fields were ignored, so a weekly schedule ran daily. Expressions are validated when a schedule is created or changed: numbers, `*`, ranges, steps and lists are supported; names such as `MON` are not.
- Server: malformed JSON, an invalid path parameter or an invalid body now answers `400 VALIDATION_ERROR` on the routes that answered `500` (scheduled AI operations, the Hermes registry, shared resource leases, Embermend operations, MCP, node user provisioning, and every route that reads a body through the shared parser). An oversized body still answers `413`.
- Server: `page`, `pageSize`, `limit`, `hours` and `windowMinutes` query values that are not numbers fall back to the default, and out-of-range values are clamped, instead of reaching the database. The library file list and webhook delivery list now cap `pageSize` at 200.
- Server: an invalid `date`, `from` or `to` on the audit routes answers 400 instead of 500.
- `magnus init` and `magnus upgrade`: an env-file value containing a single quote is written intact (double-quoted) instead of having the quote removed; a value that cannot be written faithfully is refused with a message.
- `magnus init` and `magnus adopt` with systemd: a project directory or env-file path containing whitespace or `" ' \ % $ ;` is refused before anything is written, instead of generating a unit that cannot start.

### New environment variables

- Server, all optional: `NODE_AUTH_MODE` (`compat`, `warn` or `enforce`; default `compat`), `NODE_AUTH_LEGACY_UPGRADE_UNTIL` (ISO 8601 date; default 30 days after the first start), `NODE_AUTH_SERVER_KEY_PATH` (default `$MAGNUS_HOME/state/node-auth/server-signing-key.json`), `NODE_AUTO_REGISTER` (default `true`).
- Node agent, optional: `NODE_AUTH_MODE` (`compat` by default; `warn` logs each use of the shared secret; `enforce` refuses it once the node has a bound key). No other new variables in phase 2.

### Upgrade notes

- **Order:** upgrade the server first, then the agents. Old and new versions mix freely, so the fleet keeps working on the shared node secret throughout. Each upgraded agent binds its own key by itself after its first accepted heartbeat, as long as the upgrade window is open (30 days from the server's first start on this release, or until `NODE_AUTH_LEGACY_UPGRADE_UNTIL`). Agents that are upgraded after the window closes need an enrollment token (`POST /api/v1/nodes/:nodeId/enrollment-token`, then `magnus-agent enroll --token-file`).
- **`enforce` is opt-in and last:** do not set `NODE_AUTH_MODE=enforce` on any agent until the server runs 2.10.0 and that agent has a bound key (`magnus-agent identity show` reports `bound`; the node shows `nodeCredential.state: active` and `evidenceSigning: true`), and do not set it on the server until `GET /api/v1/node-credentials/summary` reports nothing that blocks it. Use `warn` first to see which nodes and channels still use the shared secret. An agent in `enforce` refuses the shared secret and unsigned (HMAC-only) reconciliation decisions, which an older server cannot provide.
- **Back up the server key file with the database.** On first start the server creates its Ed25519 signing key at `NODE_AUTH_SERVER_KEY_PATH` (default `$MAGNUS_HOME/state/node-auth/server-signing-key.json`, mode 0600). Agents pin this key. If it is lost (for example a database restored without `$MAGNUS_HOME/state`), the server creates a new one and agents re-pin it over verified TLS on their next refused request, but agents in agent-side `enforce` refuse the server until they do. Each agent's key lives in `$AGENT_INSTALL_DIR/identity/node.key`.
- **Downgrade caution:** a server rolled back to an earlier release ignores the new tables. Before downgrading an agent that has bound a key to a release older than 2.10.0, reset that node's credentials on the server (`POST /api/v1/nodes/:nodeId/credentials/reset`, or check first with `GET /api/v1/node-credentials/downgrade-check?nodeId=<id>&to=<version>`): the older agent only knows the shared secret, which the server refuses for a node that has a key. A server in `enforce` has no reset, so keep such nodes on 2.10.0 or later. Set an agent back to `NODE_AUTH_MODE=compat` before installing an older version on it. Downgrading the server needs nothing: an older server ignores the new tables and signature headers.
- **Hermes runs as its owner:** a root agent now runs a user-installed Hermes (an executable or Hermes home owned by another account) as that account, with its own `HOME` and session bus, for discovery, the Hermes management routes and the `hermes-cli` health check. A root-owned install with a root-owned home is unchanged. Check that a user's Hermes works under that user's own permissions before relying on it after the upgrade.
- **Unknown agents:** set `NODE_AUTO_REGISTER=false` to stop agents that present the shared node secret from adding themselves to the inventory; the default keeps the previous behaviour.
- **Browser ingresses:** ingresses that follow the browser allowlist now allow `GET /api/v1/nodes/:nodeId/credentials` and the `revoke` and `reset` routes for ADMIN users.

**Migration impact:** Two additive datastore migrations. `20261113120000_node_credentials` creates `node_credentials`, `node_enrollment_tokens` and `node_auth_state`. `20261114090000_node_credentials_phase2` adds two columns with defaults to `node_credentials` (`evidenceSigning`, `evidenceSigningAt`) and creates `node_pending_bindings` and `node_legacy_credential_use`; it rewrites no row. Both are fast; `magnus upgrade` backs up PostgreSQL and applies them. A server rolled back to an earlier release ignores the new tables. See the upgrade notes above for the server key file and agent downgrades.

## [2.9.1] - 2026-11-12

### Fixed

- Fleet assistant: a model route whose primary provider is not Ollama (for example `emberpath`, `openai` or `llamacpp`) now sends its own model to that provider. The global AI settings model is an Ollama model and previously replaced every route's model, so such routes were sent the Ollama model id. The settings model still applies to Ollama routes, and to other routes only when they have no model. Streaming chat for a route whose primary provider is not Ollama now goes through the provider-aware request path instead of calling Ollama directly.

**New environment variables:** None.

**Migration impact:** No datastore migrations.

## [2.9.0] - 2026-11-12

### Added

- Fleet assistant: an opt-in `emberpath` model provider. Emberpath's OpenAI-compatible API is reached at `MAGNUS_EMBERPATH_URL` (the base URL including `/v1`, HTTPS in production) with the client key in `MAGNUS_EMBERPATH_API_KEY` and the model in `MAGNUS_EMBERPATH_MODEL`; the server refuses to start unless all three are set together. When they are, the default hosted routes (the `internet_data` route and the hosted fallbacks of the others) try Emberpath first and OpenRouter next; without them OpenRouter stays the hosted default. Saved model routes are unchanged, and `emberpath` can be chosen for any route. Give the Emberpath key `actorId` metadata so Emberpath attributes the assistant traffic.

### New environment variables

- Server, all optional and set together: `MAGNUS_EMBERPATH_URL`, `MAGNUS_EMBERPATH_API_KEY` (secret), `MAGNUS_EMBERPATH_MODEL`.

**Migration impact:** No datastore migrations.

## [2.8.0] - 2026-11-12

### Added

- Suite event feed: `GET /api/v1/hive/events` serves notifications from the last 14 days as HiveEvent v1 for the HiveXUI inbox, oldest first with an opaque `after` cursor and `limit` 1-200 (default 50). Each event links to the HiveXUI page for its node or Ardent profile and names the node, and for Ardent the agent reference and HiveMem actor. Summaries leave out command lines, probe output and upstream errors. Any role may read it; Ardent notifications are listed for ADMIN only. The browser contract publishes the route (`hiveEventFeedResponseSchema`).

### Changed

- `@hivemagnus/hive-common` is now `^0.4.0` in the server, the fleet gateway and the Oathweave package.

**New environment variables:** None.

**Migration impact:** No datastore migrations.

## [2.7.0] - 2026-11-12

### Added

- Agent identity: `GET /api/v1/agents/:agentRef/identity` resolves an agent reference (`<nodeId>~<profile>`) to its runtime and, for an Ardent profile enrolled in HiveMem, its HiveMem actor and workspace; `GET /api/v1/agents/identity?actorId=` is the reverse lookup. Any role may read them; Ardent profiles stay visible to ADMIN only. The browser contract publishes both (`agentIdentityResponseSchema`).

## [2.6.0] - 2026-11-12

### Added

- The server answers the suite health probes `GET /health/live` and `GET /health/ready` (PostgreSQL required, Redis degraded). `GET /` and `GET /api/v1/health` are unchanged.

### Changed

- Verify Oathweave tokens with the suite's shared verifier from `@hivemagnus/hive-common`, configured to keep Magnus's rules: no clock tolerance, a required `roles` claim, the `clientId` claim only and fifteen-minute tokens. The server and the fleet gateway gain the dependency `@hivemagnus/hive-common`. A few malformed tokens Magnus used to accept are now refused: a person's token whose `clientId` is empty or equals its subject, a token whose `client_id` contradicts its `clientId`, and a service token whose `roles` claim is not a string array.

**New environment variables:** None.

**Migration impact:** No datastore migrations.


## [2.5.0] - 2026-11-12

### Added

- Project each isolated source worker checkout to its admitted paths before execution, removing sibling applications, exclusions, Git objects and symlinks from the sandbox.

- Preserve unknown Compose instance health when an image has no Docker health check, rather than losing its inventory to a missing-field template failure.

- Managed source workers resolve same-owner repository renames by immutable provider identity and refuse ownership transfers or unexpected clone destinations.

- Recognize superseded ownership-recovery decisions only from a different immutable signed native acknowledgement; keep audit refusal ahead of delivery authority.

- Add exact-plan Embermend ownership settlement for independently reviewed, quiescent expired reboot and assessment operations. Retain the signed decision before delivery, recover lost acknowledgements by observation and preserve the historical outcome as unknown.

- Require exact previous-boot logind shutdown proof before adopting an Embermend reboot. A cancelled schedule followed by an unrelated boot, missing journal or mismatched trusted event retains uncertainty and ownership.

- Include bounded userspace package mapping evidence in configured Embermend package inventory, with stable process/file identities, explicit partial coverage and scoped limitations.
- Add opt-in, operation-bound Ubuntu reboot continuation using acknowledged systemd scheduling and subsequent-boot evidence. Retain uncertainty across lost replies and agent restarts.
- Bound Compose rollout to one reviewed service and immutable image, with independent current container and health inventory.

- Preserve partial scanner analysis when the approved model broker fails, and handle closed scanner input without losing cleanup ownership.

- Bind isolated preparation/source entry commands to an explicitly reviewed Node path compatible with the suite runtime.

- Retain native Embermend supervisor bindings and adopt exact successful worker completion after API-process loss without replay; incomplete or detached-work evidence retains ownership.

- Forward admitted scanner operation and source-policy context to an optional Embermend-owned inference broker, with exact provider identity and verified transport.

- Optional constrained Embermend product bridge with durable operation identities, signed result references, reviewed host actions and isolated source workers. Native reboot continuation and complete product acceptance remain release prerequisites.
- Exact TypeScript 6.0.3 with `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` in the affected contracts, agent and server workspaces; absent optional boundary values are omitted.

### New environment variables

- `MAGNUS_EMBERMEND_GRANTS_JSON` (server, secret): dedicated product credentials and exact target, environment and action grants; absent disables the bridge.
- `MAGNUS_EMBERMEND_CONFIG` (agent): canonical root-controlled resource and worker configuration; absent disables reviewed remediation capabilities.


## [2.4.3] - 2026-11-11

### Fixed

- Require patched Node.js 24.22.3 or 26.13.1 in native runtimes, builds, CI and container images, including the shared runtime.
- Upgrade Hono to 4.13.18 across the server, fleet gateway and agent to bound tiny-chunk request memory (GHSA-39q9-qp46-w8xg), with request-path regression coverage.
- Return generic API body-limit rejections as HTTP 413.
- Enforce the packaged Node.js security minimum before native agent start and service installation and report it in health and configuration checks.
- Track the patched Ardent 3.1.2 release.

**New environment variables:** None.

**Migration impact:** No datastore migrations. Native services require Node.js 24.22.3 or 26.13.1 or a later patch in the corresponding major line.


## [2.4.2] - 2026-11-11

### Fixed

- Use the registered absolute uptime diagnostic and its verified 60-second budget in the quick action and manual dispatch. Retain the existing budget for other commands and explain operator outcome review.
- Explain the stop, update and start sequence for Ardent package maintenance without changing runtime safety guards.

**New environment variables:** None.

**Migration impact:** No datastore migrations.


## [2.4.1] - 2026-11-11

### Fixed

- Track Ardent 3.1.1 so reviewed extensions can retain supported chunked workflow capacity while management and independent ingress keep separate bounded budgets. Authentication, body bounds and native extension receipts remain enforced.

**New environment variables:** None.

**Migration impact:** No datastore migrations.

## [2.4.0] - 2026-11-11

### Changed

- Track Ardent 3.1.0 and its owner-bound workflow, scheduler, channel, ingress and recovery extension hooks.
- Retain reviewed, receipt-bound extension archives through native package upgrades. Refuse configured plugins without a retained bundle, altered archives, a second runtime peer or untrusted dependency origins.
- Refresh dispatched command status and selected output automatically. Opening a result while work is queued no longer needs another click or a failed result request; failed reads retry without dispatching work again.


## [2.3.7] - 2026-11-10

### Fixed

- Allow successive managed Ardent package updates. Verify the active package and earlier checkpoint against their receipts, retain the older checkpoint beside the install, and restore both package paths if promotion fails. Unverified or interrupted states remain held for recovery.
- Refuse conflicting Ardent package, context, profile and service actions while a lifecycle action is running. Recheck that profiles are stopped before replacing the package.

**New environment variables:** None.

**Migration impact:** No database migrations.

## [2.3.6] - 2026-11-10

### Fixed

- Keep the terminal gateway health check working with IP product endpoints on Node 26. IP SAN verification remains enforced without sending an IP address as TLS SNI. Real built-CLI TLS tests cover DNS and IP success, certificate mismatches and an untrusted CA.

## [2.3.5] - 2026-11-10

### Security

- Pin Ardent 3.0.0, which replaces the affected embedded SQLite library with SQLite 3.54.1. Native installation uses bundled Node-API binaries without dependency install scripts or a compiler.
- Run server, fleet gateway, standalone dashboard and container-agent images on the pinned patched Node 26 runtime. Pair the server's maintained PostgreSQL 18 backup and restore clients.

- Require unfiltered HIGH/CRITICAL scans and non-root execution checks on both image architectures before publication, retaining reports on failure.

### Changed

- Keep context upgrades offline by bundling the reviewed SQLite driver and Linux x64/arm64 binaries inside the protected candidate package. Legacy bundle validation and rollback remain supported; the new payload fits existing size limits.

## [2.3.4] - 2026-11-10

### Fixed

- Repair the standalone agent shrinkwrap: a repository-only override had pinned a development dependency below its parent's requirement, causing `npm ci --omit=dev` to refuse the 2.3.3 package. Installers retained the previous agent on failure.
- Check the actual packed agent with isolated `npm ci --omit=dev --ignore-scripts` before publication and on both supported Node versions. Candidate contracts are served from loopback with their exact packed integrity, so the check also works before publication.


## [2.3.3] - 2026-11-10

### Changed

- Track Ardent 2.3.1 and its released DOCX codec, with the same management API.

- Refresh dashboard, queue and test dependencies and explicitly approve the updated
  native install scripts.

## [2.3.2] - 2026-11-09

### Fixed

- Preserve PTY marker traversal under a native service's restrictive umask, so restricted web terminals can resize without exposing their journals or granting directory writes.
- Show managed cron last-run status and execution history from the canonical occurrence ledger, including runs completed before an upgrade. Uncertain runs retain a pending result; only matching signed scheduler completions expose output and exit codes. Legacy cron history is preserved.

## [2.3.1] - 2026-11-09

### Fixed

- Native agent installations now pin the final built contracts package even when contracts change
  after a version bump. Package checks reject a stale contracts checksum before publication.

## [2.3.0] - 2026-11-09

### Added

- Fully enrolled nodes support web terminals through an optional, explicitly configured restricted
  account. The node agent supervises each PTY in its own systemd process group, supports resize,
  and stops descendants before signing completion. Input and output stay in memory.
- The fleet gateway negotiates the managed terminal protocol while preserving target lookup
  compatibility with older servers. Node-wide commands and managed cron keep their existing
  exclusive ownership and supervised completion requirements.

- Cron list responses include public revision, enabled state and expiry metadata for finite
  schedule management. Explicit managed schedules are refused on unenrolled legacy nodes.

### Security

- Terminal admission is single use and bound to the enrolled node, owner, operation, deadline and
  fence. A disconnect cannot release node ownership; only verified node cleanup can do so.
- Terminal processes have no privileges, a read-only host filesystem and home directories, private
  temporary storage, and no access to local scheduling or user-manager IPC. Process cleanup does
  not undo network side effects. Raw SSH terminal completion remains unproven on enrolled nodes.

### New environment variables

- `MAGNUS_AGENT_MANAGED_TERMINAL_USER`: dedicated non-root account for managed terminals.
  Optional; requires privileged mode, the execution supervisor and full node enrollment.

### Migration impact

- Two additive migrations add a nullable claim timestamp and an immutable-claim constraint and
  trigger to participant work. Existing history is retained. Enable the optional terminal account
  only after installing the updated agent and reviewing full node enrollment.


## [2.2.3] - 2026-11-09

### Fixed

- A reported DNS endpoint is selected only after a verified TLS handshake on the heartbeat's
  observed address. IP-only certificates retain their IP endpoint, and an endpoint selected by
  2.2.2 can recover without a database edit. The handshake sends no node credential.
- Ardent owner commands use that account's home and npm cache instead of inheriting the root
  management service's cache path, fixing package installation on fresh hosts.


## [2.2.2] - 2026-11-09

### Fixed

- Fresh node enrollment uses the agent's valid certificate FQDN without requiring an optional
  domain suffix. DNS must still match the authenticated heartbeat's network evidence before
  Magnus uses the name, so callbacks verify the certificate instead of failing against an IP.

- Codex updates on enrolled nodes use a reviewed managed completion boundary and a durable
  systemd-supervised updater. Missing process completion evidence retains ownership instead of
  allowing replay; both the server and node agent require the updated descriptor.
- Codex Agents Overview offers per-node CLI updates, reports failures, and refreshes the installed
  version and fleet counts after an update.
- Fleet Map gives tied gateway subnets separate positions instead of stacking their hosts at the
  center of the canvas.

## [2.2.1] - 2026-11-08

### Changed

- The agent and the generated Ardent client track `@hivemagnus/ardent` 2.3.0 (DOCX output from
  the `document_render` mission tool; no route or schema changes).

### Fixed

- Assign the durable renewal migration to the 2.2.1 release manifest, preserving the published
  2.2.0 migration inventory and allowing release validation to pass.
- Background HiveMem renewal persists its complete request and idempotency key before issuance,
  replays them across restarts and delivery failures, and fences concurrent workers. Retries run
  each minute within HiveMem's receipt window. Expired receipts and ambiguous legacy attempts
  require explicit recovery instead of automatic replacement. Apply the additive database migration
  with all old renewal workers stopped; see `docs/ARDENT.md`.
- The standalone Ardent installations page shows held command owners and provides the existing
  ADMIN-only reconciliation flow with a verified disposition, audit reason and confirmation.
- The compose e2e check reads the server logs before matching them, so `pipefail` no longer
  fails it when `grep -q` exits early.
- Update the workspace Undici resolution to 8.12.4 and synchronize the standalone agent's
  dependency declaration and shrinkwrap.

## [2.2.0] - 2026-11-08

### Added

- New Agent: `POST /api/v1/ardent/agents` creates, configures and starts an Ardent agent in one durable operation (profile, identity, model, HiveMem memory, skills, restart, readiness probe). `GET /api/v1/ardent/agents/operations/:id` returns per-step receipts, `…/stream` sends live step changes, and `…/resume` reruns a failed operation from its first unfinished step. Every step is audited. See [docs/ARDENT.md](docs/ARDENT.md).
- Enable HiveMem: `POST /api/v1/ardent/installations/:nodeId/profiles/:name/hivemem` enrolls (or rotates) a per-agent HiveMem credential for an existing profile through HiveMem's actor-credential API. The node agent writes it to the profile's private `.env` as `ARDENT_HIVEMEM_TOKEN` (new `hivemem-credential-set` action); Magnus never stores it.
- Linked Oathweave service identities: a client-credentials token linked with role `ARDENT_SERVICE` and holding `magnus:ardent` may use the Ardent bridge (profile reads, sessions, task submit and cancel, streams, artifacts, operations) and nothing else. It names the person it acts for in `x-acting-subject`; New Agent, resume and Enable HiveMem need that person to be a linked ADMIN. Shapes are published in `@hivemagnus/magnus-contracts/ardent-service`.

- Ardent sessions and live task streams through Magnus. The `session-open` action opens or resets a keyed Ardent session, and `task-submit` accepts an optional `session_id` and prompts up to 16,000 characters. `GET /api/v1/ardent/installations/:nodeId/profiles/:name/tasks/:taskId/stream` relays the task's server-sent events from the node unbuffered; the node agent ends a stream after 60 seconds without data, and clients resume with `after` or `Last-Event-ID`.
- Artifact downloads stream from the node instead of being buffered, up to the agent's `MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES` (64 MiB by default; it was a fixed 2 MiB).
- The node agent reports its Ardent bridge level as `studio` in its ping features and Ardent inventory: 1 for sessions, streams and streamed artifacts, 2 for the Ardent 2.2.0 features below. A request that needs a higher level than the agent reports answers 409 `AGENT_UPGRADE_REQUIRED`.
- Ardent 2.2.0 missions, pause and resume, previews and development history through Magnus (node agent `studio: 2`). New profile actions `mission-submit` (a team mission in at most 200 KB), `task-pause`, `task-resume`, `preview-submit` (unsaved soul, identity, skill or model overrides, at most 300 KB) and `development-note`; `session-open` takes a `context` (`direct`, `mission` or `preview`). New profile reads `tasks/:id/artifacts`, `artifacts/:sha256/manifest` and `development` (with `after`, `limit` and `kind`), and `sessions?context=`. Magnus validates these bodies before they reach a node, passes on Ardent's 400, 404 and 409 (a finished task cannot pause), and audits mission IDs and override names but never objectives, context or identity texts. The browser and `ardent-service` contracts publish the request and response shapes and the new `task.event` kinds.
- A linked Ardent service identity may also submit missions, pause and resume tasks, read artifact manifests and development history, and, naming a linked person in `x-acting-subject`, run previews and record development notes (otherwise 403 `ACTING_SUBJECT_REQUIRED`).
- A linked Ardent service identity may run `identity-save`, `skill-set` and `config-save` and read a profile's `config` when `x-acting-subject` names a linked ADMIN (otherwise 403 `ACTING_ADMIN_REQUIRED`). Its `config-save` may change only `execution.backend`, the model settings, `skills.enabled` and `artifacts.max_bytes` (`ARDENT_SERVICE_CONFIG_PATHS`); anything else answers 403 `CONFIG_PATH_FORBIDDEN`, and the audit records the changed paths with both subjects. Magnus now checks `identity-save`, `skill-set` and `config-save` bodies and targets for everyone, and passes on Ardent's stale-revision 409 as 409 `CONFLICT` and its 400 as 400 instead of 503.
- New Agent and Enable HiveMem authenticate to HiveMem as Magnus's own Oathweave service identity: a machine client with the audience `hivemem` whose short-lived `client_credentials` tokens Magnus fetches, caches and renews itself (`MAGNUS_ARDENT_HIVEMEM_CLIENT_ID`, `_CLIENT_SECRET`, `_TOKEN_URL`, optional `_SCOPE`). With it Magnus creates the agents' workspace when it is missing (default `ardent-agents`), and checks both before an operation starts, answering 503 `HIVEMEM_IDENTITY_UNAVAILABLE` or `HIVEMEM_WORKSPACE_UNAVAILABLE` before the node changes. A static `MAGNUS_ARDENT_HIVEMEM_ENROLLMENT_TOKEN` remains the alternative without Oathweave.
- `command-reconcile` Ardent action (ADMIN): settles an Ardent action whose outcome is unknown, after its deadline, from the node agent's own receipt, the signed ledger trace, or, only when the agent records the outcome as unknown, an ADMIN's decision (`effects_verified` or `no_effect_verified` with a reason) that the server signs with `COMMAND_RECONCILIATION_SECRET` and the node agent records under its execution lock. Every attempt is audited as `ardent.command-reconcile`. The installation views list the held `commandOwners` and whether reconciliation is configured. See [docs/ARDENT.md](docs/ARDENT.md#failed-actions-and-command-owners).
- `GET /api/v1/resource-leases/enrollment/:nodeId/ardent-scope/evidence` (ADMIN) returns what an Ardent-only activation signs (each verified drain receipt's SHA-256, the drain barrier and the scheduler snapshot) and why activation would be refused, so no one needs database access to activate the scope.
- HiveMem credential renewal for Ardent agents. Magnus records the credential New Agent or Enable HiveMem delivers (never the token), and a control API job renews it at half its lifetime with HiveMem's `renew` action (HiveMem with `actor_credential_renewal`), so agents no longer lose their memory after 30 days. The previous credential keeps working for a day. The node agent writes the new one to the profile's `.env` and asks Ardent to reload it (new `hivemem-credential-reload` action, Ardent's `POST /api/v1/memory/credential/reload`); with an Ardent or node agent without it, a running profile is restarted. Failures retry with backoff (15 minutes doubling to six hours), are audited as `ardent.hivemem.renew`, and raise an `ardent.hivemem.renewal_failed` notification, critical within three days of the deadline. Profiles enrolled earlier are adopted from their enrollment receipts. Every Ardent profile read now carries `hivemem` (`expiresAt`, `lastRenewedAt`, `nextRenewalAt`, `failures`, `lastError`, `state`). When the agent ID already exists, New Agent and Enable HiveMem now renew instead of rotating where HiveMem supports it, so an expired agent can be enrolled again. See [docs/ARDENT.md](docs/ARDENT.md#credential-renewal).
- `skill-install` Ardent action: installs a HiveSkills catalog release onto a profile (ADMIN, or a linked service acting for an ADMIN; node agent `studio: 3`). The server fetches the release from `MAGNUS_ARDENT_HIVESKILLS_URL`, requires it to be the one promoted on the channel and its archive to match the catalog SHA-256 and pass the HiveSkills archive checks plus Ardent's skill rules; the node agent checks it again and installs it as the Ardent owner with a `.hiveskills.json` receipt, never replacing a local skill of the same name (409 `SKILL_CONFLICT`). With `enable` and the configuration revision it also enables the skill through Ardent. Audited as `ardent.skill-install`. The contracts publish `ardentSkillInstallSchema`, `ardentSkillInstallResultSchema` and the shared archive checks (`checkArdentSkillArchive`). See [docs/ARDENT.md](docs/ARDENT.md#hiveskills-skill-install).
- New Agent sets Ardent's `artifacts.max_bytes` on Ardent 2.2.0 or later: `artifacts_max_bytes` (now 1 KiB to 64 MiB, Ardent's own bounds) or 64 MiB when it is omitted.

### Changed

- The agent and the generated Ardent client track `@hivemagnus/ardent` 2.2.1 (missions, pause and resume, previews, development history, HiveMem credential reload; 2.2.1 fixes context-only adoption onto older runtimes).
- The Ardent bridge (`/api/v1/ardent/*`) has separate rate limits for reads and actions. `GET` and `HEAD` (profile reads, polls, task and operation streams, artifacts) allow 600 requests a minute per person and 3,000 per linked service identity; every other method (actions, New Agent, resume, Enable HiveMem) keeps 60 per person and 1,200 per service. The two budgets are separate buckets, so reading console pages quickly no longer uses up the budget for changing an agent.
- A `429` from any rate-limited route now sends a `Retry-After` of the seconds until a request would be accepted again (refused requests still count), instead of always the whole window.
- Manage the latest Ardent release, 2.2.0. A new check (`npm run ardent:latest:check`, also run daily in CI) fails when Magnus pins an older Ardent than the latest published release, so every Ardent release gets a matching Magnus update.

### New environment variables

- Server, all optional: `MAGNUS_ARDENT_HIVEMEM_URL`, `MAGNUS_ARDENT_HIVEMEM_CLIENT_ID`, `MAGNUS_ARDENT_HIVEMEM_CLIENT_SECRET` (secret), `MAGNUS_ARDENT_HIVEMEM_TOKEN_URL`, `MAGNUS_ARDENT_HIVEMEM_SCOPE`, `MAGNUS_ARDENT_HIVEMEM_ENROLLMENT_TOKEN` (secret), `MAGNUS_ARDENT_HIVEMEM_WORKSPACE_ID`, `MAGNUS_ARDENT_HIVEMEM_AGENT_URL`, `MAGNUS_ARDENT_HIVEMEM_CREDENTIAL_HOURS`, `MAGNUS_ARDENT_EMBERPATH_URL`, `MAGNUS_ARDENT_HIVESKILLS_URL`.
- Agent, optional: `MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES`.

### Migration impact

- `20261108000000_ardent_agent_operations` adds an empty table for Ardent agent operations. It is fast and leaves existing rows unchanged.
- `20261108020000_command_lease_label` adds a nullable `label` column to `command_resource_leases`. It is fast and leaves existing rows unchanged.
- `20261108040000_ardent_hivemem_credentials` adds an empty table for the HiveMem credentials Magnus renews. It is fast and leaves existing rows unchanged.

### Removed

- The `profile-import-hermes` Ardent action. It called an Ardent CLI command that does not exist, so it could never succeed.

### Fixed

- The node agent's ping reports its Ardent bridge level from the same constant as its Ardent inventory, so it now answers `studio: 3`; it reported 2, and the server refused every `skill-install` with 409 `AGENT_UPGRADE_REQUIRED`. That refusal for a skill install now names skill installs instead of missions and previews.
- The node agent runs Ardent owner commands in the owner's home instead of its own root-only directory, so the package check after `package-install` no longer fails on suite installs.
- The node agent recognizes profiles that `ardent init` creates (product name `Ardent`) as running, so New Agent no longer fails at `service-start` on a standalone Ardent runtime.
- A failed Ardent action no longer blocks the node. The node agent answered every action failure with 503, which kept its command owner unknown, so each later Ardent action and New Agent resume was refused with no way out. A failure the agent finished now settles its owner with a signed receipt (agent 422, or 424 for Ardent's own server error); only an outcome nobody knows stays unknown. Magnus names the held command in its 409 (`ARDENT_OUTCOME_UNKNOWN`, `RESOURCE_LEASE_CONFLICT`), New Agent resume explains it (`COMMAND_OWNER_UNSETTLED`), and failed actions are now audited with their outcome.

## [2.1.3] - 2026-11-07

### Fixed

- Keep the agent upgrade dialog within the viewport, wrap blocking reasons and footer controls, and collapse completed rollout details so previous successes are clearly separate from current eligibility. Explain manual major-version upgrades in the dialog and update banner; show the actual selected count on the upgrade button.

### New environment variables

- None.

### Migration impact

- No new database migrations.

## [2.1.2] - 2026-11-07

### Security

- Upgrade the dashboard's bundled Next.js runtime to 16.4.5 and the HTTP adapter to `@hono/node-server` 2.1.6. Next.js remains a build dependency because the UI ships its traced standalone runtime; inspect that packaged runtime as well as the source lock.
- Include a standalone `npm-shrinkwrap.json` in the agent tarball, freezing all runtime dependency versions and integrities for privileged suite installation with lifecycle scripts disabled. This changes future artifacts; it does not replace already published packages or images.

### Changed

- Ardent (`@hivemagnus/ardent`) moved to its own repository, [ChefTaco/Ardent](https://github.com/ChefTaco/Ardent), and is no
  longer a workspace here or part of the Magnus release. Magnus pins the published
  `@hivemagnus/ardent@2.1.1` as a development dependency: the agent builds its context-adoption
  bundle from the package's compiled context adapter (byte-identical to the previous build), and
  `npm run ardent:openapi:check` / `ardent:openapi:write` check and regenerate the typed Ardent client
  in `@hivemagnus/magnus-contracts` from the package's OpenAPI document. Report Ardent issues and
  vulnerabilities in the Ardent repository. Agent-side Ardent management is unchanged.

### New environment variables

- None.

### Migration impact

- No new database migrations. The agent dependency lock affects new package installs.

## [2.1.1] - 2026-11-05

### Security

- The `magnus-server`, `magnus-fleet-gateway`, `magnus-ui` and `magnus-agent` images no longer contain npm, npx, corepack, yarn or apt. Nothing in them runs a package manager at runtime: dependencies are installed while the image is built, the server migrates with the Prisma CLI and engines it bundles, and a container agent never upgrades itself. This removes the fixable findings in npm's bundled `undici` 6.28.0 (CVE-2026-19534, CVE-2026-109383, CVE-2026-109869, CVE-2026-87018) and `brace-expansion` 5.0.9 (CVE-2026-102276, CVE-2026-102278), and in `apt` / `libapt-pkg6.0` 2.6.1 (CVE-2026-109518). `dpkg` and its database stay, so scanners still see the OS packages.
- The images build on `node:24.22.1-bookworm-slim`, pinned by digest, instead of the floating `node:24.22.1-slim` tag. Node.js is unchanged.
- Remaining HIGH and CRITICAL findings are in Debian 12 packages that have no fixed version yet: `zlib1g` (CVE-2023-45853, CVE-2026-76844), util-linux libraries (CVE-2026-53613, CVE-2026-53615, CVE-2026-78410), `ncurses` (CVE-2025-69720), `perl` (CVE-2026-9538), `libsystemd0` / `libudev1` (CVE-2026-16742), `gzip` (CVE-2026-41992), `libacl1` (CVE-2026-54369) and, in the server image only, `libldap-2.5-0` (CVE-2023-2953).

### Changed

- Running `npm` inside these containers is no longer possible. Upgrade by pulling a newer image, as before.

## [2.1.0] - 2026-11-05

### Added

- Add `services/fleet-gateway` (`@hivemagnus/magnus-fleet-gateway`, shipped as the container image `ghcr.io/cheftaco/magnus-fleet-gateway` and not on npm), a separate service holding the restricted SSH key that carries the browser web terminal over HTTP streaming. It requires an `ADMIN` identity link, `magnus:terminal` and identity verified within five minutes, strict host-key pinning with explicit operator approval, per-subject session ownership, re-checks revocation every five seconds, and audits metadata only. See `services/fleet-gateway/README.md`.
- Add `capabilities.terminal` to `GET /api/v1/console/session`, true when a fleet gateway is deployed and the caller holds an `ADMIN` link and `magnus:terminal`.
- Add the machine routes `POST /api/v1/fleet-gateway/target` and `POST /api/v1/fleet-gateway/audit`. New environment variables: `FLEET_GATEWAY_URL`, `FLEET_GATEWAY_TOKEN_SHA256`.
- Add the private workspace package `@hivemagnus/magnus-oathweave`, moving the Oathweave verifier and identity link parser out of the server so the gateway shares them. It is not on npm: `@hivemagnus/magnus-server` carries it in its tarball, and needs no new registry package.
- Authenticate a static browser console directly with Oathweave resource tokens (audience `magnus`): JWKS signature, issuer, audience, lifetime and actor checks, online revocation effective within 15 seconds, including on open event streams, and exact account links whose role caps the token's `magnus:*` permissions. Refuse startup when `IAM_CORE_URL` and `OATHWEAVE_ISSUER` are both set. New environment variables: `OATHWEAVE_ISSUER`, `OATHWEAVE_JWKS_URL`, `OATHWEAVE_USERINFO_URL`, `MAGNUS_OATHWEAVE_IDENTITIES_JSON`.
- Add `GET /api/v1/console/session`, reporting the mapped role and console capabilities. `MAGNUS_HERMES_ENABLED` on the server now supplies the `hermes` capability.
- Add `health` to each row of `GET /nodes`: the headline figures of the node's newest snapshot, or null when it has none, so a list needs no request per row.
- Add `MAGNUS_CONSOLE_BASE_PATH` for notification links to a console served under a path. The default is unchanged.
- Publish browser contracts for anomalies, remediation, notifications, retention, conversations, webhooks and topology, with a checked copy of the upgrade remedies. `GET /api/docs/openapi.json` is now a `browser` row in `docs/console-api.md`.
- Add the `@hivemagnus/magnus-contracts/browser` export, `npm run contracts:browser` to export it with SHA-256 provenance, and `docs/console-api.md`, the route inventory an ingress can use as its allowlist.
- Add a fixed endpoint-scoped HiveSkills execution bridge with explicit target grants, enrolled native signed receipts and no replay of admitted or unknown jobs.
- Add opt-in native Hermes messaging artifacts from the unchanged frozen public lock, with explicit provenance and exact dependency preflight; retain headless default and disabled runtime installs.
- Package reviewed public Hermes headless native artifacts with frozen
  dependencies, bundled Python, fixed SQLite, protected explicit profiles and
  external HTTPS generation/streaming acceptance.
- Add bounded native Codex acceptance using an isolated provider-only profile,
  explicit protected credential references and immutable runtime version checks.
  Refuse linked, ambiguous or conflicting native profile selections.
- Export pinned Codex native artifacts with explicit private profile selection,
  preserved credentials and verified external Responses streaming acceptance.
- Add protected Ardent native artifacts from locked production dependencies,
  private environment references and authenticated gateway acceptance. Verify
  exact version/profile and dependency readiness without invoking tools.
- Add authenticated native-agent acceptance with a recent explicitly accepted
  heartbeat, exact running version, verified TLS and private diagnostics.
- Export reviewed immutable agent images into native artifacts containing the
  exact Node runtime, preserved licenses, launchers and checksum metadata.
- Verify exact native Skills target mappings and immutable client digests through read-only authenticated posture APIs; reject infrastructure credentials in dedicated native client environments.

### Changed

- **Behavior change.** Resource enrollment now sends console drain challenges to the fleet gateway at `FLEET_GATEWAY_URL` rather than to the dashboard at `DASHBOARD_PUBLIC_ORIGIN`, and fails closed without it. `RESOURCE_ENROLLMENT_DASHBOARD_PARTICIPANT=absent` declares that no console participant exists, and is honoured only for a node with no console work rows in any state. The dashboard's internal drain route is removed.
- **Behavior change.** Assistant conversations belong to whoever started them. The list, each `/assistant/conversations/:id` route, chat continuation, the unread count and marking messages read answer only for the caller's own, for every role including `ADMIN`, and someone else's conversation answers 404. The server's heartbeat conversation stays readable by every role.
- **Behavior change.** The global error handler no longer sends Prisma text. A duplicate answers 409 `CONFLICT` naming the record and field, a missing record 404, an invalid value 400, and an unreachable database 503 `DATABASE_UNAVAILABLE`. Routes and dependency checks that pass an error's message through to a client no longer carry database text or a peer's address.
- **Behavior change.** Below `ADMIN`, role `envConfig` and cron `environment` now return key names only (`envConfigKeys`, `environmentKeys`), and a `PATCH` merges so a redacted response cannot wipe a value. Removing a key now takes an `ADMIN`.
- **Behavior change.** Secret fingerprints are `ADMIN` only: readiness fingerprints, `nodeManagerSecretFingerprint` in node metadata, and Hermes API-server key fingerprints. Other roles see `state` or a `Configured` boolean. Assistant tools and MCP no longer receive readiness fingerprints.
- Key rate limits on the verified Oathweave subject so browsers behind a shared ingress keep separate buckets. Other requests stay keyed on the socket peer.
- `GET /ops/storage-evidence/:nodeId` now reaches agents over the same scheme as other agent calls, instead of always HTTPS. A failure answers 502 `NODE_UNREACHABLE` or `NODE_BAD_RESPONSE` with the reason and what to check, and names no address.
- Name `WEBHOOK_ALLOWED_ORIGINS` when a webhook target is refused for not being allowlisted, and document the setting. The refusal itself is unchanged.
- Exclude sentinel records from `GET /topology` and the topology scan, fleet readiness, predictions, the at-risk forecast, profiling, Prometheus node counts and the assistant's fleet tools.
- Commit base-data initialization and its completion receipt atomically. The new
  read-only `verify-initialization` command holds activation after an interrupted
  seed, even when all SQL migrations finished, without replaying initialization.
- Keep native Hermes preflight read-only before profile initialization; validate
  runtime dependencies and SQLite without executing profile-dependent hooks.
- Permit non-root HiveSkills synchronization only for the explicitly configured owner profile; owner transitions continue to require privileged mode.
- Fence isolated restore candidates from queue workers, background writes, host
  contact and API mutations; verify exact completed migration checksums without
  applying or repairing schema changes.
- Retain existing Redis job keys while supporting colon-separated queue namespaces
  with the current queue library.

### Removed

- Remove the dashboard's unused `/api/terminal/ws`, `join`, `share` and `promote` routes and its WebSocket terminal.

### Fixed

- Stop `GET /health/:nodeId/forecast` failing with 500 on a flat disk, whose rounding residue overflowed the fill date. A burst of heartbeats no longer draws a growth trend, and a fill date more than 100 years out is not published.
- Preserve configured issuer trust for container health probes when the service
  uses a private CA; exercise the actual probe during isolated queue rehearsals.

### Security

- **Security.** The dashboard's `POST /api/terminal/open` now refuses a host outside the allowlist. It previously logged a warning and connected anyway.
- Send `Cache-Control: no-store` with the node token from `POST /api/v1/nodes/register`.
- Stop returning the node token from `PATCH /api/v1/cron/:cronId`.

### New environment variables

- Server: `FLEET_GATEWAY_URL`, `FLEET_GATEWAY_TOKEN_SHA256`, `RESOURCE_ENROLLMENT_DASHBOARD_PARTICIPANT`, `OATHWEAVE_ISSUER`, `OATHWEAVE_JWKS_URL`, `OATHWEAVE_USERINFO_URL`, `MAGNUS_OATHWEAVE_IDENTITIES_JSON`, `MAGNUS_CONSOLE_BASE_PATH`, `HIVE_REHEARSAL`, `MAGNUS_HIVESKILLS_DEPLOYMENTS_JSON`. The server now also reads `MAGNUS_HERMES_ENABLED` for the console's `hermes` capability.
- Node agent: `MAGNUS_AGENT_HIVESKILLS_TARGETS_JSON`, `MAGNUS_AGENT_SELF_URL`, `MAGNUS_AGENT_SELF_CA_PATH`.
- Fleet gateway: see `services/fleet-gateway/README.md` and `services/fleet-gateway/.env.example`.

### Migration impact

- `20261105010000_base_initialization` adds the `product_initializations` completion receipt table. It is fast and leaves existing application rows unchanged.

## [2.0.0] - 2026-11-03

### Changed

- Move security observations, cases, evidence, correlation, approvals and workers to standalone Cindertrace. Retired `SECURITY_FUSION_MODE=local` fails with migration instructions; authenticated legacy local API calls return 410 and browser links retain compatibility redirects.
- Preserve inventory, durable observation export, summaries and optional external approval forwarding. Fleet operation remains independent of Cindertrace outages. Historical security tables and applied migrations remain available for verified recovery.

### Added

- A dedicated authenticated response bridge binds an immutable approved plan to one durable execution identity. Host effects require managed admission and signed completion receipts; unknown effects never redispatch.
- Explicit node opt-in to a root-controlled restart/isolation/release helper. Independent service allowlists, protected target policy, fresh target checks and isolation recovery protections remain enforced.
- Accept the exact previous native-completion registry only for its original descriptors, so existing admitted work can settle without granting the new response operation historical authority.

### New environment variables

- Server: `CINDERTRACE_RESPONSE_SECRET`, `CINDERTRACE_RESTART_ALLOWLIST`, `CINDERTRACE_PROTECTED_TARGET_IDS`.
- Node agent: `MAGNUS_SECURITY_RESPONSE_ENABLED`, `MAGNUS_SECURITY_CONTAINMENT_COMMAND`.

### Migration impact

- `20261103000000_cindertrace_response_bridge` adds a durable claim and receipt table. It does not modify historical Security Fusion state. Before upgrading an existing local-mode installation, follow [the Cindertrace migration guide](docs/CINDERTRACE_MIGRATION.md).


## [1.1.13] - 2026-11-02

### Added

- Select exact batches of at most 16 records in the offline historical-mutation inspector, allowing larger inventories without expanding signed wire limits or weakening the real host-boot requirement.
- Reject missing, duplicate, completed, settled and active selections; regression coverage proves all original bytes and unknown outcomes remain intact across successive signed batches.

## [1.1.12] - 2026-11-03

### Added

- Include the full-enrollment native Ardent fence correction described below.
- Accept legacy SQLite file read permissions only inside owner-only state directories without changing source permissions; reject exposed directories, symlinks and group/world-writable databases.
- Exercise actual legacy SQLite permissions in both Node container adoption and rollback gates.

## [1.1.11] - 2026-11-03

Publication withheld to include legacy SQLite compatibility in 1.1.12.

### Added

- Use the native Ardent coordination fence for context actions admitted under full-node enrollment, while retaining node-wide lease ownership and enrollment checks.
- Add PostgreSQL-backed staging, adoption and rollback regressions covering reservation, authenticated claim, signed completion and refusal of unapproved narrow-scope authority.

## [1.1.10] - 2026-11-02

### Added

- Ship the managed context-only Ardent adoption and continuity acceptance described below.
- Include the context-adapter source workspace in the node-agent container build context, alongside its exact engine dependency.

## [1.1.9] - 2026-11-02

Publication withheld after the container-context gate failed; superseded by 1.1.10.

### Added

- Managed context-only Ardent adoption stages the pinned Emberfold integration while retaining existing runtime extensions, credentials and profile data.
- Revision-bound staging verifies isolated compaction, primary-model continuation, exact source recovery, rebuild and previous-reader compatibility; activation exercises real runtime rollback and preserves original journals and uncertain effects.
- Admin-only release and journal inspection, signed managed completion receipts, bounded owner subprocesses and fail-closed cancellation; no unmanaged installation fallback or automatic replay.
- Offline published-runtime adoption and rollback acceptance runs on both supported Node versions in CI and gates publication.

## [1.1.8] - 2026-11-02

A structural pass on agent upgrades, after one day of fleet waves stopped by the same pattern: pre-existing state on one
node, found only at dispatch, stopped everything, with the reason hidden. Version 1.1.6 was tagged but never published; its
fixes shipped in 1.1.7.

### Added

- **Upgrade waves stop only on evidence about the release.** An integrity or source failure stops at once. On the canary,
  a release failure stops the run and a node-level problem hands the role to the next node. After the canary, the run stops
  when reverts, failed installs and trials that never confirm reach `MAGNUS_AGENT_UPGRADE_MAX_FAILURES` (default 2;
  `maxFailures`, `--max-failures` or the console for one run). Agents before 1.1.8 can only answer a failed install as uncertain, so
  that many ambiguous canaries with nothing confirmed (at least two) stop the run, with the release reported as suspect but unproven;
  one such node hands off. The canary queue goes current agents, old agents with no lease history, then those that cannot report their
  fence, which do not count while another node may still confirm. A retry of such a run holds older agents back until `acknowledgeSuspicion`
  (`--acknowledge-suspicion`), so it strands no further lease. Identical refusals with nothing confirmed are surfaced the same way, without
  stopping, unless their code names a node-level cause. From 1.1.8 the agent names the cause of a failed install from npm's own code line, how
  the process ended, and the disk itself, so disk, access, network, certificate, auth and memory causes are node-level. Everything else is a
  node-level problem: recorded, and the wave goes on. The confirmation window counts from the reply, so a slow stage does not use it up. A node whose reply was lost is watched by request id and frees its batch slot once its window has passed, and late
  outcomes are recorded.
- **Run statuses and an attention list.** Runs end `succeeded` (every selected node confirmed or with an expected reason), `partial`
  (node-level problems, nothing against the release), `failed` (release evidence or suspicion), `stopped` or `interrupted`. Each node needing attention has a code, a cause and a specific remedy.
  A `partial` run offers Retry for just those nodes, including ones the check held back. `magnus-server agents upgrade` exits 2
  for `partial`.
- **Automatic end-of-wave retry** of transient node-level failures (unreachable, busy, a lock timeout, `RESOURCE_BUSY`, a
  repaired fence, a failed eligibility check): up to twice, with backoff, a new request each time, and only once the last request's
  lease settled. Nothing ambiguous or release-class is retried.
- **Preflight before the first node is touched.** `GET /api/v1/agent-upgrade/preflight` on the agent reports layout, launcher
  protocol, writable directories, free disk, npm, whether the running version is complete, ledger health, fence high-water,
  the enrollment marker and `engines` compatibility. It is read only and needs no lease. The server runs it for every selected
  node at run start, with the dry-run admission predicates, and excludes blocked nodes with their reason. Agents without the route
  show `preflight: unavailable`, which is not a failure. See the report with the dialog's **Check**, `dryRun` on
  `POST /api/v1/agents/upgrade`, `--dry-run`, or the new `magnus-server agents doctor [--nodes a,b] [--heal]`.
- **Fence self-healing.** When a preflight signed for a fresh nonce or a signed `STALE_FENCE` reply reports a high-water at or above the server's next generation,
  the server moves `commandResourceFence.generation` to high-water + 1 under the node's advisory lock, audited as
  `agent.fence.advanced`. It never lowers a generation, accepts only the node's own keys and decimal values under a cap, and above
  the cap reports `FENCE_OVERFLOW` and changes nothing. `magnus-server agents fence NODE VALUE` does the same by hand for agents
  older than 1.1.8, which do not say what they hold.
- **Upgrade readiness on every node.** Heartbeats gain optional fence high-water, ledger health, free disk and npm. Node responses
  carry `upgradeReadiness`: ok, or named problems such as an enrollment draining for a number of days, a marker the server does not
  share, a fence ahead, an unresolved ledger, low disk or missing npm. The node list and page show them, and a node not ready for
  24 hours raises a `node.upgrade_not_ready` notification.
- **A remedies catalogue** in `@hivemagnus/magnus-contracts/upgrade-remedies`, shared by the console, the CLI and the new
  [When an agent can't be upgraded](UPGRADING.md#when-an-agent-cant-be-upgraded) table, which a check keeps in step.
- **A legacy-state chaos test suite**: a mixed fleet in one wave with fake agents, each with a real-world bad state, a process-level
  test of the real ledger and route on a pre-seeded high fence, and a pre-seeded fence in the upgrade end-to-end test.
- `npm run check:reasons`, part of `verify`: a new bare `catch` that replies with an HTTP error in the upgrade, ledger, managed-http,
  enrollment and scheduler paths fails, unless it says why with `// no-reason-needed: why`.

### Fixed

- A certain refusal is no longer reported as uncertain. `managed-http` relabelled every refusal from the node ledger as
  `MANAGED_MUTATION_UNCERTAIN`, so a stale fence, an expired lease or a busy slot left a lease `unknown` that blocked every later
  managed command on the node, and stopped the wave. The agent now returns the real code (`STALE_FENCE` with the high-water,
  `LEASE_EXPIRED`, `RESOURCE_BUSY`, `UNMANAGED_MUTATION`, `IDEMPOTENCY_CONFLICT`, `LEDGER_UNAVAILABLE`) and logs the cause at WARN.
  Where the ledger proves the handler did not start and nothing local refers to the command, it adds `executed: false` and a
  signature bound to the request, the lease and the node, and the server settles the lease as `not-dispatched`. Anything that may
  have started stays uncertain.
- A known self-upgrade failure on an enrolled node is a settled result: it answered 500 or 504, which left a lock, an unresolved
  receipt and a held lease on every node a bad release reached. An unexpected handler failure stays uncertain.
- Leases stuck `unknown` with no receipt can recover. A minute past the lease deadline, the readiness monitor, a run or
  `agents doctor --heal` asks a 1.1.8 agent for a signed, nonce-bound account of its ledger. It settles the lease as `not-dispatched`, audited as
  `agent.lease.recovered`, only if a ledger shows it is this node's and the evidence fits; a missing ledger stays held with a code. A failed write
  after the fence is recorded durably so it can settle later.
  Signed reconciliation is unchanged for anything with a receipt. **A lease stranded by an agent older than 1.1.8 has no automatic way
  out:** upgrade that agent by hand, after which this recovery can settle it.
- A lost reply whose node then confirms no longer leaves its lease held: the server reads the signed receipt of that request.
- Fixed error replies in the cron, scheduler, enrollment and drain routes no longer drop their cause: it is logged at WARN.

### New environment variables

- `MAGNUS_AGENT_UPGRADE_MAX_FAILURES` (server, optional, default 2): failures pointing at the release that stop an agent upgrade run
  after its canary.

### Migration impact

- None. No migration, no registry change: the native completion registry and its digest are untouched, so no restart check is needed
  for that. A server on 1.1.8 works with agents from 1.1.2 up and a new agent with an older server, because every new field is optional
  and the new routes are GETs an older agent answers with 404.
- **For the first wave onto 1.1.8:** an agent older than 1.1.8 cannot report its fence. If such a node holds a high fence, its first
  managed request fails as `MANAGED_MUTATION_UNCERTAIN` and is recorded, and the wave goes on, but the lease stays held until that agent is
  upgraded by hand. A run warns about such nodes before the wave (`FENCE_UNREPORTED`): run `magnus-server agents fence NODE VALUE` first for
  those that are ahead. On such a fleet a bad release also reads as ambiguous canaries, not as a failed install, until agents run 1.1.8.

## [1.1.7] - 2026-11-02

### Fixed

- Stopped Hermes gateways no longer report as running. "inactive" matched the pattern for `active` and "not running"
  the one for `running`, so the console overcounted running gateways. One word-bounded parser now classifies
  `hermes gateway status` output for the agent, the update evidence and SSH detection: a systemd `Active:` line
  decides, journal lines and the "Recent gateway health" history (even with "Stopped" or "error") are ignored, and otherwise a negative state wins over a
  failure, and a failure over a running state. The dashboard status from SSH detection had the same bug. Nodes report
  correctly after their agent is upgraded, because the agent parses this output; SSH-detected installations do after the
  server is upgraded.
- Hermes counts no longer overstate installs and gateways. A profile that reports no gateway state of its own no longer
  inherits the default gateway's `running`. A Hermes home without a working binary is `degraded` with no version,
  so it stops counting as healthy. Mission Control and the orchestra overview no longer count rows for hosts without
  Hermes, and profiles remembered for such a host stop counting as running gateways.
- `magnus` health probes keep working with any certificate; see Security.

### Security

- The server no longer stores an unsalted digest of request bodies that hold a password. `users/provision` and
  `users/change-password` have no managed route on any agent, so nothing verifies that digest: its slot now holds a random
  value. The request an agent receives, and the refusal on enrolled nodes, are unchanged, so mixed-version fleets and stored
  receipts are unaffected. Digests stored by earlier versions for refused requests on enrolled nodes remain in
  `RemoteCommand.args`.
- The Ardent A2A surface now has rate limits: by client address before authentication, by peer after it (also for gRPC),
  and a cap on each peer's queued and running tasks, answered with `429` and `Retry-After`. `X-Forwarded-For` is ignored
  unless `a2a.rate_limit.trusted_proxies` names the connecting address. **Behind a reverse proxy, list the proxy there**, or
  all clients share one address limit. See `a2a.rate_limit` in the [Ardent README](https://github.com/ChefTaco/Ardent#a2a).
- `POST /a2a/push/:peerId` checks `X-A2A-Notification-Token` before parsing up to 2 MB of JSON.
- `magnus` health probes verify the certificate in the component's `TLS_CERT_PATH` instead of turning verification off.
  Verification stays off only for an address on this machine when no certificate is known or the known one does not verify,
  so a renewed or adopted certificate cannot fail a working upgrade.
- The console's browser cache of the active control node no longer holds credential fingerprints, and older copies are
  rewritten without them. Terminal session ids come from `randomUUID()`. Registry URLs encode the package name in full.

### New environment variables

- None. The new Ardent limits are optional keys under `a2a.rate_limit` in the profile's `config.yaml`.

### Migration impact

- None.

## [1.1.6] - 2026-11-02

### Fixed

- A native Hermes `cron/jobs.json` no longer adds a new remembered scheduler source every time Hermes runs a job.
  Its identity was a digest of the whole file, which Hermes rewrites on each run (`last_run_at`, `last_status`,
  `next_run_at`, claims), so the sticky discovery journal kept one `NATIVE_HERMES_SCHEDULES` and
  `NATIVE_HERMES_UNSETTLED_CLAIMS` copy per run and the reported counts multiplied. A jobs.json source is now
  identified by its path plus its job definitions, ignoring run state (`last_*`, `next_run_at`, `updated_at`,
  run counters such as `repeat.completed`, and the claim fields); its claims by its path plus the set of jobs
  holding a claim. Adding, editing or enabling a job still records a new source, and the counts come from the
  live file. Snapshots remembered by earlier versions stay until an operator clears them; see
  [Hermes schedule sources remembered before 1.1.6](packages/agent/MANAGED_SCHEDULER.md#hermes-schedule-sources-remembered-before-116).
- Scheduler discovery no longer counts unrelated software installed under a `.hermes` or `hermes` directory
  (for example a Node service, its `tsx` loader or `esbuild` under `~/.hermes/<app>/node_modules`) as an
  uninstrumented Hermes runtime. Only the file name of the executable or of the interpreter's script (`hermes`,
  `hermes-*` and `hermes_*` shims, `run_gateway.py`), a Hermes module (`-m hermes_cli.main`, `hermes_agent`...)
  or a `--hermes-home` option identifies one. Interpreter options that take a value (`--require`, `--import`,
  `-W`...) are no longer mistaken for the script.

### New environment variables

- None.

### Migration impact

- None.

## [1.1.5] - 2026-11-02

### Fixed

- The scheduler enrollment-drain proof no longer fails on hosts with frequently firing systemd timers. The
  timer source evidence included the last run's start time, stop time and PID that `systemctl show` appends
  to each command, so a timer firing between the proof's two inventory reads made them differ and the proof
  was refused. Only that trailing run status (and the timer list's sub-state column) is ignored; the command
  definition, unit files and drop-ins stay bound.
- Scheduler discovery no longer records a process as an uninstrumented Hermes runtime merely because an argument
  mentions Hermes (for example `grep hermes`, a report filter naming a Hermes kind, or a shell's inline code).
  A process counts when its executable, the script or module its interpreter runs, or a `--hermes-home` option
  is Hermes. Before, each such short-lived command seen during a proof added a remembered source, so the count
  grew with every check and the proof's two reads could differ.
- A refused agent or scheduler drain proof now says why. The 409 response carries a fixed `error.reason`
  (for example `inventory-changed` or `challenge-expired`), the agent logs the underlying cause as a warning,
  and the server keeps the reason in the enrollment status's `lastFailures` as `agentReason`.

### New environment variables

- None.

### Migration impact

- None.

## [1.1.4] - 2026-11-02

### Fixed

- `magnus-server restore` (and `magnus restore` for 1.1.3 and later servers) puts the original schema back when
  `pg_restore` cannot be started after the schema was moved aside. Before, a missing or unexecutable
  `pg_restore` at that point left `public` empty, with the data only in the `magnus_pre_restore_*` schema.
- A restore refuses to start while a `magnus_pre_restore_*` schema from an interrupted earlier restore exists,
  and says how to put it back, instead of moving the current schema aside on top of it.
- A restore that committed is no longer reported as failed when only dropping the previous copy fails; it warns
  with the command to drop it.

### New environment variables

- None.

### Migration impact

- None.

## [1.1.3] - 2026-11-02

### Changed

- Ardent: extract prompt fitting and durable checkpoint logic into the exact
  `@hivemagnus/emberfold` 0.1.0 dependency. Keep SQLite publication, policy fences,
  journals, and profile isolation local. Add portable checkpoint metadata without
  changing existing checkpoint rows; previous-reader rollback remains supported.

### Fixed

- Agent: managed cron jobs find the install directory's `.env` and `.magnus` ledger again under the
  versioned layout (`versions/<X>` reached through `./current` or the `node_modules` link).
- Agent launcher: a state or link write that fails (full or read-only disk) no longer crash-loops the
  service. The launcher logs it and starts the previous version, or `./current` without a trial.
- Agent self-upgrade: every npm step and the smoke test have a time limit that kills the whole
  process group, within a 13 minute total budget (`SELF_UPGRADE_TIMEOUT`). npm gets
  `--fetch-timeout` and `--fetch-retries`.
- Agent self-upgrade: `upgrade-state.json` and the `current` and `last-good` links are written
  durably (fsync, rename, fsync of the directory), and the agent and the launcher lock the state
  file around every change, so a late confirmation cannot race a revert. A confirmation after the
  trial deadline, or from a version `./current` no longer runs, is refused.
- Agent self-upgrade: a failed switch of `./current` records `failed`, not `staged`. The launcher
  records `failed` instead of starting a trial when `./current` does not point at the new version.
- Agent self-upgrade: upgrades start only when `versions/<from>` is complete. When it is missing at
  revert time, the launcher uses `./last-good` or records `failed`, instead of reporting a revert
  that did not happen.
- Agent self-upgrade: a healthy new version is no longer reverted because the control API was
  unreachable for a few minutes. On trial, heartbeats retry every 5 s, and the launcher extends the
  trial up to three windows while the agent reports that it runs. The revert reason says
  "control API unreachable" when that was the cause.
- Agent self-upgrade: npm, its lifecycle scripts and the smoke test no longer inherit the agent's
  credentials.
- Agent self-upgrade: the agent uses the npm that ships with its own Node.js before the one on
  `PATH`, and reports a missing or too old npm in the heartbeat instead of failing mid-upgrade.
- Agent self-upgrade: a release whose `engines.node` excludes the node's Node.js
  (`SELF_UPGRADE_ENGINE`) or that needs a newer launcher (`SELF_UPGRADE_LAUNCHER`) is refused before
  the switch.
- Agent self-upgrade: a repeated request with the same `requestId` returns 200 with the current
  state. Earlier leftovers in `staging/` and stale `*.tmp` files are removed, the npm cache is per
  upgrade, and the agent exits within 60 s after staging even if its shutdown hangs.
- Agent launcher: the trial deadline is clamped and measured with a monotonic clock, a revert by the
  trial watcher keeps the real attempt count, and the child always gets the launcher's own
  `AGENT_INSTALL_DIR`.
- `magnus-agent install-service --unprivileged` hands root-owned `staging/`, `upgrade-state.json` and
  `.magnus` to the service account. The heartbeat reports when the agent cannot write them.
- `magnus upgrade` records the upgrade in progress in `magnus-project.json`. An upgrade that was
  killed, lost its terminal or crashed is reported by the next command, which offers
  `magnus upgrade --resume` or `magnus rollback`. SIGINT, SIGHUP and SIGTERM stop the upgrade at the
  next safe step; a running migration always finishes first, and after the switch an interrupted
  upgrade switches back. A restart that fails counts as a failed health check.
- The new version's `magnus-server check` and a start-up test (`--version`, native modules) run
  before the backup and the migration. A check that crashes or prints no JSON fails the upgrade.
- After a failed upgrade that applied a one-way migration, the previous version is no longer
  started on a schema it cannot run on; the restore command is printed. `magnus rollback` asks the
  previous version which applied migrations it does not know and refuses one-way ones without
  `--restore-db` or `--force`. `--restore-db` fails when there is no dump, a failed restore starts
  the services again, and without a supervisor rollback waits until the server has stopped.
- Restores no longer leave tables of the newer release next to the restored ones: the dump is
  restored into a fresh `public` schema (same owner and grants) in one transaction, and the
  original schema is put back if `pg_restore` fails.
- Startup auto-migrate refuses a database with a migration that failed halfway before dumping it,
  reuses the dump of its last attempt when it restarts in a loop, keeps only the newest dumps, and
  gives up waiting for another instance's migrate lock after a timeout. The generated units stop
  after three failed starts in five minutes.
- `--supervisor none` projects no longer revert every upgrade: the server env file now names
  `MAGNUS_RUNTIME_FILE` and `MAGNUS_PROJECT_DIR`, and the health check also reads
  `MAGNUS_HOME/run`. It probes the port and bind address the server reports.
- An unreadable release manifest is no longer replaced by a guessed one: the engine says it is too
  old and how to run the newest one. A registry 404 is an error. Deprecated releases and releases
  newer than the `latest` tag are skipped unless named with `--to`.
- The Node.js the services run is recorded; engines checks, npm and the server CLI use it, and
  `magnus upgrade --node PATH` switches it and rewrites the units.
- Install scripts come from the target release's manifest (`allowScripts`), not from the engine
  that installs it.
- `pg_dump` gets the password through `PGPASSWORD` instead of the command line, and every dump is
  checked with `pg_restore --list`.
- Free disk space, the systemd user session bus and (in `--dry-run`) `pg_dump` and npm are checked
  before anything changes. User units are refused for another account (`sudo`), and systemd off
  Linux is refused before `init` writes anything.
- Upgrade locks record the boot and process start time, survive concurrent takeover, are handed to
  a newer engine without a gap, and `--break-lock` removes a leftover one.
- `magnus-project.json` and env files are written atomically and durably; env files keep their mode
  and owner and a `.bak` of the previous content.
- Server: agent upgrade runs no longer stop at a node that refused before anything changed (resource
  enrollment, admission fence, busy, unreachable, managed-mutation guard). Such nodes are recorded
  as `refused` with the agent's error code and message, and the run goes on; a refused canary hands
  the role to the next node. Reverts, release problems and agents that go silent still stop the run.
- Server: eligibility uses the same checks as dispatch (admission fence, enrollment state and host
  name, held work and leases, fresh heartbeat), names the blocker (for example "resource enrollment
  stuck in draining since <date>"), flags agents whose local managed-enrollment marker the server
  does not share, and is checked again right before each node.
- Server: a run whose server restarted or whose CLI was interrupted shows as `interrupted` instead
  of blocking new runs for seven days. Two runs can no longer start at once.
- Server: a node only counts as upgraded once its agent reports the request as confirmed. A lost
  reply no longer fails the node; the heartbeat report for the request decides. The wait follows the
  agent's own trial window.
- Server: `nodeIds: []` no longer upgrades the whole fleet; unknown node ids are rejected and
  selected nodes that are not eligible are listed with the reason.
- Server: an agent stays `UPDATING` no longer once it goes offline or stops reporting an upgrade, and
  gets back the status it had before.
- Server: self-upgrade heartbeat reports with an unknown future upgrade state or a long reason are
  kept instead of being dropped; reports that do not parse are logged.
- Server: scheduler drain receipts may be up to 256 KiB (was 16 KiB), enough for the schema maximum
  of 1024 external blockers on hosts with many system timers.
- Console: the upgrade dialog shows the server's error message instead of "Request failed with
  status code 409", refused and excluded nodes with their reasons, and the last run when reopened.

### Added

- Agent: operator-reviewed historical mutation records are read from a root-controlled JSON file
  (`MAGNUS_AGENT_REVIEWED_HISTORICAL_RECORDS`, default `/etc/magnus/reviewed-historical-records.json`).
  Before, the public agent shipped an empty set, so the enrollment drain proof of a node with signed
  historical quiescence settlements failed with 409. The file must be owned by root, not group- or
  world-writable, not a symlink, at most 1 MiB, and match the schema. Otherwise it is refused and the
  reason is logged. Entries for other nodes are ignored.
- Agent launcher protocol 2. `./last-good` points at the last confirmed version, and the launcher
  falls back to it after repeated crashes with an unreadable state file. A confirmed version installs
  its own launcher when that declares a higher protocol and passes a self-check
  (`launcher.mjs --protocol`).
- Heartbeat `selfUpgrade` gains `confirmSeconds` (the trial window) and `managedEnrollment` (the
  agent's local enrollment marker), so the server can detect an enrollment disagreement.
- `magnus restore <dump>` (stops the services, restores, starts them again) and
  `magnus-server restore <dump> --env-file <file>`.
- `magnus-server migrations --format json` reports `failed` and `unknown` (applied by a newer
  release) migrations, the database size and the PostgreSQL major version. The server warns at
  startup when the database is ahead of it.
- New projects get their own Compose project name for the bundled PostgreSQL and Redis; existing
  projects keep `magnus-deps`.
- The server image allows ten minutes for startup (dump and migrate) before its health check counts.
- Server: `POST /api/v1/agents/upgrade/runs/{id}/stop` and `/retry`, optional `canaryNodeId`,
  `allowPrerelease` and `allowRetryReverted`; `magnus-server agents stop`, `agents upgrade --retry`,
  `--canary`, `--allow-prerelease` and `--retry-reverted`. Console Stop and Retry buttons.
- Server: audit actions `agent.upgrade_run.started|finished|stopped|stop_requested` and
  `agent.upgrade.node_refused|node_failed|node_confirmed|node_reverted`.
- Server: enrollment inspection lists each participant's last refresh failure as a fixed reason code
  (and the participant's own error code, if it sent one).
- Contracts: the self-upgrade heartbeat report may carry `confirmSeconds` and `managedEnrollment`.

### New environment variables

- `MAGNUS_BACKUP_KEEP` (server, default 5): dumps kept in `MAGNUS_BACKUP_DIR`; the newest of each
  label always stays.
- `MAGNUS_AUTO_MIGRATE_LOCK_TIMEOUT` (server, default 600): seconds auto-migrate waits for another
  instance's migrate lock.
- `MAGNUS_MIGRATE_DATABASE_URL` (server, optional): a direct connection for migrations, dumps and
  restores when `DATABASE_URL` goes through a pooler such as PgBouncer.
- `MAGNUS_AGENT_REVIEWED_HISTORICAL_RECORDS` (agent): path of the reviewed historical mutation records
  file. Optional; default `/etc/magnus/reviewed-historical-records.json`.

### Migration impact

- None.

## [1.1.2] - 2026-11-02

### Changed

- Server: bullmq 6 and ioredis 6. Job data and Redis keys are unchanged, so a 1.1.1 and a 1.1.2 server
  can share one Redis during an upgrade or a rollback. ioredis 6 negotiates RESP3 but keeps the
  RESP2 reply shapes, and falls back to RESP2 by itself on Redis older than 6.
- Agent and console: undici 8. TLS verification (custom CA, host name checks) is unchanged. Requests
  now use HTTP/2 when the server offers it, for example through an HTTP/2 reverse proxy; the server's
  own listener stays HTTP/1.1.
- Ardent: better-sqlite3 13 with SQLite 3.53.4 (from 3.53.2). The database file format is unchanged,
  so rolling back to 1.1.1 opens the same files. Prebuilt binaries now ship in the package, so the
  install needs no download.
- Console: lucide-react 1.x (no visual change) and nanoid 6.
- Builds use TypeScript 6.0.3, and `@types/node` 24 to match the lowest supported Node.js runtime.

### Security

- minimatch 5.1.9 (GHSA-g3hv-75wg-m249) is gone from the dependency tree; the build-time OpenAPI
  generator now uses the patched minimatch 11 as well.

### New environment variables

- None.

### Migration impact

- None: 1.1.2 adds no database migrations.

## [1.1.1] - 2026-11-01

### Fixed

- Agent self-upgrade when the agent runs as root inside an install directory another account owns
  (for example one a deploy user installs releases into). The new `versions/<X>` tree, `./current`,
  the upgrade state and the npm cache now get that directory's owner, so the owner can still replace
  or remove them.
- Managed cron lines no longer name `versions/<X>`. Under the launcher they go through the install
  directory, so they survive later self-upgrades and pruning. `magnus-agent install-service` leaves
  `node_modules` as a link to `current/node_modules`, so lines written before the versioned layout
  keep their exact text.
- `hermes-sync` recognises that it runs as a service when it is started through a linked path.

### New environment variables

- None.

### Migration impact

- None: 1.1.1 adds no database migrations.

## [1.1.0] - 2026-11-01

### Added

- `@hivemagnus/magnus`, a new installer and upgrade tool. `npx @hivemagnus/magnus init` creates a
  managed single-node project (server and console, systemd units, generated secrets and TLS, and
  optionally PostgreSQL and Redis through docker compose). It pins exact, tested versions of every
  component. See [UPGRADING.md](UPGRADING.md).
- `magnus upgrade [--to X.Y.Z] [--dry-run]` (or `magnus-server upgrade`) checks the registry and the
  Node.js engines and dumps PostgreSQL before migrating. It installs the new release beside the running
  one, migrates, checks, switches `./current` and restarts. If the new version does not become healthy
  it switches back automatically and prints the exact database restore command. It never crosses a
  major version without `--allow-major`. `magnus rollback [--restore-db]` and `magnus status` complete
  it, and `magnus adopt` turns an existing npm install into a managed project.
- Startup auto-migrate (`MAGNUS_AUTO_MIGRATE=true`): pending migrations are applied before the server
  listens, under a PostgreSQL advisory lock and after a `pg_dump`. Slow or one-way migrations stop
  startup unless they are explicitly allowed.
- Update notices: a daily, opt-out registry check shows newer releases with their notes, new required
  settings and slow or one-way migrations in the console and in `magnus-server check`. Agents that run
  a different version than the server log a loud warning with the exact fix command.
- Server-driven agent upgrades: the **Upgrade agents** action on the Nodes page and
  `magnus-server agents upgrade`. One canary goes first, then a few agents at a time. Each agent
  installs the exact version and npm integrity into `versions/<X>` beside the running one and switches
  back by itself if the new version does not report an accepted heartbeat within
  `MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS`. Agents that cannot upgrade themselves are greyed out with
  the reason. Run `sudo magnus-agent install-service` once per node to enable it; the agent never uses
  sudo for upgrades.
- New server commands `magnus-server migrations` and `magnus-server backup`, and
  `magnus-server check --format json`.
- Per-release manifests (`magnusRelease`) with migration impact notes
  (`prisma/migrations/<name>/magnus-impact.json`), checked by `npm run release:manifest:check`.

### Changed

- The git-checkout self-update endpoints (`/api/v1/self-update/check`, `/apply` and `/restart`) are
  off by default and answer 410 with the upgrade command. Set `MAGNUS_LEGACY_GIT_SELF_UPDATE=true` to
  keep using them from a source checkout.
- The heartbeat's `updateAvailable` compares versions by semver, and agents now report their Node.js
  version and self-upgrade status.
- The native completion registry adds the agent self-upgrade mutation, so its digest changes. A
  managed mutation admitted by a 1.0.x server and settled by 1.1.0 is refused with
  `RESOURCE_EVIDENCE_INVALID`, so upgrade the server while no managed mutation is running.
- The console shows its own release version in the sidebar.

### New environment variables

All are optional, and each automatic behaviour has its own switch.

- Server: `MAGNUS_AUTO_MIGRATE`, `MAGNUS_AUTO_MIGRATE_BACKUP`, `MAGNUS_AUTO_MIGRATE_ALLOW_SLOW`,
  `MAGNUS_BACKUP_DIR`, `MAGNUS_PG_DUMP`, `MAGNUS_RUNTIME_FILE`, `MAGNUS_UPDATE_CHECK`,
  `MAGNUS_UPDATE_REGISTRY`, `MAGNUS_AGENT_UPGRADES`, `MAGNUS_AGENT_UPGRADE_CONCURRENCY`,
  `MAGNUS_LEGACY_GIT_SELF_UPDATE`, `MAGNUS_PROJECT_DIR`.
- Agent: `MAGNUS_AGENT_SELF_UPGRADE`, `MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS`,
  `MAGNUS_AGENT_UPGRADE_REQUIRE_PROVENANCE`, `MAGNUS_AGENT_UPGRADE_SOURCE_DIR`, `MAGNUS_AGENT_NPM`.

### Migration impact

- None: 1.1.0 adds no database migrations.

## [1.0.3] - 2026-10-31

### Added

- Configuration switches for interoperating with older components. Every default keeps the
  current behaviour.
  - `MAGNUS_AGENT_ARDENT_PACKAGES` (agent, default `@hivemagnus/ardent`): scoped npm names
    accepted as the Ardent runtime for the staged sidecar, install path, receipt and managed
    unit. Ardent state now also reports the installed `packageName`.
  - `MAGNUS_APPROVAL_ASSERTION_DOMAINS` (server, default `magnus.approval-assertion`): signature
    domain prefixes accepted for signed approval decisions, so older signers keep working.
  - `MAGNUS_ROUTE_ALIASES_JSON` (server, unset): legacy `/api/v1` path prefixes rewritten to
    current routes before routing, for example the renamed resource-lease admission and
    transfer authority snapshot routes.
  - `MAGNUS_WEBHOOK_TYPE_ALIASES` (server, unset): legacy webhook type names mapped to a
    current delivery format.

## [1.0.2] - 2026-10-31

### Changed

- Update runtime dependencies, including ky 2, dotenv 18, Prisma 7.10, argon2 0.45, Hono
  4.13.14, Express 5.3, the A2A SDK 1.3 and Next.js 16.4.3. When installing a server
  package with npm 12, allow the install scripts of `argon2@0.45.1`, `prisma@7.10.1` and
  `@prisma/engines@7.10.1`.
- Update the console's UI libraries (tailwind-merge 3, motion 14, React 19.3, Recharts 3.10).
- Port the console and server HTTP clients to ky 2. Ky 2 reads error bodies before it throws,
  so the console takes API error messages from the error itself and keeps showing them.

## [1.0.1] - 2026-10-31

### Security

- Enforce dashboard proxy body limits while streaming, including requests with
  missing or understated `Content-Length` headers.
- Require explicit SSH host-key pins for Control API SSH helpers. Remove the
  unused deployment and migration implementations behind the retired API,
  including their unsafe shell interpolation and broad source-bundle transfer.
- Update vulnerable production and development dependencies; retain the
  compatible OpenAPI generator dependency with its documented development-only
  advisory pending an upstream fix.
- Scan staged Git content and npm payload contents for credentials and private
  infrastructure. Redact scanner findings, reject local-state files, and clean
  compiled outputs before building packages so deleted code cannot be shipped.
- Run the full repository verification before npm publication.
- Refuse real npm publication when the GitHub environment has no required
  reviewer, and pin workflow actions to immutable release commits.
- Require a matching release tag for real publication, including manual runs.
  Stop on registry errors before publishing any packages, validate internal
  dependency versions, and inspect every package during dry runs.

### Fixed

- Align the server's bundled agent version metadata with the package release.
- Support first publication with an explicitly selected, reviewed bootstrap
  run. Its temporary npm credential is available only to the final publish
  step; subsequent releases use trusted publishing.

## [1.0.0] - 2026-10-31

The initial release snapshot.

### Added

- **Magnus UI** (`@hivemagnus/magnus-ui`): the web console for fleets and nodes, commands, cron
  jobs, files, logs, skills, roles, rollouts, anomalies and remediation, incidents, retention,
  webhooks, notifications and audit, plus Ardent and Codex CLI views. It ships as a prebuilt
  Next.js standalone server with the `magnus-ui` CLI (`start`, `check`, `env-schema`,
  `--env-file`) and an example systemd unit. Browser code uses same-origin routes only; API, node
  and SSH credentials stay on the server. Sign-in uses a local Argon2id administrator with
  Redis-backed throttling, and optionally named Hive IAM (OIDC) users. Node terminals use pinned
  SSH host keys.
- **Magnus server** (`@hivemagnus/magnus-server`): the Hono API server on PostgreSQL and Redis. It
  keeps the inventory and desired state, ingests heartbeats, health snapshots and logs, and
  dispatches signed commands, cron jobs, file syncs and skill installs through a durable queue. It
  records every change in an append-only audit log, and adds anomaly detection, remediation plans,
  rollouts, webhooks, an AI fleet assistant, read-only operations summaries, application probes,
  Hermes Agent and Ardent management, the Hermes registry, resource leases and Security Fusion. The
  `magnus-server` CLI has `start`, `check`, `migrate` and `env-schema`, and the package includes
  the Prisma schema and every migration. A Dockerfile and a Docker Compose example with
  PostgreSQL 17 and Redis 7 are in `services/control-api`. The OpenAPI 3.1 document is served at
  `/api/docs`, and Prometheus metrics at `/metrics`.
- **Magnus agent** (`@hivemagnus/magnus-agent`): the node agent for Linux hosts. It handles
  heartbeats with CPU, memory, disk, network, service, GPU and security posture, and runs
  commands with durable signed receipts. It also handles cron and managed schedules, file access
  with symlink-resolved path checks, skill publication, and drift and profiling routes. It can
  manage Hermes Agent, the Codex CLI and Ardent when they are installed. It offers optional
  OpenTelemetry export, journald forwarding, HiveMem credential renewal and authenticated UDP
  discovery. The `magnus-agent` CLI has `start`, `check` and `env-schema`, and the package
  includes example systemd units for privileged and unprivileged mode and for Hermes registry
  sync.
- **Ardent** (`@hivemagnus/ardent`): a headless TypeScript agent runtime. One process serves one
  profile with a YAML config, persona, skills and private SQLite state, and runs model turns
  against an OpenAI-compatible server or the Codex App Server. It provides durable tasks with an
  event journal, a bearer-protected management API with a pinned OpenAPI document, A2A 1.0 over
  JSON-RPC, HTTP+JSON and gRPC, and scheduled jobs with exactly-once window receipts. It also
  provides context compaction and plugins. Optional integrations are news research, HiveMem
  memory, Telegram and Mattermost channels, read-only Magnus tools and Hermes Agent team-card
  compatibility. The `ardent` CLI includes `init`, `doctor`, `chat`, `run`, `gateway run`, `config`,
  `jobs` and `a2a`.
- **Magnus contracts** (`@hivemagnus/magnus-contracts`): Zod schemas and types shared by the
  server, the console and the agent, and a typed Ardent HTTP client.
- **Magnus skills** (`@hivemagnus/magnus-skills`): a catalogue of Ubuntu operations skills in the
  Hermes Agent skill format, with `listManifests()` and `getSkillsDir()`.
- Node.js 24 (`>=24.22.1`) and Node.js 26 (`>=26.13.0`) are supported.

### Notes

- Every integration is off until it is configured: Hive IAM, Hive Router, HiveMem, an external
  security console, Hermes Agent, Codex and the Ardent chat channels.
- Security Fusion is off by default (`SECURITY_FUSION_MODE=off`). In `remote` mode the export of
  observations to an external security console stays off until `SECURITY_EXPORT_ENABLED=true`.
- The console's Hermes Agent pages, the Hermes dashboard proxy and its WebSocket bridge need
  `MAGNUS_HERMES_ENABLED=true`.
- The agent runs in privileged mode by default (`MAGNUS_AGENT_PRIVILEGED=true`) and then must run
  as root. Set it to `false` to run as an ordinary account; features that need root then answer
  `403 AGENT_NOT_PRIVILEGED`.
- npm 12 blocks dependency install scripts by default. These dependencies have install scripts:
  - `@hivemagnus/magnus-server`: `argon2`, `prisma` and `@prisma/engines` (which downloads the
    schema engine that `magnus-server migrate` uses), plus the optional native accelerators
    `ssh2`, `cpu-features` and `msgpackr-extract`;
  - `@hivemagnus/magnus-ui`: `argon2`, plus the optional `ssh2` and `cpu-features`;
  - `@hivemagnus/ardent`: `better-sqlite3`;
  - `@hivemagnus/magnus-agent`, `@hivemagnus/magnus-contracts` and `@hivemagnus/magnus-skills`:
    none.

  Pass them to `npm install -g` with `--allow-scripts=...`, or list them under `allowScripts` in
  your project's `package.json`.

[1.1.8]: https://github.com/ChefTaco/magnus/releases/tag/v1.1.8
[1.1.7]: https://github.com/ChefTaco/magnus/releases/tag/v1.1.7
[1.1.6]: https://github.com/ChefTaco/magnus/releases/tag/v1.1.6
[1.1.5]: https://github.com/ChefTaco/magnus/releases/tag/v1.1.5
[1.1.4]: https://github.com/ChefTaco/magnus/releases/tag/v1.1.4
[1.1.3]: https://github.com/ChefTaco/magnus/releases/tag/v1.1.3
[1.1.2]: https://github.com/ChefTaco/magnus/releases/tag/v1.1.2
[1.1.1]: https://github.com/ChefTaco/magnus/releases/tag/v1.1.1
[1.1.0]: https://github.com/ChefTaco/magnus/releases/tag/v1.1.0
[1.0.3]: https://github.com/ChefTaco/magnus/releases/tag/v1.0.3
[1.0.2]: https://github.com/ChefTaco/magnus/releases/tag/v1.0.2
[1.0.1]: https://github.com/ChefTaco/magnus/releases/tag/v1.0.1
[1.0.0]: https://github.com/ChefTaco/magnus/releases/tag/v1.0.0

[2.0.0]: https://github.com/ChefTaco/magnus/releases/tag/v2.0.0

