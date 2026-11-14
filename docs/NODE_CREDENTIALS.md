# Per-node credentials

Every agent used to authenticate with one fleet-wide value, `NODE_MANAGER_SECRET`, sent in the
`x-node-token` header in both directions. Whoever held it could report as any node and could call
the management API of every agent.

Since 2.10.0 each node has its own Ed25519 key, and the server has one too. Requests are signed,
and a signature names exactly one node. **From 3.0.0 the server and the agent run in `enforce` mode
by default**: the shared secret is refused and no longer sent, in both directions, evidence and
decisions must be signed with the node key or the server key, and the automatic legacy upgrade is
closed. A server whose mode is unset refuses to start while that would lock out part of its fleet
(see [Upgrading to 3.0.0](#upgrading-to-300)). `compat` and `warn` still work when set explicitly,
for this major only (see [Phases](#phases)).

## The model

| | Key | Kept in | Proves |
|---|---|---|---|
| Node | Ed25519, created by the agent | `$AGENT_INSTALL_DIR/identity/node.key`, mode 0600 | "This request comes from node X" |
| Server | Ed25519, created at the first start | `$MAGNUS_HOME/state/node-auth/server-signing-key.json`, mode 0600 (`NODE_AUTH_SERVER_KEY_PATH`) | "This request comes from the control plane, for node X" |

The server stores only public keys, in the `node_credentials` table. A node's private key never
leaves its host: it is not sent, logged or passed to child processes, and the agent's file and
drift routes refuse the `identity` directory.

A signed request carries five headers: `x-magnus-node-id`, `x-magnus-key-id`,
`x-magnus-timestamp`, `x-magnus-nonce` and `x-magnus-signature`. The signature covers the method,
the path and query, an audience, the node id, the timestamp, the nonce and the SHA-256 of the body.

- **Agent to server.** Signed with the node key. The audience is the server key the agent pinned,
  so a request made for one control plane is not valid on another.
- **Server to agent.** Signed with the server key. The audience is the node id, so a request
  captured on its way to one node is refused by every other node.
- **Replay.** A timestamp more than 60 seconds from the receiver's clock is refused, and each nonce
  is accepted once. The replay cache lives in the server process: run one Control API instance.
- **Clocks.** The server sends its time on every node route (`x-magnus-server-time`), refusals
  included, and an agent with a wrong clock corrects its timestamps from it. No node goes offline
  because its clock drifted.

With a signature, the key decides which node is speaking. Fields in a request body that name a node
(`fqdn`, `nodeFqdn`, `nodeId`) are claims: they must name the key's node, or the request is refused
with `403 NODE_IDENTITY_MISMATCH`, audited, and reported as a notification. A heartbeat can no
longer rename or re-address another node.

## Upgrading to 3.0.0

3.0.0 is a major release: it changes the default of `NODE_AUTH_MODE` from `compat` to `enforce` on
the server and on the agent. Upgrade in this order:

1. **Run the server on 2.10.2** (3.0.0 upgrades only from 2.10.2), with every agent on 2.10.2 or later.
2. **Set `NODE_AUTH_MODE=warn` on the 2.10.2 server** and restart it. Wait a day of normal use.
3. **Confirm `GET /api/v1/node-credentials/summary` has no blockers** (`enforceReady: true`). The
   start-up guard of 3.0.0 checks `NODES_WITHOUT_KEY`, `NODES_REVOKED`, `NODES_NOT_SIGNING_EVIDENCE`
   and `AGENTS_NEED_UPGRADE` (agents 2.10.0 and 2.10.1, which enforce cannot reach); `RECENT_SHARED_SECRET_USE`
   and `PENDING_BINDINGS` are worth clearing too, and the readiness probe reports them in `warn`.
4. **Remove `NODE_AUTH_MODE` from the server's environment** (or set `enforce`) and upgrade the server
   to 3.0.0 (`magnus upgrade --allow-major`). It applies no migration.
5. **Upgrade the agents to 3.0.0**, from the Nodes page or with `magnus-server agents upgrade`. A
   3.0.0 agent enforces by default too: it accepts only the server's signature on its API and sends
   only its own.

**The start-up guard.** With `NODE_AUTH_MODE` unset, a 3.0.0 server reads its inventory before it
listens. Real nodes only count: decommissioned nodes and the internal `__control-api__` and
`__dashboard__` log sources never do. While any real node has no active key, only revoked keys, an
agent that does not sign its evidence, or a 2.10.0/2.10.1 agent, it exits with code 1 and a message
like:

```text
[startup] Refusing to start: NODE_AUTH_MODE is not set, so this server would run in enforce mode (the default since 3.0.0), which accepts
node signatures and node-signed evidence only. Enforce mode would lock out:
  - 1 node(s) without a node key (still on the shared node secret): web-1 (Hk2...)
Either:
  1. enroll or upgrade them first: run the previous release again (`magnus upgrade` switches back by itself when a start fails),
     upgrade those agents to 2.10.2 or later and let each bind its key (or `magnus-agent enroll --token` with a token from
     POST /api/v1/nodes/<nodeId>/enrollment-token), and start this release once GET /api/v1/node-credentials/summary reports no blockers; or
  2. set NODE_AUTH_MODE=compat (or warn) explicitly in this server's environment: the shared node secret keeps working for this
     major (deprecated, removed in the next), and you switch to enforce once the summary is clean.
See docs/NODE_CREDENTIALS.md, "Upgrading to 3.0.0".
```

`magnus upgrade` sees the failed start and switches back to 2.10.2 by itself. An explicit mode is
the operator's decision and is never checked: `enforce` starts as it is, and `compat` or `warn`
start with a `DEPRECATED` warning in the log and `modeDeprecated: true` in the summary.

**Rollback.** Set `NODE_AUTH_MODE=compat` on the 3.0.0 server and restart it: the shared secret is
accepted (and sent to agents whose pins are not current) again, the legacy upgrade reopens while
its window lasts, and nothing else changes. To go back to 2.10.2, run `magnus rollback`: 2.10.2
reads the same database (3.0.0 adds no migration) and the same server key file. 3.0.0 agents work
with a 2.10.2 server (they sign, it verifies). An agent that should accept the shared secret again
needs `NODE_AUTH_MODE=compat` in its `.env`.

**New installations.** `magnus init` of 3.0.0 no longer generates `NODE_MANAGER_SECRET` or
`RESULT_SIGNING_SECRET` for the server, and a new agent needs neither: register the node, issue an
enrollment token and run `magnus-agent enroll --token-file -` on the host ([New nodes](#new-nodes)).

### Versions that work together

| Server | Agent | Works | How |
|---|---|---|---|
| 3.0.0 (enforce) | 3.0.0 | yes | Signatures only, both ways |
| 3.0.0 (enforce) | 2.10.2 with a key | yes | The agent signs and also sends the shared secret; the server goes by the signature and ignores the secret. The server signs only; the agent pins its key. Evidence carries the node signature next to the HMAC |
| 3.0.0 (enforce) | 2.10.0 or 2.10.1 with a key | no (guard) | Its managed HTTP route refuses every signed request; upgrade it first (`AGENTS_NEED_UPGRADE`) |
| 3.0.0 (enforce) | 2.9.x or a node without a key | no (guard) | It has only the shared secret (`NODES_WITHOUT_KEY`) |
| 3.0.0 (explicit compat) | any of the above | yes | As 2.10.2 does |
| 2.10.2 (compat) | 3.0.0 | yes | The agent signs only; 2.10.2 verifies the signature and signs its own requests and decisions, which the agent accepts. A 3.0.0 agent upgraded from 2.10.x keeps its shared keys in `.env`, so its HMACs still verify too |

## What happens to existing nodes

This is how 2.10.x moved nodes to their own keys. In 3.0.0 it happens only under an explicit
`compat` or `warn` mode; `enforce` closes the automatic upgrade.

1. **Upgrade the server.** It applies one additive database migration, creates its signing key and
   starts a 30-day window for the automatic upgrade. The start-up log shows the mode, the server
   key fingerprint and the end of the window. Agents of any older version keep working on the
   shared secret, unchanged.
2. **Upgrade the agents**, at any time, in any order, from the Nodes page or with
   `magnus-server agents upgrade` as usual.
3. **Each upgraded agent binds its key.** After its first accepted heartbeat (and after a
   self-upgrade is confirmed, so a version the launcher may still revert never binds), the agent
   creates its key and calls `POST /api/v1/node-enrollment/legacy-upgrade` with the shared secret
   and a proof that it holds the private key. The server binds the key only if all of this holds:
   - the node is in the inventory, and exactly one node matches;
   - the node has no credential yet (the first key wins);
   - the request comes from the address recorded for the node (a recorded host name is resolved);
   - the window is open.
4. **The node is now closed to the shared secret** (the per-node ratchet). A request that presents
   `x-node-token` and names this node, by id, host name, name or the name it was bound under, is
   refused with `401 NODE_CREDENTIAL_REQUIRED`. Other nodes are unaffected.
5. **The server stops sending the shared secret to that node** once the agent has reported, in a
   signed heartbeat, that it pins the server's key. Until then server requests carry both.

Each binding writes an audit event (`node.credential.bind`) and a notification with the key
fingerprint. The Nodes API shows the state per node as `nodeCredential.state`: `none`, `active` or
`revoked`.

A new agent talking to a server older than this release changes nothing: it creates no key and
keeps using the shared secret until the server is upgraded.

### When a node does not bind

The agent keeps running on the shared secret and retries with a backoff. Its log and the server's
notifications say why:

| Reply | Meaning | What to do |
|---|---|---|
| `404 NODE_NOT_FOUND` | No inventory node matches yet | Nothing: the first heartbeat adds it |
| `409 NODE_AMBIGUOUS` | Two inventory nodes match this agent | Remove the duplicate node |
| `403 PEER_ADDRESS_MISMATCH` | The agent reaches the server from an address other than the one recorded | [Approve the pending binding](#approving-a-binding-refused-for-its-address), repair the node's address, or enroll it with a token |
| `409 NODE_CREDENTIAL_EXISTS` | Another key is already bound to this node | See [A second agent](#a-second-agent-tried-to-bind-a-node) |
| `410 LEGACY_UPGRADE_CLOSED` | The window has ended, or the mode is `enforce` | Enroll it with a token, or extend `NODE_AUTH_LEGACY_UPGRADE_UNTIL` |

If agents reach the server through a reverse proxy, the server sees the proxy's address for all of
them and refuses every automatic binding. The agents stay on the shared secret; enroll them with
tokens.

### The trust in this step

The automatic upgrade is trust on first use. During the window, whoever holds the shared secret
*and* sends from a node's recorded address can bind that node's first key. That is narrower than
before (the secret alone could impersonate any node at any time), but it is not proof of identity.

To check a binding, compare fingerprints:

```bash
# on the node
magnus-agent identity show

# on the server (ADMIN; the UI lists the same keys)
curl -H "Authorization: Bearer $TOKEN" https://magnus.example.com:4000/api/v1/nodes/<nodeId>/credentials
```

The binding notification carries the same fingerprint. If they differ, revoke the key and enroll
the node with a token.

### Approving a binding refused for its address

A binding refused with `403 PEER_ADDRESS_MISMATCH` is kept as a *pending binding* (with the key
fingerprint, the address the agent called from and the recorded address), audited as
`node.credential.binding_pending`, and named in the notification. If the host is genuine (it
reaches the server through NAT, or its address changed), compare the fingerprint with
`magnus-agent identity show` on the host and approve it:

```bash
# ADMIN: list, then approve or reject
curl -H "Authorization: Bearer $TOKEN" https://magnus.example.com:4000/api/v1/node-credentials/pending-bindings?status=PENDING
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}' \
  https://magnus.example.com:4000/api/v1/node-credentials/pending-bindings/<id>/approve
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"reason":"not this host"}' \
  https://magnus.example.com:4000/api/v1/node-credentials/pending-bindings/<id>/reject
```

Approval binds that key as the node's first credential (audited as `node.credential.binding_approve`
and `node.credential.bind`). The agent learns it on its next attempt, also after the upgrade window
closed. Approval is refused when the node has a key by now, when the agent has not asked for seven
days, or in `enforce` mode; enroll the node with a token instead.

### A second agent tried to bind a node

The server refuses it with 409 and raises a critical notification naming the second key's
fingerprint and address. One of the two is not the genuine node:

- If the **bound** key is the genuine one, nothing is broken. Find out who sent the second request.
- If the **refused** agent is the genuine one (its log says `Node key NOT bound`), revoke the bound
  key and enroll the node with a token.

## New nodes

From 3.0.0 this is the only way a node gets a key in enforce mode.

Register the node with `POST /api/v1/nodes/register`. The reply carries a one-time
`enrollmentToken`, valid for one hour. For an existing node, an administrator issues one with:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}' \
  https://magnus.example.com:4000/api/v1/nodes/<nodeId>/enrollment-token
```

On the host, with `CONTROL_API_URL` set in the agent's `.env`:

```bash
magnus-agent enroll --token mne_...
# or keep the token off the process table: read it from a file, or from standard input
magnus-agent enroll --token-file /run/magnus/enrollment-token
printf '%s' "$ENROLLMENT_TOKEN" | magnus-agent enroll --token-file -
```

The agent creates a new key, proves possession, and stores the node id and the server's public key.
A running agent picks the new identity up within a few seconds. The server stores only the SHA-256
of a token, a token works once, and issuing a new one withdraws the previous one. Enrolling with a
token replaces whatever key the node had.

Under an explicit `compat` or `warn`, unknown agents that present the shared secret are still added
to the inventory on their first heartbeat unless `NODE_AUTO_REGISTER=false`. In enforce mode the
default is off (and the shared secret is refused anyway): register the node first.

## Signed evidence

Besides requests, agents hand the server *evidence*: command results, refusals and absences, fence
proofs, node session and terminal receipts, drain receipts and writer proofs, and scheduler
receipts. It used to be signed only with the fleet-wide `RESULT_SIGNING_SECRET` (HMAC), so any node
could forge another node's evidence.

An agent of this release with a bound key also signs every piece of evidence with its node key
(`nodeSignature`), over the same canonical payload, its node id and its key id. It starts once the
server's heartbeat reply says the server verifies such signatures, and says so in its own signed
heartbeats. The server then judges evidence for a node like this:

| Evidence carries | Server accepts it when |
|---|---|
| a `nodeSignature` by a key the server knows | the key belongs to this node (active, or retiring within its grace), the signature names this node, and it verifies. A valid HMAC next to a bad signature does not help |
| no `nodeSignature` (or one by a key the server does not know) | the HMAC verifies, the mode is not `enforce`, and the node's agent has not said it signs evidence (the *evidence ratchet*). Each such acceptance is counted as legacy use |

The ratchet follows the agent's own signed heartbeats: an agent downgraded to a version that does
not sign evidence lifts it again, and nobody without the node key can. The HMAC stays on every
piece of evidence in this release, so a server older than this release keeps working.

Decisions the server makes *for* one node, a command reconciliation (ADMIN `command-reconcile`,
Embermend owner settlement) and a scheduler enrollment stage, are signed with the server key for
that node (`serverSignature`) and verified by the agent against the key it pins. They used to need
`COMMAND_RECONCILIATION_SECRET` on the server and every agent. The server still adds that HMAC when
the secret is set, for agents without a key; an agent of this release advertises
`features.serverAuthorizations` in `/api/v1/ping`, and with it the secret is no longer needed.

In enforce mode (the default from 3.0.0) the server refuses evidence that carries only the HMAC, and
signs every decision with its server key only: it adds no `COMMAND_RECONCILIATION_SECRET` HMAC, and
refuses a decision that comes back with only one. A decision keeps verifying after a
[server-key rotation](#rotating-the-server-key): it names the key that signed it, and the server
keeps the public part of every key it retired.

Not node credentials, and unchanged: the drain receipts of the console
(`RESOURCE_ENROLLMENT_DASHBOARD_SECRET`) and the API participant
(`RESOURCE_PARTICIPANT_RECONCILIATION_SECRET`).

### Settling a scheduler source

`POST /api/v1/cron/scheduler-sources/reconcile` settles one remembered foreign scheduler source
during an enrollment drain. It takes an assertion signed in advance with
`COMMAND_RECONCILIATION_SECRET`, meant as a second factor next to the ADMIN role. Magnus never
produces that signature (no route or command does); whoever signs it needs the key, and the key is
not the server's alone: it sits in the server's environment and, because agents before node keys
needed it, in every agent's `.env` that an installer gave it to. A copy from any node could sign a
settlement. So in 3.0.0:

- In enforce mode the reviewer route answers `409 NODE_AUTH_ENFORCED`. Under an explicit `compat`
  or `warn` it works as before.
- Its replacement is a **two-ADMIN approval**. One ADMIN person requests the settlement with a
  reason, a different ADMIN person approves it within 15 minutes, and only then does the server sign
  it for that node with its server key. The API secret and service identities can take neither step.

```bash
# ADMIN 1: request (nodeId, the source's kind, sourceSha256 and count from the drain status, a disposition and a reason)
curl -X POST -H "Authorization: Bearer $TOKEN_1" -H 'content-type: application/json' \
  -d '{"nodeId":"<nodeId>","kind":"USER_CRONTAB","sourceSha256":"<sha256>","count":1,"disposition":"no_effect_verified","reason":"checked by hand: removed last week"}' \
  https://magnus.example.com:4000/api/v1/cron/scheduler-sources/reconcile-requests
# ADMIN 2: approve (or POST .../reject to withdraw it)
curl -X POST -H "Authorization: Bearer $TOKEN_2" -H 'content-type: application/json' -d '{}' \
  https://magnus.example.com:4000/api/v1/cron/scheduler-sources/reconcile-requests/<id>/approve
```

The evidence digest of the decision binds both people, both times, the reason and the drain
barrier; each step is audited (`cron.scheduler-source.reconcile_request`, `_approve`, `_reject`).
A 3.0.0 agent verifies the server's signature (`features.schedulerSourceAuthorizations`); an older
agent knows only the HMAC, so the approval answers `409 AGENT_UPGRADE_REQUIRED` in enforce mode and
adds the HMAC under an explicit `compat` with the key configured. Open requests live in the server
process and do not survive a restart.

### The agent's own records

An agent MACs its own records (the command ledger, historical mutation observations, receipts and
decisions) and the legacy `signature` field of its evidence. Up to 2.10.2 it used the shared
`RESULT_SIGNING_SECRET` and `COMMAND_RECONCILIATION_SECRET`. A 3.0.0 agent needs neither:

- **Signing.** With the shared key configured it keeps using it, so an agent downgraded to 2.10.x
  still reads every record. Without it the agent uses node-local keys,
  `$AGENT_INSTALL_DIR/identity/local-result.key` and `local-reconciliation.key` (0600, created on
  first use, never sent). They are separate from the node key, so `identity rotate` or a
  re-enrollment orphans nothing. What the server relies on is the node signature next to the MAC.
- **Reading.** A record verifies with any key it may have been signed with: the shared key, its
  previous value (`RESULT_SIGNING_PREVIOUS_SECRET`) and the node-local key. A ledger written by
  2.10.x stays readable as is; nothing is rewritten.
- **Retiring the shared key from an upgraded agent.** Move its value from `RESULT_SIGNING_SECRET`
  to `RESULT_SIGNING_PREVIOUS_SECRET`: new records are MACed with the node-local key, old ones keep
  verifying. Removing it outright makes records signed with it unreadable (the agent says so and
  names the variable). An agent that wrote records with a node-local key cannot be downgraded to
  2.10.x without losing them.
- The `historical-mutation` tool on the host signs its settlements with `COMMAND_RECONCILIATION_SECRET`
  when the agent has it, else with the node-local reconciliation key.

## Agent-side enforce

From 3.0.0 this is the agent's default. With `NODE_AUTH_MODE` unset or `enforce`, and once that node
has a bound key, the agent refuses every `/api/v1/*` request that carries only `x-node-token`
(`401 NODE_SIGNATURE_REQUIRED`), and an agent without a shared secret refuses it before it has a key.
It accepts:

- requests signed by a server key it pins, made for this node, fresh and not replayed;
- its own in-process dispatch (a managed request runs the target route inside the agent process; no
  credential, and nothing from the network can pass as one);
- its upgrade acceptance probe, signed with the node's own key, on `GET /api/v1/health/check` only.

It also refuses reconciliation and scheduler decisions that carry only the
`COMMAND_RECONCILIATION_SECRET` HMAC. This is what closes lateral movement: a node's `.env` no longer
opens this agent's management API. In enforce mode the agent also stops *sending* the shared secret
to the server (under an explicit `compat` or `warn` it still sends it next to its signature). Without
a bound key the agent works as in `compat` and its log says so; without a shared secret either, it
waits to be enrolled with a token.

To switch one node of a 2.10.x fleet ahead of 3.0.0:

1. Check the node is ready: `magnus-agent identity show` reports `bound`, and the server's node view
   shows `nodeCredential.state: active` and `evidenceSigning: true`.
2. If the installer runs the upgrade acceptance probe with `--env-file`, the probe finds the key next
   to that file; otherwise set `AGENT_INSTALL_DIR` in the `.env`.
3. Add `NODE_AUTH_MODE=enforce` to the agent's `.env` and restart the agent.
4. Confirm: the Nodes page still shows the node online and a command runs. A request with only the
   shared secret, for example `curl -H "x-node-token: ..." https://node-1.example.com:4100/api/v1/files`,
   answers 401.

To roll back, remove the line (or set `NODE_AUTH_MODE=compat`) and restart the agent. If the agent
is refused by the server meanwhile (its key was revoked, or the server lost its key file and the
agent has not pinned the new one), the agent in enforce mode also refuses the server's requests
until it pins the server key again; rolling back to `compat` restores the shared-secret path.

### Agents 2.10.0 and 2.10.1 on enrolled nodes

An agent of 2.10.0 or 2.10.1 with a bound key authenticates `POST /api/v1/commands/managed-http`
twice, and its second pass refuses the nonce its first pass claimed: every signed managed request
(agent upgrades, Embermend, skills and other mutations of an enrolled node) answers
`401 NODE_AUTH_REPLAY` before anything runs. The 2.10.2 agent authenticates a request once.

A 2.10.2 or later server reaches such an agent without upgrading it first. It reads the agent's
version and `features.nodeAuth` from its ping, checks with an unsigned `GET` of the managed route
(authenticated, then answered 404: it runs nothing) that the agent accepts the shared secret, and
sends that one managed request with the shared secret only, as `compat` and `warn` allow; the use is
counted under `outbound` in `legacyUse`. The resource claim the agent confirms with the server over
its own signed channel, the fence and the once-only ledger receipt still decide what runs. When the
server is in `enforce`, or the agent enforces its key, nothing is sent and the request fails as not
dispatched with `AGENT_MANAGED_HTTP_NEEDS_UPGRADE`: switch the server to `compat` for the upgrade,
or upgrade that agent outside the managed path.

A request a 2.10.0 or 2.10.1 agent refused this way left its lease `unknown`. The agent's ledger
holds no receipt for it, so past the lease deadline the server's readiness monitor settles it as
`not-dispatched` by itself (at most hourly per node), and `magnus-server agents doctor --heal`
settles it at once. Both act only on the agent's signed ledger account.

## Readiness for enforce

The summary counts real nodes only (never `__control-api__`, `__dashboard__` or decommissioned
nodes), and also carries `modeExplicit`, `modeDeprecated` with a `deprecationNotice`, and the
[server-key rotation](#rotating-the-server-key) as `serverKeyRotation`.

`GET /api/v1/node-credentials/summary` (ADMIN, OPERATOR) counts nodes by credential state, sums the
use of the shared credentials over the last 24 hours, and lists what switching the server to
`enforce` would refuse:

| Blocker | Meaning |
|---|---|
| `SERVER_KEY_UNAVAILABLE` | The server signing key cannot be read |
| `NODES_WITHOUT_KEY` | Nodes still on the shared secret |
| `NODES_REVOKED` | Nodes whose keys were revoked; enroll them with a token |
| `NODES_NOT_SIGNING_EVIDENCE` | Agents older than 2.10.0, or not told yet that the server verifies node evidence |
| `AGENTS_NEED_UPGRADE` | Agents 2.10.0 or 2.10.1 with a key: enforce mode cannot reach their managed HTTP route |
| `RECENT_SHARED_SECRET_USE` | The shared node secret or the shared result key was used for these nodes in the last 24 hours |
| `PENDING_BINDINGS` | Bindings waiting for an administrator |

Each node's `nodeCredential` also carries `evidenceSigning` and `legacyUse` (per channel: `request`,
`evidence`, `outbound`, with count and last use). In `warn` mode the server audits the first use per
node and channel each day (`node.credential.legacy_use`), and the readiness probe
(`GET /health/ready`) reports a failing, non-critical `node-credentials` check (`degraded`, still
200) while any blocker remains.

## Rotate, revoke, re-enroll

| Task | How | Effect |
|---|---|---|
| Rotate a node key | `magnus-agent identity rotate` on the node | New key, signed for by the old one. The old key stays valid for 24 hours |
| Revoke | In the UI, or `POST /api/v1/nodes/<nodeId>/credentials/revoke` (ADMIN), body `{}` or `{"keyId": "..."}`, optionally with `"reason"` | Once no active key is left, the agent is refused with `401 NODE_CREDENTIAL_REVOKED`. The node stays closed to the shared secret |
| Re-enroll | Issue a token with the API, then `magnus-agent enroll --token` on the node | A new key replaces the old ones |
| List keys | In the UI, or `GET /api/v1/nodes/<nodeId>/credentials` (ADMIN) | Key ids, fingerprints, status, origin, last use |

Deleting a node deletes its credentials.

### From the UI

These three routes are browser routes, so HiveXUI, signed in with Oathweave, can offer an administrator the list,
revoke and reset of a node's keys. The UI calls the same routes as `curl` does; the server checks the `ADMIN` role on each request, so an `OPERATOR` or `VIEWER` is refused
whatever the UI shows. Issuing an enrollment token stays with the API and the command line, because its response is a
secret.

- A revoke or reset takes an optional `reason` (1 to 500 characters). The audit event (`node.credential.revoke`,
  `node.credential.reset`) records it with the person who acted.
- The response says what happened next, so the UI can explain it. A revoke answers `agentRefused` (no active key is
  left, so the agent is refused until it is enrolled with a token), `sharedSecretAccepted: false` and `resetAvailable`.
  A reset answers `sharedSecretAccepted: true` and `legacyUpgradeOpen`: while the upgrade window is open, an agent of
  this release binds a key again by itself.
- A repeat with the same `x-idempotency-key` header answers `409 DUPLICATE_REQUEST` instead of acting twice.

The routes and their schemas are in [console-api.md](console-api.md#node-key-administration).

## Rotating the server key

The server key signs every request to an agent and every decision the server makes for a node. To
replace it (on a schedule, or because the key file may have been copied), move a new key through
three steps. Each step changes the key file: back it up with the database afterwards.

| Step | Route (ADMIN) or command on the server host | Effect |
|---|---|---|
| Stage | `POST /api/v1/node-credentials/server-key/stage` `{}`, or `magnus-server node-auth server-key stage` | A next key. Agents pin it from their next heartbeat (3.0.0 agents read the heartbeat reply's `serverKeyIds`). The server accepts requests signed for its audience but signs nothing with it |
| Promote | `POST .../server-key/promote` `{"graceHours":168}`, or `... promote --force --grace-hours 168` | The next key signs from now on. The replaced key stays pinned and accepted as an audience until `retireAfter` |
| Retire | `POST .../server-key/retire` `{}` (after `retireAfter`, or `{"force":true}`), or `... retire [--force]` | The replaced key's private part is destroyed. Its public key is kept, so decisions it signed still verify; it is no longer pinned or accepted |

1. Stage, then wait until `GET /api/v1/node-credentials/summary` shows
   `serverKeyRotation.agents.pinningNext` equal to `keyedNodes` (a few heartbeats). The promote
   route refuses earlier with `409 SERVER_KEY_NOT_PINNED` unless `force`; the command line cannot see
   the pins and always needs `--force`.
2. Promote. Requests to agents are signed with the new key; agents sign for it once the heartbeat
   reply lists it first.
3. After the grace period (default 7 days), retire.
4. Back up `$MAGNUS_HOME/state/node-auth/server-signing-key.json` with the database.
5. Check: the start-up line shows the new fingerprint, and `magnus-agent identity show` on a node
   lists it first among the pinned server keys.

An agent that was offline for all of it recovers by itself: the first request signed with a key it
does not pin is refused once, the agent reads the keys again from
`GET /api/v1/node-enrollment/server-key` over verified TLS and pins them, and the next request
passes. It keeps the public key it no longer pins only to verify decisions it recorded while that
key was pinned. A 2.10.2 agent pins a staged key only when it restarts or meets a key it does not
know; rotate once the agents are on 3.0.0, so that decisions they recorded keep verifying.

A 2.10.2 server reads a rotated key file: it uses `active` and `next` and ignores the rest.

## Rollback

Under 3.0.0 the reset below needs an explicit `NODE_AUTH_MODE=compat` (or `warn`) on the server, and
the agent the same in its `.env`: enforce mode has no way back to the shared secret.

**One node back to the shared secret.** Both sides have to forget the key:

```bash
# server (ADMIN, or Reset in the UI): accept the shared secret for this node again
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"reason":"rollback"}' \
  https://magnus.example.com:4000/api/v1/nodes/<nodeId>/credentials/reset

# node: remove the key
magnus-agent identity reset
```

While the window is open, an agent of this release binds a new key again by itself. Do the server
step first: after `identity reset` alone, the node is refused until the server is reset.

**Downgrading an agent** to a version older than 2.10.0 has the same effect as
`identity reset`: the old agent only knows the shared secret, and the server refuses it for a node
that has a key. Ask the server first:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  'https://magnus.example.com:4000/api/v1/node-credentials/downgrade-check?nodeId=<nodeId>&to=2.9.1'
```

`action: reset-credentials` names the reset to post first (`resetPath`); `enroll-instead` means the
server is in `enforce` mode, which has no reset: keep an agent of 2.10.0 or later. An agent of
2.10.0 or later keeps its key; if it does not sign evidence, its signed heartbeat lifts the
evidence ratchet by itself. An automatic revert by the upgrade launcher is safe: an agent never
binds while its upgrade is on trial. Run the agent with `NODE_AUTH_MODE=compat` before installing a
version older than this release on a node in agent-side enforce.

**Downgrading the server** needs nothing: an older server ignores the new tables and the signature
headers, and agents send the shared secret alongside their signature. Its heartbeat replies do not
announce node evidence, so agents stop adding `nodeSignature` and keep the HMAC.

**The server key file was lost** (restored from a database backup without `$MAGNUS_HOME/state`):
the server creates a new key. Agents notice on their next refused request, read the new key from
`GET /api/v1/node-enrollment/server-key` over verified TLS and pin it. Meanwhile the server sends
them the shared secret as well, because they do not pin its new key yet. Back the key file up with
the database to avoid this.

**The database lost a node's credential** (restored from an older backup): the agent's signature
is unknown. Under an explicit `compat` the shared secret it also sends is accepted, and the
heartbeat reply tells the agent to bind the same key again. In enforce mode the node is refused
(`401 NODE_CREDENTIAL_UNKNOWN`) until it is enrolled with a token.

## Settings

Server:

| Variable | Default | Purpose |
|---|---|---|
| `NODE_AUTH_MODE` | `enforce` (3.0.0) | `enforce`: signatures and node-signed evidence only; the shared secret is refused and not sent, the automatic upgrade is closed, credentials cannot be reset. Unset, the [start-up guard](#upgrading-to-300) applies. `compat` (signature or shared secret, with the per-node ratchet) and `warn` (the same, and each use of the shared secret is logged): deprecated, honoured when set explicitly, removed in the next major |
| `NODE_AUTH_LEGACY_UPGRADE_UNTIL` | 30 days after the first start | ISO 8601 date that ends the automatic upgrade (compat and warn only) |
| `NODE_AUTH_SERVER_KEY_PATH` | `$MAGNUS_HOME/state/node-auth/server-signing-key.json` | The server signing key file, with its [rotation](#rotating-the-server-key) |
| `NODE_AUTO_REGISTER` | `false` in enforce, `true` in compat and warn | Add unknown agents that present the shared secret |
| `NODE_MANAGER_SECRET`, `RESULT_SIGNING_SECRET` | none | Required only under an explicit compat or warn; optional (and still honoured) in enforce |

Agent:

| Variable | Default | Purpose |
|---|---|---|
| `NODE_AUTH_MODE` | `enforce` (3.0.0) | `enforce`: see [Agent-side enforce](#agent-side-enforce). `compat` (the agent's API accepts a server signature or the shared secret) and `warn` (the same, logged): deprecated |
| `NODE_MANAGER_SECRET`, `RESULT_SIGNING_SECRET`, `COMMAND_RECONCILIATION_SECRET` | none | Needed only under an explicit compat or warn (and by the automatic legacy upgrade). An upgraded agent keeps them for its [own records](#the-agents-own-records) |

Do not run the server in enforce mode while `GET /api/v1/node-credentials/summary` reports
blockers; with the mode unset, the start-up guard stops it.

`magnus-server` command-line processes that call agents (`magnus-server agents ...`) read the
server's package `.env` like `start` does and sign with the server's key file; they never create a
key of their own. Without that file (another `MAGNUS_HOME`, no `--env-file`), they say so and, outside
`enforce`, fall back to the shared secret. Each run prints the key fingerprint it signs with: it
must match the server's start-up line. `magnus-server node-auth server-key` edits the same file; a
running server notices the change within a second.

## What is not covered yet

- An explicit `compat` or `warn`, on the server or an agent, still accepts the shared secret, as in
  2.10.x. Both are removed in the next major.
- The replay cache lives in the server process: run one Control API instance. Open two-ADMIN
  scheduler-source requests live there too.
- Log forwarding (`LOG_INGEST_TOKEN`) and the Hermes registry token are separate credentials and
  are unchanged.

## Phases

1. **compat (2.10.0).** Both credentials are accepted; a node with a key is closed to the
   shared secret; existing nodes bind automatically for 30 days.
2. **warn (2.10.0, default mode still `compat`).** Node-signed evidence replaces the shared result
   key for nodes whose agent signs it, and server-signed decisions replace
   `COMMAND_RECONCILIATION_SECRET`; agents can refuse the shared secret on their own API
   (agent-side enforce); bindings refused for their address can be approved; use of the shared
   credentials is counted per node, audited in `warn` and fails the readiness check there; the
   fleet summary lists what blocks `enforce`.
3. **enforce (3.0.0).** `enforce` is the default on the server and the agent, behind the start-up
   guard. The shared secret is refused and no longer sent, in both directions; HMAC-only evidence
   and decisions are refused; the automatic upgrade is closed; `NODE_AUTO_REGISTER` is off; the
   shared secrets leave the boot checks, catalogues and templates; agents MAC their own records with
   node-local keys; the server key can be rotated; the reviewer-signed scheduler-source settlement
   gives way to a two-ADMIN approval. An explicit `compat` or `warn` keeps working, deprecated.
4. **Next major.** `compat`, `warn`, `NODE_MANAGER_SECRET`, `RESULT_SIGNING_SECRET` and
   `COMMAND_RECONCILIATION_SECRET` are removed.
