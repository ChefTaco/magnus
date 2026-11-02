// The one table of agent upgrade problem codes. The server sorts failures with
// it, and the console, the CLI and UPGRADING.md show its cause and remedy.
// Dependency-free so browser code can import it through
// `@hivemagnus/magnus-contracts/upgrade-remedies`.

/** `release`: evidence about the release itself. `node`: this node's own state. */
export type UpgradeFailureClass = 'release' | 'node';

export interface UpgradeRemedy {
  class: UpgradeFailureClass;
  /** Same artifact everywhere: a single occurrence stops the whole run. */
  stopsRun?: boolean;
  /** Clears by itself: the run tries the node again at the end of the wave. Never set for ambiguous outcomes. */
  transient?: boolean;
  /** The request may have reached the agent: watched by request id, never retried automatically. */
  ambiguous?: boolean;
  /** An expected state that does not make a run `partial`, such as a node already on the target. */
  informational?: boolean;
  /** Not in the catalogue, for example from a newer agent: treated as node-level, and shown as unrecognised. */
  unknown?: boolean;
  cause: string;
  remedy: string;
}

export const UPGRADE_REMEDIES = {
  // Release evidence.
  SELF_UPGRADE_INTEGRITY: { class: 'release', stopsRun: true, cause: 'The downloaded tarball does not match the pinned npm integrity.', remedy: 'Do not retry. Check the registry or MAGNUS_AGENT_UPGRADE_SOURCE_DIR, and the integrity passed to the run.' },
  SELF_UPGRADE_SOURCE: { class: 'release', stopsRun: true, cause: 'The tarball is missing from MAGNUS_AGENT_UPGRADE_SOURCE_DIR.', remedy: 'Copy the exact tarball to that directory on the nodes, then retry.' },
  SELF_UPGRADE_FAILED: { class: 'release', cause: 'The package itself failed on the node: a bad tarball, an install error, missing provenance or a smoke test that failed or hung. An agent older than 1.1.8 also reports environment causes this way.', remedy: 'Read the detail and the agent log. If several nodes fail the same way, the release is at fault.' },
  SELF_UPGRADE_REVERTED: { class: 'release', cause: 'The new version crashed or stayed silent during its trial, and the launcher switched back.', remedy: 'Read the reason on the node and in the agent log. To try again, retry with allowRetryReverted (--retry-reverted).' },
  CONFIRM_TIMEOUT: { class: 'release', cause: 'The agent accepted the request, but the new version was not confirmed within its trial window.', remedy: 'Read the agent log on the node. A later report for this request is still recorded in the run.' },
  AGENT_SILENT: { class: 'release', cause: 'The agent accepted the request and then stopped sending heartbeats.', remedy: 'Check the service on the node. The launcher switches back by itself if it is running.' },

  // Ambiguous: the request may have run.
  MUTATION_OUTCOME_UNKNOWN: { class: 'node', ambiguous: true, cause: 'The request was sent and no usable answer came back.', remedy: 'The run keeps watching the node by request id. If it never reports, check the node, then reconcile the lease of the request (agent-upgrade-<requestId>).' },
  MANAGED_MUTATION_UNCERTAIN: { class: 'node', ambiguous: true, cause: 'An agent older than 1.1.8 answered that its managed request is uncertain; it does not say why.', remedy: 'Read the agent log. A stale resource fence on such an agent is repaired by raising the server side with `magnus-server agents fence NODE VALUE`, then upgrading the agent. See "When an agent can\'t be upgraded" in UPGRADING.md.' },
  OUTCOME_UNKNOWN: { class: 'node', ambiguous: true, cause: 'The agent ledger holds an unresolved receipt for this command.', remedy: 'Inspect the receipt and reconcile it with signed evidence (docs/COMMAND_RESOURCE_LEASES.md).' },
  RUN_INTERRUPTED: { class: 'node', ambiguous: true, cause: 'The server stopped watching this node when the run was interrupted.', remedy: 'A later report is recorded in the run. If the node does not report, retry it.' },

  // Node-level and transient: tried again at the end of the wave.
  SELF_UPGRADE_ENV_NETWORK: { class: 'node', transient: true, cause: 'The node could not reach the registry while fetching the new version.', remedy: 'Check the path from the node to the registry, or use MAGNUS_AGENT_UPGRADE_SOURCE_DIR, then retry it.' },
  AGENT_UNREACHABLE: { class: 'node', transient: true, cause: 'The server could not open a connection to the agent.', remedy: 'Check that the agent is running and that its address and port in the inventory are correct.' },
  SELF_UPGRADE_BUSY: { class: 'node', transient: true, cause: 'The agent is already staging an upgrade or another process holds its upgrade lock.', remedy: 'Wait for it to finish, then retry the node.' },
  RESOURCE_BUSY: { class: 'node', transient: true, cause: 'Another command owns the single execution slot on the node.', remedy: 'Wait for the command to finish, then retry the node.' },
  RESOURCE_LEASE_CONFLICT: { class: 'node', transient: true, cause: 'The server holds another unsettled command lease for the node.', remedy: 'Wait for it to settle. If it stays `unknown`, run `magnus-server agents doctor --heal` or reconcile it.' },
  ENROLLMENT_AUTHORITY_UNAVAILABLE: { class: 'node', transient: true, cause: 'The agent could not reach the server to confirm its enrollment.', remedy: 'Check the path from the node to the server (CONTROL_API_URL, TLS trust).' },
  STALE_FENCE: { class: 'node', transient: true, cause: 'The agent holds a resource fence at least as high as the one the server sent, and refused without running anything.', remedy: 'The server repairs this by itself by moving its generation up, and tries the node again. Nothing to do unless the problem persists.' },
  LEASE_EXPIRED: { class: 'node', transient: true, cause: 'The command lease expired before the agent could start it; nothing ran.', remedy: 'Retry the node. If this repeats, compare the clocks of the node and the server.' },
  NOT_DISPATCHED: { class: 'node', transient: true, cause: 'The server did not send the request.', remedy: 'Read the detail, then retry the node.' },
  CHECK_FAILED: { class: 'node', transient: true, cause: 'The server could not check this node right before asking it, so it did not ask.', remedy: 'Read the detail, usually a database or Redis problem on the server, then retry the node.' },

  // Node-level: needs someone.
  LEDGER_MISSING: { class: 'node', cause: 'The agent has no command ledger, so its "no receipt" proves nothing about a lease held for it. The ledger may have moved, or the install may have been rebuilt.', remedy: 'Check AGENT_INSTALL_DIR and restore .magnus/command-receipts if it moved; the lease then settles by itself. If it is gone, Magnus has no way to settle the lease: establish by hand what the command did.' },
  LEDGER_NO_FENCE: { class: 'node', cause: 'The agent ledger holds no fence for this node, so it cannot have seen any managed request, or it was replaced.', remedy: 'Check whether .magnus/command-receipts was replaced or restored. If so, establish by hand what the command did; Magnus has no way to settle the lease.' },
  LEDGER_EVIDENCE_INCONSISTENT: { class: 'node', cause: 'The agent ledger accepted this lease\'s fence but holds no receipt and no claim for it, and a receipt is never removed.', remedy: 'Inspect .magnus/command-receipts on the node: a receipt is missing. Establish by hand what the command did; Magnus has no way to settle the lease.' },
  ENROLLMENT_MARKER_UNKNOWN: { class: 'node', cause: 'The agent could not read its managed-enrollment marker, so a mismatch cannot be ruled out.', remedy: 'Check .magnus/command-receipts/managed-enrollment.json on the node: its mode, owner and content.' },
  SELF_UPGRADE_ENV_DISK: { class: 'node', cause: 'The node ran out of disk space or quota while installing the new version.', remedy: 'Free disk space on the node, then retry it.' },
  SELF_UPGRADE_ENV_ACCESS: { class: 'node', cause: 'The node refused a write while installing the new version.', remedy: 'Run `sudo magnus-agent install-service` again on the node, which repairs ownership, then retry it.' },
  RESOURCE_ENROLLMENT_REQUIRED: { class: 'node', cause: 'Admission refused the request because the node\'s resource enrollment is not complete.', remedy: 'Complete the node\'s resource enrollment (docs/COMMAND_RESOURCE_LEASES.md).' },
  FENCE_OVERFLOW: { class: 'node', cause: 'The agent reports a resource fence above the highest value the server will adopt.', remedy: 'Stop the agent, inspect .magnus/command-receipts/fence-*.json on the node, and repair that file by hand. The server does not change its generation.' },
  FENCE_INVALID: { class: 'node', cause: 'The agent reports a resource fence that is not a decimal value for its own node.', remedy: 'Inspect .magnus/command-receipts/fence-*.json on the node.' },
  FENCE_AHEAD: { class: 'node', cause: 'The agent holds a resource fence above the server generation, so managed requests would be refused.', remedy: 'Nothing to do for an upgrade run: it repairs this at its start. `magnus-server agents doctor --heal` repairs it now.' },
  IDEMPOTENCY_CONFLICT: { class: 'node', cause: 'The agent already has a receipt for this command identifier with different input.', remedy: 'Retry the node, which uses a new identifier, and report the conflict if it repeats.' },
  LEDGER_UNAVAILABLE: { class: 'node', cause: 'The agent could not read or write its command ledger.', remedy: 'Check ownership, mode 0700 and free space of .magnus/command-receipts on the node.' },
  LEDGER_UNRESOLVED: { class: 'node', cause: 'The agent ledger holds a command with an unresolved outcome, which blocks every later managed request.', remedy: 'Reconcile that command with signed evidence (docs/COMMAND_RESOURCE_LEASES.md).' },
  LEASE_HELD: { class: 'node', cause: 'A command lease on the node is reserved, running or unknown.', remedy: 'Wait for it to finish. A lease stuck `unknown` with no receipt on the agent is settled by a run or by `magnus-server agents doctor --heal`; others need signed reconciliation.' },
  WORK_HELD: { class: 'node', cause: 'Participant work, such as a console terminal or SSH session, is still held on the node.', remedy: 'Finish or reconcile that work, then retry the node.' },
  UNMANAGED_MUTATION: { class: 'node', cause: 'The agent is enrolled for managed requests and refused a request without a valid claim.', remedy: 'Complete the node\'s resource enrollment on the server (docs/COMMAND_RESOURCE_LEASES.md), or upgrade the agent by hand.' },
  RESOURCE_CLAIM_INVALID: { class: 'node', cause: 'The server would not confirm the agent\'s claim for this request.', remedy: 'Check the enrollment and inventory host name of the node, then retry.' },
  RESOURCE_TARGET_INVALID: { class: 'node', cause: 'Admission refused the node: its inventory address changed or its health is not fresh.', remedy: 'Wait for a fresh heartbeat, or repair the inventory address.' },
  ADMISSION_FENCE_CLOSED: { class: 'node', cause: 'A server release closed admission to this node.', remedy: 'Release the admission fence (POST /api/v1/resource-leases/admission/<nodeId>/release).' },
  ENROLLMENT_MISSING: { class: 'node', cause: 'Resource leases apply to this node but it is not enrolled.', remedy: 'Enroll the node (docs/COMMAND_RESOURCE_LEASES.md).' },
  ENROLLMENT_DRAINING: { class: 'node', cause: 'The node\'s resource enrollment is stuck in draining.', remedy: 'Finish the drain: POST /api/v1/resource-leases/enrollment/<nodeId>/complete.' },
  ENROLLMENT_HOST_MISMATCH: { class: 'node', cause: 'The enrollment names another host than the inventory.', remedy: 'Correct the host name of the node in the inventory.' },
  ENROLLMENT_INCOMPLETE: { class: 'node', cause: 'The node\'s resource enrollment is not complete.', remedy: 'Enroll the node (docs/COMMAND_RESOURCE_LEASES.md).' },
  ENROLLMENT_MARKER_MISMATCH: { class: 'node', cause: 'The agent holds a local managed-enrollment marker the server does not share.', remedy: 'Complete the node\'s resource enrollment on the server (docs/COMMAND_RESOURCE_LEASES.md), or upgrade the agent by hand.' },
  NODE_OFFLINE: { class: 'node', transient: true, cause: 'The node is offline or has no recent heartbeat.', remedy: 'Bring the agent back, then retry the node.' },
  NODE_NOT_FOUND: { class: 'node', cause: 'The node is no longer in the inventory.', remedy: 'Register the node again if it should be managed.' },
  VERSION_UNKNOWN: { class: 'node', cause: 'The agent has not reported a usable version.', remedy: 'Wait for a heartbeat, or upgrade the agent by hand.' },
  SELF_UPGRADE_TIMEOUT: { class: 'node', cause: 'A step of the upgrade did not finish in its time budget on the node.', remedy: 'Check the network and disk speed of the node, then retry it.' },
  SELF_UPGRADE_UNAVAILABLE: { class: 'node', cause: 'The agent cannot upgrade itself now: its layout, launcher, directories or npm are not usable.', remedy: 'Read the detail. Running `sudo magnus-agent install-service` once on the node usually repairs it.' },
  SELF_UPGRADE_LAUNCHER: { class: 'node', cause: 'The new version needs a newer launcher than the node has.', remedy: 'Run `sudo magnus-agent install-service` once on the node.' },
  SELF_UPGRADE_ENGINE: { class: 'node', cause: 'The new version does not support the Node.js on this node.', remedy: 'Upgrade Node.js on the node.' },
  SELF_UPGRADE_PACKAGE: { class: 'node', cause: 'The agent refused to install a package other than magnus-agent.', remedy: 'Report this: the server sent an unexpected package name.' },
  SELF_UPGRADE_REFUSED: { class: 'node', cause: 'The agent refused the version change.', remedy: 'Read the detail. Crossing a major version is done by hand.' },
  PREFLIGHT_NOT_WRITABLE: { class: 'node', cause: 'The agent cannot write to its install directory.', remedy: 'Run `sudo magnus-agent install-service` again on the node, which repairs ownership.' },
  PREFLIGHT_DISK_LOW: { class: 'node', cause: 'The install directory has less free space than an upgrade needs.', remedy: 'Free disk space on the node.' },
  PREFLIGHT_NPM: { class: 'node', cause: 'npm is missing on the node or too old.', remedy: 'Install npm beside the agent\'s Node.js, or set MAGNUS_AGENT_NPM.' },
  PREFLIGHT_FROM_INCOMPLETE: { class: 'node', cause: 'The running version is not complete under versions/, so a failed upgrade could not switch back.', remedy: 'Run `sudo magnus-agent install-service` again on the node.' },
  PREFLIGHT_ENGINE: { class: 'node', cause: 'The target version does not support the Node.js on this node.', remedy: 'Upgrade Node.js on the node.' },

  NOT_REACHED: { class: 'node', cause: 'The run ended before it reached this node.', remedy: 'Retry the run, once what ended it is dealt with. This node was not asked and did not change.' },
  RUN_STOPPED: { class: 'node', cause: 'Someone stopped the run before it reached this node.', remedy: 'Retry the run when you want this node upgraded. This node was not asked and did not change.' },
  NOT_ELIGIBLE: { class: 'node', cause: 'This node became ineligible at its turn, for a reason without a code of its own.', remedy: 'Read the detail, then retry the node.' },

  // Expected states: reported, but not a problem with the run.
  ALREADY_CURRENT: { class: 'node', informational: true, cause: 'The node already runs the target version.', remedy: 'Nothing to do.' },
  SELF_UPGRADE_CURRENT: { class: 'node', informational: true, cause: 'The agent already runs the target version.', remedy: 'Nothing to do.' },
  DOWNGRADE: { class: 'node', informational: true, cause: 'The node runs a newer version than the target.', remedy: 'Nothing to do, or choose a newer target.' },
  MAJOR_VERSION: { class: 'node', informational: true, cause: 'The change crosses a major version.', remedy: 'Upgrade this node by hand.' },
  NOT_SELF_UPGRADABLE: { class: 'node', informational: true, cause: 'This agent cannot upgrade itself: it is too old, or not set up with the launcher.', remedy: 'Run `sudo magnus-agent install-service` once on the node.' },
  PROTOCOL_TOO_OLD: { class: 'node', informational: true, cause: 'The agent speaks an older self-upgrade protocol.', remedy: 'Upgrade this agent by hand.' },
  SELF_UPGRADE_DISABLED: { class: 'node', informational: true, cause: 'An operator switched self-upgrade off on this node, or it runs in a container or the legacy layout.', remedy: 'Nothing to do if that is intended. Otherwise set MAGNUS_AGENT_SELF_UPGRADE=true, pull a newer image, or run `sudo magnus-agent install-service` once.' },
  UPGRADE_IN_PROGRESS: { class: 'node', informational: true, cause: 'An upgrade is already staged or on trial on this node.', remedy: 'Wait for its trial to end.' },
  ALREADY_REVERTED: { class: 'node', informational: true, cause: 'This node already switched back from this exact version.', remedy: 'Read the reason. To try again, use allowRetryReverted (--retry-reverted).' },
  PREFLIGHT_UNAVAILABLE: { class: 'node', informational: true, cause: 'An agent older than 1.1.8 has no preflight check; heartbeat data is used instead.', remedy: 'Nothing to do: the agent gains the check when it is upgraded.' },
  PREFLIGHT_UNREACHABLE: { class: 'node', informational: true, cause: 'The preflight check got no answer. The node stays in the run, and dispatch decides.', remedy: 'Nothing to do unless the node then fails with AGENT_UNREACHABLE.' },
} as const satisfies Record<string, UpgradeRemedy>;

export type UpgradeProblemCode = keyof typeof UPGRADE_REMEDIES;

const FALLBACK: UpgradeRemedy = { class: 'node', unknown: true, cause: 'Unrecognised code: the agent or the server refused this node for a reason the catalogue does not list.', remedy: 'Read the detail and the agent log, then retry the node. An agent newer than the server can cause this.' };

/** Cause and remedy for a code; an unknown code (a newer agent, an unexpected 4xx) is a node-level problem. */
export function upgradeRemedy(code: string | null | undefined): UpgradeRemedy {
  return (code ? (UPGRADE_REMEDIES as Record<string, UpgradeRemedy>)[code] : undefined) ?? FALLBACK;
}

export const upgradeFailureClass = (code: string | null | undefined): UpgradeFailureClass => upgradeRemedy(code).class;
