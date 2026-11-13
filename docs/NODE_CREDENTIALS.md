# Per-node credentials

Every agent used to authenticate with one fleet-wide value, `NODE_MANAGER_SECRET`, sent in the
`x-node-token` header in both directions. Whoever held it could report as any node and could call
the management API of every agent.

From this release each node has its own Ed25519 key, and the server has one too. Requests are
signed, and a signature names exactly one node. The shared secret keeps working while the fleet
moves over. It is removed in a later release (see [Phases](#phases)).

Nothing has to be done on the nodes. Upgrade the server and the agents in either order, and each
agent binds its own key by itself.

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

## What happens to existing nodes

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

Unknown agents that present the shared secret are still added to the inventory on their first
heartbeat. Set `NODE_AUTO_REGISTER=false` on the server to require registration first.

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

Still on the shared keys, and why:

- `POST /api/v1/cron/scheduler-sources/reconcile` takes an assertion signed in advance by a
  reviewer who holds `COMMAND_RECONCILIATION_SECRET`: a second factor next to the ADMIN role, not a
  node credential. It is unchanged.
- The agent's own records (its command ledger, historical mutation observations and the
  `historical-mutation` command) are checked with `RESULT_SIGNING_SECRET` and
  `COMMAND_RECONCILIATION_SECRET` on the node itself, so an older agent version can still read
  them after a downgrade. A stored command result gets its node signature when it leaves the host.
- The drain receipts of the console (`RESOURCE_ENROLLMENT_DASHBOARD_SECRET`) and the API
  participant (`RESOURCE_PARTICIPANT_RECONCILIATION_SECRET`) are not node evidence.

## Agent-side enforce

With `NODE_AUTH_MODE=enforce` in an agent's `.env`, and once that node has a bound key, the agent
refuses every `/api/v1/*` request that carries only `x-node-token` (`401 NODE_SIGNATURE_REQUIRED`).
It accepts:

- requests signed by a server key it pins, made for this node, fresh and not replayed;
- its own in-process dispatch (a managed request runs the target route inside the agent process; no
  credential, and nothing from the network can pass as one);
- its upgrade acceptance probe, signed with the node's own key, on `GET /api/v1/health/check` only.

It also refuses reconciliation and scheduler decisions that carry only the
`COMMAND_RECONCILIATION_SECRET` HMAC. This is what closes lateral movement: a node's `.env` no longer
opens this agent's management API. The agent keeps *sending* the shared secret to the server in this
release, so a server that lost its records of the key can still recognise it. Without a bound key
the agent stays in `compat` and its log says so. The default stays `compat`.

To switch one node:

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

## Readiness for enforce

`GET /api/v1/node-credentials/summary` (ADMIN, OPERATOR) counts nodes by credential state, sums the
use of the shared credentials over the last 24 hours, and lists what switching the server to
`enforce` would refuse:

| Blocker | Meaning |
|---|---|
| `SERVER_KEY_UNAVAILABLE` | The server signing key cannot be read |
| `NODES_WITHOUT_KEY` | Nodes still on the shared secret |
| `NODES_REVOKED` | Nodes whose keys were revoked; enroll them with a token |
| `NODES_NOT_SIGNING_EVIDENCE` | Agents older than this release, or not told yet that the server verifies node evidence |
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

## Rollback

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
is unknown, the shared secret it also sends is accepted, and the heartbeat reply tells the agent to
bind the same key again.

## Settings

Server:

| Variable | Default | Purpose |
|---|---|---|
| `NODE_AUTH_MODE` | `compat` | `compat`: signature or shared secret, with the per-node ratchet. `warn`: the same, and each use of the shared secret is logged. `enforce`: signatures only; the shared secret is refused and not sent, the automatic upgrade is closed, and credentials cannot be reset |
| `NODE_AUTH_LEGACY_UPGRADE_UNTIL` | 30 days after the first start | ISO 8601 date that ends the automatic upgrade |
| `NODE_AUTH_SERVER_KEY_PATH` | `$MAGNUS_HOME/state/node-auth/server-signing-key.json` | The server signing key file |
| `NODE_AUTO_REGISTER` | `true` | Add unknown agents that present the shared secret |

Agent:

| Variable | Default | Purpose |
|---|---|---|
| `NODE_AUTH_MODE` | `compat` | `compat`: the agent's API accepts a server signature or the shared secret. `warn`: the same, and each use of the shared secret is logged. `enforce`: see [Agent-side enforce](#agent-side-enforce) |

Do not set `NODE_AUTH_MODE=enforce` on the server while `GET /api/v1/node-credentials/summary`
reports blockers.

`magnus-server` command-line processes that call agents (`magnus-server agents ...`) read the
server's package `.env` like `start` does and sign with the server's key file; they never create a
key of their own. Without that file (another `MAGNUS_HOME`, no `--env-file`), they say so and, outside
`enforce`, fall back to the shared secret. Each run prints the key fingerprint it signs with: it
must match the server's start-up line.

## What is not covered yet

- An agent accepts the shared secret on its own API unless it runs in agent-side `enforce`.
  Until a node does, stealing another node's `.env` still opens its management API.
- `RESULT_SIGNING_SECRET` is still required and still signs every piece of evidence alongside the
  node key, and agents keep sending the shared node secret, so older servers keep working.
- The shared keys listed under [Signed evidence](#signed-evidence) as still in use.
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
3. **enforce.** The shared secret is refused and no longer sent, in both directions; the automatic
   upgrade is closed; the shared secrets leave the boot checks and templates. `enforce` is never
   switched on automatically: it becomes the default only in that release.
