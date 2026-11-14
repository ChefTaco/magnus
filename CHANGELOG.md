# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/).


## [Unreleased]

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

