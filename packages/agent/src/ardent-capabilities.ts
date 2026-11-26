/**
 * What this agent's Ardent bridge supports. `studio: 1` means session-open,
 * session-bound task submission, unbuffered task streams and streamed artifacts.
 * `studio: 2` adds missions, task pause and resume, previews, development
 * history and notes, artifact manifests and session contexts (Ardent 2.2.0).
 * `studio: 3` adds skill-install, which installs a HiveSkills release onto a profile.
 * `studio: 4` adds the Ardent 3.2.0 runtime contracts: task recovery and lineage
 * reads, the task-recovery and artifact-import actions, execution context
 * passthrough, artifact transfer v2 (ranged content, renditions, manifest v2,
 * imports) and the instance reference Magnus writes into each profile.
 * `studio: 5` adds the Ardent 3.4.0 operations: the metrics read, peer credential
 * reload and management credential rotation, and task list filters.
 * `recovery`, `lineage` and `artifact_transfer` are the highest levels the
 * bridge relays; each profile reports its own, capped by these
 * (ardentProfileCapabilities in the contracts). `task_filters: 1` means the bridge
 * passes the task list filters (state, context, caller, since, until) on, which
 * `@hivemagnus/ardent-client` requires before it sends them through Magnus.
 *
 * The ping route reports the studio level and the server gates Studio actions on it, and the
 * Ardent installation report carries all of them, so both read this one constant.
 */
export const ARDENT_AGENT_CAPABILITIES = { studio: 5, recovery: 1, lineage: 1, artifact_transfer: 2, task_filters: 1 } as const;
