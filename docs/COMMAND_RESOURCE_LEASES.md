# Command resource leases

Resource leases give every command that changes a node a single, durable owner in the server's
PostgreSQL database. They stop two processes, two server replicas or a crashed and restarted
server from running conflicting work on the same node, and they keep an uncertain command owned
until its outcome is proven.

Leases build on the per-node [command receipts](COMMAND_RECEIPTS.md). Receipts say what happened
on one node; leases decide who may start work on it.

The feature is off by default: `MAGNUS_RESOURCE_LEASES_ENABLED=false`. Enrolling a node is a
deliberate, one-way step described below. Leases never grant permission for an action; roles,
approvals and remediation plans still decide that.

## Node command leases

Every finite command sent through the server SDK names the inventory node it targets, and that
node's stored endpoint must match the endpoint being called. For an enrolled node, a PostgreSQL
transaction and an advisory lock on the node serialize admission across processes. The lease
binds the command ID, request digest, actor, node fence and deadline. Repeating a command ID never
creates a second owner or a second remote execution.

**Scope.** An approved `restart-service.v1` remediation plan gets the scope
`node:<id>:system-service:<unit>.service`. Every other command gets `node:<id>:all`, including shell
commands that happen to call `systemctl`. Command text never narrows a scope. Because the node has
a single execution slot, all scopes on one node are currently serialized.

**Waiting.** A queued command that meets an active lease waits in the durable queue until its own
deadline. A direct execution request gets a conflict response. Queue workers (commands, rollouts,
role scripts), quick commands, the assistant's shell and skill commands and the file API's shell
fallback all take part.

**Lifecycle.** A lease is `reserved` until just before the single remote request and `running`
from then on.

- A known failure or crash while `reserved` releases the lease with a `not-dispatched` proof.
  Atomic state changes stop a delayed sender from dispatching afterwards.
- A lost reply, malformed result or crash while `running` leaves the lease `unknown`. Expiry,
  cancellation, heartbeats, a failed command status and a server restart do not release it.
- A refusal the node can prove settles the lease as `not-dispatched`: the agent signs with its result
  key that this exact request did not start and that nothing local refers to it (`STALE_FENCE`, `LEASE_EXPIRED`,
  `RESOURCE_BUSY` and so on), bound to the request digest, the lease and the node. An unsigned word, or one for
  another request, lease or node, proves nothing and the lease stays `unknown`.
- Only a verified node result bound to the exact request and fence, or the node's acknowledgement
  of a signed reconciliation receipt, settles an uncertain lease that has a receipt. A signed nonzero exit
  code proves the command finished; it does not prove a service recovered.
- A lease stuck `unknown` with no receipt can be settled as `not-dispatched` once its deadline has passed by a
  minute, by a run, `magnus-server agents doctor --heal` or the readiness monitor (once an hour per node). The agent
  signs, under a fresh nonce, what its ledger holds for the command (`GET /api/v1/commands/receipts/<id>/trace`):
  whether the ledger exists, a receipt, this command's claim, the fence high-water, the enrollment marker and any record of a
  failed admission. The ledger writes the claim, the fence, the marker and a durable running receipt, in that order, and only then
  starts the handler. Past the deadline a delayed request can pass neither the ledger nor `/claim`. So with no receipt:
  | Ledger holds | Means | Lease |
  |---|---|---|
  | This node's marker, no fence, no claim | The marker shows it is this node's ledger; no request passed the fence | settles |
  | High-water below the lease's fence | It never passed admission | settles |
  | High-water above it | A later fence won, or the request was refused as stale | settles |
  | High-water equal, with this command's claim | A crash or failed write between the claim and the receipt | settles |
  | High-water equal, with its record of a failed admission for this fence | The agent recorded that a write failed before the handler | settles |
  | High-water equal, with neither | A receipt was removed, or a build without such records failed the admission | `LEDGER_EVIDENCE_INCONSISTENT`, held |
  | No fence and no marker | Nothing shows this is the ledger the command would have used | `LEDGER_NO_FENCE`, held |
  | No ledger | Nothing at all | `LEDGER_MISSING`, held |
  | A marker for another node, or one it cannot read | | held |
- A receipt leaves signed reconciliation as the only way out. Scheduler occurrences and skill publications keep
  their own retained evidence and are never settled this way, and agents older than 1.1.8 have no such route: their
  leases stay held until the agent is upgraded by hand.
- If a held lease has no receipt, signed reconciliation does not apply either, since the agent refuses it. Restore the ledger if
  it moved, and the lease settles by itself. Otherwise there is no way out in Magnus: someone has to establish what the command
  did on the node, and change the lease row in the database by hand.
- What this cannot detect: a ledger that was wiped and then used again, whose higher fence with no receipt looks the
  same as a later fence winning, or one wiped and then told its enrollment again, which looks like the first row. A receipt
  deleted by hand on a ledger whose high-water has since moved on looks the same too.
  The check proves a ledger is there and has seen this node, not that its history is complete.

A node's ledger can be ahead of the server's fence generation, after a database restore or because an older
build wrote timestamp-style values. The generation then moves up to high-water + 1 when a preflight signed for a fresh nonce, or a signed `STALE_FENCE`
bound to this node's lease, reports it, under the node's advisory lock and audited as `agent.fence.advanced`. It never
moves down. Only the node's own keys and decimal values under a cap are accepted. `magnus-server agents fence NODE VALUE`
does the same by hand for agents that do not report it. Heartbeat values only drive the readiness display.

The result key and the node credential are shared by the fleet, so a signature says what an agent claims, not which
agent it is. The limit is the connection: the server opens it to the node's inventory address, over TLS it verifies. A
heartbeat with the fleet credential can change that address only while it is loopback or unroutable, or to the DNS name of
that node's own agent certificate. So a holder of the fleet secrets, with a certificate the server trusts, can answer
for a node in that state: inflate its counters, which costs only numbering, and settle its leases that left no
receipt there. It can already do more than that with those secrets, such as signing command results.

There is no unsigned force-release. Do not delete lease history to clear a blocked node: history
stays a permanent barrier against falling back to unleased admission, even with the feature flag
turned off again.

### Operator API

- `GET /api/v1/commands/:commandId/resource-lease` returns ownership metadata, fence, timestamps
  and evidence hashes, without the command's environment or output.
- `POST /api/v1/commands/:commandId/reconcile-resource` (operator or admin). An empty body reads
  and verifies the node's current receipt without running anything. A body of
  `{ "assertion": ... }` submits a signed reconciliation in the
  [receipt format](COMMAND_RECEIPTS.md#reconciling-an-uncertain-command). The lease settles only
  after the node acknowledges the exact decision.

## Native requests

Managed changes that are not shell commands (file writes, skill publication and removal, managed
cron changes) go through the agent's `POST /api/v1/commands/managed-http`. The request binds the
method, exact route, body SHA-256, deadline and node fence into the command identity. Receipts
store only the response status and SHA-256, never request bodies or returned content. A successful
response produces a signed result; a validation error (4xx) settles a failed operation; a 5xx,
202, redirect, thrown handler, missing reply or response over 4 MiB leaves the lease uncertain.
Replaying a completed request never runs the handler again.

Skill publication is atomic: the server builds a canonical bundle from the registry snapshot, and
the node verifies every file, mode, manifest, bundle digest and tree digest before a single
directory rename. Archives are limited to 32 MiB compressed, 64 MiB expanded and 2,048 entries, and
links, devices, path traversal, duplicates and setuid or setgid bits are rejected.

## Enrolling a node

A node moves one way only: `legacy`, then `draining`, then `enrolled`. All transitions take the same
advisory lock as command reservations.

While a node is `legacy`, every raw mutation on the agent first asks the server
(`POST /api/v1/resource-leases/legacy-admission`) whether unleased work is still allowed. The
server refuses once the flag is on or any lease history exists for the node. An unknown target,
an unreachable server, a malformed answer or a stale nonce also refuses. The agent stores an
enrolled answer locally, so neither a restart nor a server outage can bring back unleased access.
Because of this check, mutations on unenrolled nodes need a reachable, compatible server: upgrade
the server before the agents, and make sure each node's inventory hostname matches its
`HOST_FQDN`.

Which history counts differs between paths, on purpose (`services/control-api/src/services/resource-ownership.ts`):
legacy-admission and managed cron treat any enrollment beyond `legacy`, any command lease, any managed
cron definition and any participant work (also work released by signed reconciliation) as leaving the
legacy path, and agents keep that answer as a sticky marker. Command admission and participant
reservation count only the enrollment row and command lease history, because participant work is
reserved on legacy nodes by design. A node with participant or cron history but no completed
enrollment therefore has an agent that refuses direct requests; complete its enrollment drain.

Enrollment requires a proven drain of four fixed participants: the agent, the API server, the
console and the managed scheduler. The server pulls signed evidence from each one; operators
cannot submit counts or acknowledgements on a participant's behalf. Agent evidence is signed with
`RESULT_SIGNING_SECRET` and console evidence with `RESOURCE_ENROLLMENT_DASHBOARD_SECRET`, which must
differ from every other key.

`GET /enrollment/:nodeId` also lists `lastFailures`: each participant's last refresh failure on this
server process as a fixed code (`participant-unreachable`, `participant-http-<status>`,
`participant-response-too-large`, `participant-receipt-invalid`, `participant-receipt-unauthenticated`
and so on), plus the participant's own error code and fixed reason when it sent them. Agents send a
reason with a refused drain proof: `authority-unavailable`, `authority-binding`, `fence-failed`,
`inventory-failed`, `challenge-expired` or `receipt-failed`; the scheduler adds `inventory-changed`
and `ownership-changed`, and the agent `supervisor-required` and `supervisor-unverified`. The agent
logs the underlying cause as a warning on its own host. Scheduler receipts may be up to 256 KiB;
other participant receipts up to 16 KiB.

Administrator routes, all under `/api/v1/resource-leases`:

| Route | Purpose |
| --- | --- |
| `GET /enrollment/:nodeId` | Status, missing participants and outstanding work (no tokens or command content) |
| `POST /enrollment/:nodeId/begin` | Start the one-way drain |
| `POST /enrollment/:nodeId/refresh` | Re-verify one participant (`agent`, `api`, `dashboard` or `scheduler`) |
| `POST /enrollment/:nodeId/api-attest` | Submit a signed API-server attestation for the current challenge |
| `POST /enrollment/:nodeId/scheduler-boundary-attest` | Submit a signed review of the node's scheduler sources |
| `POST /enrollment/:nodeId/complete` | Verify all four participants and enroll the node |
| `GET /enrollment/work/:workId/historical`, `POST /enrollment/work/:workId/historical-reconcile` | Inspect and reconcile console work recorded before tracking existed |

Console terminals and the Hermes dashboard proxy reserve durable work and consume a single-use
start grant before they open an SSH connection. A crash, disconnect or shell exit leaves that work
`unknown`, because processes started in the session may still be running.

On an enrolled node the agent denies, before dispatch, the operations that cannot yet prove their
outcome: Hermes Agent lifecycle and configuration, Codex update and login, agent self-update,
system updates, user management, server-side SSH deployment helpers and console terminals.

### Execution supervisor

Offline historical reconciliation keeps observations bounded to 16 exact record
IDs. For a larger inventory, use
`historical-mutation-cli inspect --output FILE --records UUID,UUID`
to capture separate signed batches before the approved host
reboot. Apply each retained batch afterward with the same exact IDs and the
independent review credential. Selection rejects duplicate, missing, completed,
settled, or active records; unselected claims remain unresolved. This does not
expand the supported historical routes, replace the kernel boot requirement,
authorize replay, or establish the original effects' outcomes. Original request
bytes remain intact and settlements remain separate signed receipts.

`MAGNUS_EXECUTION_SUPERVISOR_ENABLED=true` on a privileged agent runs each command in its own
systemd unit. The agent records the launch intent first, binds observations to the boot,
invocation and command digest, and can adopt a completed command after a restart without running
it again. A command counts as finished only when its cgroup is empty and its exit evidence is
valid. The command does not inherit the node, API or signing credentials. Work that a privileged
command hands to another service or scheduler is outside the supervisor's view.

## Shared resource leases

`/api/v1/shared-resource-leases` coordinates resources that are not nodes: sorted sets of
`repo:<path>`, `provider:<name>` and `gpu:<name>` keys. Each acquisition advances an append-only fence
for every key in the set at once, and binds the set to one mission, task, operation, request
digest, action class, deadline and authenticated owner. Expiry never releases an uncertain lease.

| Variable | Purpose |
| --- | --- |
| `MAGNUS_SHARED_RESOURCE_TOKEN_SHA256`, `MAGNUS_SHARED_RESOURCE_TOKEN_DIGESTS_JSON` | Digests of the caller credentials allowed to use the API |
| `SHARED_RESOURCE_MISSION_TRUST_JSON` | Ed25519 keys of the services that sign mission assertions; a reservation needs a fresh assertion |
| `SHARED_RESOURCE_RESULT_TRUST_JSON` | Ed25519 keys of the resource owners that sign terminal evidence |
| `SHARED_RESOURCE_RECONCILIATION_SECRET` | Dedicated HMAC key for administrator reconciliation decisions |

A lease is released by the owning service's signed terminal evidence over the full fence set, or
by a fresh reconciliation decision from an administrator. An owner-signed `no_effect` is kept
distinct from an administrator-reviewed `no_effect_verified`. Replaying the exact operation or
settlement still works after the deadline; any change in identity or assertion needs fresh
verification.

## Testing

The PostgreSQL integration tests need a migrated, disposable database whose name starts with
`magnus_ideas`:

```bash
TEST_DATABASE_URL=postgresql://magnus:PASSWORD@127.0.0.1:5432/magnus_ideas_leases \
  npm test --workspace @hivemagnus/magnus-server -- --fileParallelism=false \
  src/services/command-resource-leases.integration.test.ts \
  src/sdk/node-api-client.commands.test.ts \
  src/sdk/node-api-client.reconciliation.test.ts \
  src/routes/commands.resource-auth.test.ts
```

These tests enable `MAGNUS_RESOURCE_LEASES_ENABLED` only inside their isolated fixtures. They cover
separate OS processes, transaction contention, expired approvals, overlapping generic commands,
the crash barrier before dispatch, lost replies, retention across restarts and timeouts, signed
result reconciliation and sticky enrollment. Run them serially, because their background
reconcilers share the database.
