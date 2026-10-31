# Command receipts and recovery

Every command the server sends to a node agent has a durable receipt on that node, and each node
runs commands one at a time. If the agent crashes or a reply is lost, the receipt tells you what
is known about the command, and Magnus never runs it a second time by itself.

Receipts record what happened; they do not grant permission. Whether a command may run at all is
decided by the server's roles, approvals and remediation plans.

## Requirements

- Linux with `/usr/bin/flock` (util-linux). If it is missing, the agent refuses commands. The kernel
  lock is held through an inherited file descriptor and released when the agent process exits.
- Keep `$AGENT_INSTALL_DIR/.magnus/command-receipts` across upgrades. The directory is `0700`, and
  receipts and locks are `0600`. Never delete it to clear a lock.
- Keep `RESULT_SIGNING_SECRET` separate from `NODE_MANAGER_SECRET`. Completed receipts are verified
  with the result-signing key before they are returned or recovered, so a retained receipt needs
  the key it was signed with. Plan key rotation with that in mind; rotating a key is no reason to
  delete old receipts.
- Leave `COMMAND_RECONCILIATION_SECRET` unset until you have a reviewed process for reconciling
  uncertain commands (see below). When you set it, use an independent random value of at least 32
  characters, the same on the server and the node, and never reuse another credential. Do not give
  it to model tools, clients or logs.

The agent advertises `commandReceipts: 1` and `commandFencing: 1` when node management is enabled,
and `commandReconciliation: 1` when a reconciliation key is configured. The server checks these
capabilities before it sends a fenced request, so older agents never receive one.

## Receipt states

`GET /api/v1/commands/receipts/:commandId` on the agent requires node authentication.

| State | Meaning | What to do |
| --- | --- | --- |
| `running` | This agent process still owns the execution. | Watch the receipt. |
| `unknown` | No final result was recorded; the command may have had effects. | Investigate what ran and what changed. Never replay the command ID. |
| `completed` | A signed final result was recorded. | Read the original result. Nothing runs again. |
| `reconciled` | A separately signed attestation resolved an uncertain command. | Keep the evidence. New work uses a new command ID. |

The kernel lock serializes both execution and reconciliation across processes. After a crash the
durable `active.lock` stays in place. Recovery releases it automatically only when a verified final
receipt exists, or when no `running` receipt was ever written, which proves the command never
started. A dead PID, an elapsed timeout, an expired lease or an observed desired state does not
prove that the command stopped or had no effect.

Deadlines are checked before the command is admitted and again just before the process starts. On
timeout the agent signals the command's process group and kills it after a five-second grace
period. This is not a sandbox: a command that detaches into another session or hands work to
another service can outlive it.

## Reconciling an uncertain command

`POST /api/v1/commands/receipts/:commandId/reconcile` on the agent requires node authentication
and a signed assertion with these fields:

- `nodeFqdn`, `commandId` and the accepted `requestSha256`;
- the original `coordination` object for a fenced command: `version`, `resourceKey`, `fence` and
  `expiresAt`;
- `disposition`: `effects_verified` or `no_effect_verified`;
- `evidenceSha256`, `approvalRef` and an immutable `decisionId`;
- the assertion's `expiresAt` (epoch milliseconds) and a lowercase hex `signature`.

The signature is HMAC-SHA256 with `COMMAND_RECONCILIATION_SECRET` over the domain
`magnus.command-reconciliation.v1` and the canonical JSON defined by
`commandReconciliationSigningPayload` in the agent and the server SDK. A fresh assertion expires
within five minutes; a recorded attestation still verifies later.

Before you sign, review evidence of what the command actually did (or that it did nothing) and
that it is no longer running. A child process or a remote operation can outlive an agent crash.
The node checks the signature and the exact binding to the command, node, request and fence; it
cannot check the evidence behind the hash. `approvalRef` should point to a real approval record.

The server SDK's `reconcileCommandReceipt(assertion, expected)` submits an already signed
assertion. It never creates approvals, retries an uncertain command or runs the original command
again. If its response is lost, read the stored decision with
`getCommandReceipt(commandId, expected)`. A reconciled command ID can never be replayed, even with
a `no_effect_verified` disposition.

## Scope

Receipts coordinate commands on one node. Coordination of ownership across processes, nodes and
shared resources is covered by [command resource leases](COMMAND_RESOURCE_LEASES.md).
