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
| `403 PEER_ADDRESS_MISMATCH` | The agent reaches the server from an address other than the one recorded | Repair the node's address, or enroll it with a token |
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

# on the server (ADMIN)
curl -H "Authorization: Bearer $TOKEN" https://magnus.example.com:4000/api/v1/nodes/<nodeId>/credentials
```

The binding notification carries the same fingerprint. If they differ, revoke the key and enroll
the node with a token.

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
```

The agent creates a new key, proves possession, and stores the node id and the server's public key.
A running agent picks the new identity up within a few seconds. The server stores only the SHA-256
of a token, a token works once, and issuing a new one withdraws the previous one. Enrolling with a
token replaces whatever key the node had.

Unknown agents that present the shared secret are still added to the inventory on their first
heartbeat. Set `NODE_AUTO_REGISTER=false` on the server to require registration first.

## Rotate, revoke, re-enroll

| Task | How | Effect |
|---|---|---|
| Rotate a node key | `magnus-agent identity rotate` on the node | New key, signed for by the old one. The old key stays valid for 24 hours |
| Revoke | `POST /api/v1/nodes/<nodeId>/credentials/revoke` (ADMIN), body `{}` or `{"keyId": "..."}` | The agent is refused with `401 NODE_CREDENTIAL_REVOKED`. The node stays closed to the shared secret |
| Re-enroll | Issue a token, then `magnus-agent enroll --token` on the node | A new key replaces the old ones |
| List keys | `GET /api/v1/nodes/<nodeId>/credentials` (ADMIN) | Key ids, fingerprints, status, origin, last use |

Deleting a node deletes its credentials.

## Rollback

**One node back to the shared secret.** Both sides have to forget the key:

```bash
# server (ADMIN): accept the shared secret for this node again
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}' \
  https://magnus.example.com:4000/api/v1/nodes/<nodeId>/credentials/reset

# node: remove the key
magnus-agent identity reset
```

While the window is open, an agent of this release binds a new key again by itself. Do the server
step first: after `identity reset` alone, the node is refused until the server is reset.

**Downgrading an agent** to a version older than this release has the same effect as
`identity reset`: the old agent only knows the shared secret, and the server refuses it for a node
that has a key. Reset the node's credentials on the server before (or right after) the downgrade.
An automatic revert by the upgrade launcher is safe: an agent never binds while its upgrade is on
trial.

**Downgrading the server** needs nothing: an older server ignores the new tables and the signature
headers, and agents send the shared secret alongside their signature.

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

Agent: none are needed. `NODE_AUTH_MODE` is accepted and reserved; in this release the agent
behaves as `compat` whatever the value, because local callers (the upgrade acceptance probe, the
in-process managed dispatch) still use the shared secret on the agent's own API.

Do not set `NODE_AUTH_MODE=enforce` on the server while any node shows `nodeCredential.state`
other than `active`, or while a `magnus-server` command-line process needs to reach agents that do
not pin the server key yet.

## What is not covered yet

- An agent still **accepts** the shared secret on its own API. Stealing one node's `.env` therefore
  still opens the other agents' management APIs until phase 3. What this release removes is
  impersonating a node towards the server.
- `RESULT_SIGNING_SECRET` and `COMMAND_RECONCILIATION_SECRET` are still fleet-wide.
- Log forwarding (`LOG_INGEST_TOKEN`) and the Hermes registry token are separate credentials and
  are unchanged.

## Phases

1. **compat (this release).** Both credentials are accepted; a node with a key is closed to the
   shared secret; existing nodes bind automatically for 30 days.
2. **warn.** Signed command results and per-node reconciliation replace the two fleet-wide signing
   secrets; use of the shared secret is audited and fails readiness; the console shows credential
   state; new installs use enrollment tokens.
3. **enforce.** The shared secret is refused and no longer sent, in both directions; the automatic
   upgrade is closed; the shared secrets leave the boot checks and templates. `enforce` is never
   switched on automatically: it becomes the default only in that release.
