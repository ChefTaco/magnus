# TOOLS.md — Magnus AI Tool Reference

## Tooling contract

Magnus AI can inspect fleet state, query historical data, run guarded actions, manage scratchpad datasets.

### Invocation format

Prefer the native function-call interface supplied with the model request. When
a provider cannot emit native calls, use this text fallback:

<tool_call>
{"name":"toolName","arguments":{"example":"value"}}
</tool_call>

### Call rules

1. Use `name` and `arguments` exactly.
2. Use one `<tool_call>...</tool_call>` wrapper per tool call.
3. You may call multiple tools in the same response.
4. Prefer read-only tools first; only escalate to action tools when necessary.
5. The tool-round limit comes from the selected model profile, assistant settings,
   or request override. Stop as soon as there is enough evidence.
6. REPL scratchpad tools (`listScratchpadVariables`, `saveResult`, `transformData`, `compareSnapshots`) require an active conversation. The system injects the conversation ID automatically.
7. Some tools are approval-gated or policy-denied even if they are visible here.

## Approval and safety model

### Usually auto-allowed

Read-only fleet inspection tools, anomaly lookup, audit queries, and scratchpad transforms are normally allowed without operator approval.

### Usually approval-gated

These tools are typically routed through human approval unless policy is changed:

- `execCommand`
- `writeFile`
- `runSkill`
- `createSkillDraft`
- `forgetMemory`

### Important safety constraints

- `execCommand` blocks destructive commands such as shutdown, reboot, `rm -rf /`, and `mkfs`.
- `writeFile` is limited to safe workspace paths and only specific directories.
- `readFile` and `listDirectory` are workspace-scoped and block sensitive paths like `.env`, `.git`, `node_modules`, and database artifacts.
- `executeNaturalCommand` only returns a **preview**; execution happens later through confirmation and `execCommand`.

## Tool catalog

### Fleet health

#### `getFleetStatus()`

Returns fleet-wide node inventory and current status.

Includes:
- node count
- node IDs, names, hostnames, IPs
- node status
- OS and architecture
- last heartbeat timestamps

#### `getFleetReadiness()`

Returns stale-node, deploy-eligibility, destructive-action, agent-version, and
credential-fingerprint posture from `/api/v1/ops/readiness`.

#### `getCodexFleetStatus()`

Returns the five-minute cached Codex fleet posture from
`/api/v1/ops/codex-fleet-status`, including detected installations, installed
and current CLI versions, update availability, and ChatGPT OAuth state. Nodes
without a detected Codex installation are omitted from the detail list.

#### `getDependencyHealth()`

Returns the current Control API dependency checks from
`/api/v1/ops/dependency-health`.

#### `getFleetTimeline(limit?)`

Returns a bounded, normalized timeline of recent fleet events.

#### `getKnownFailurePatterns()`

Returns current operational failure patterns plus predictive-maintenance
context. Use the patterns as investigation guidance, not proof of root cause.

#### `summarizeIncident(nodeId?, hours?)`

Builds an incident summary from recent logs, anomalies, commands,
notifications, and related operational evidence.

#### `classifyRemediationPlan(description)`

Classifies a proposed remediation by risk and reversibility before execution.

#### `getHermesEffectiveState()`

Returns desired-versus-observed Hermes installation and skill state.

#### `getPackageSecurityPosture()`

Returns package-security posture. Treat `unknown` as missing evidence.

#### `getNodeHealth(nodeId)`

Returns the latest detailed health snapshot for one node.

Includes:
- CPU usage, core count, load average
- memory and swap usage
- disks
- network data
- services
- Cockpit availability

#### `getHealthHistory(nodeId, hours?)`

Returns time-series health snapshots for one node over a lookback window.

Useful for:
- trend analysis
- spike confirmation
- capacity drift checks

#### `getWazuhFleetStatus()`

Returns the latest non-secret Wazuh agent posture for every node: installation,
service state, enablement, version, configured manager addresses, and when the
agent last observed it. Use this for endpoint-security coverage and failed-agent
triage.

#### `getSystemUpdateFleetStatus()`

Returns automatic apt update coverage and reboot-required state for every
reporting node. Use it to find hosts with disabled or partial unattended-update
configuration and hosts that need a planned reboot to finish installed updates.

### Anomalies

#### `getActiveAnomalies()`

Returns unresolved anomalies fleet-wide.

Includes:
- total active anomalies
- severity breakdown
- per-node grouping
- affected metrics

#### `getNodeAnomalies(nodeId)`

Returns unresolved anomalies for a specific node.

Useful for:
- single-node investigation
- hotspot confirmation
- drilling into a degraded host

#### `correlateAnomalies(windowMinutes?, includeResolved?)`

Groups anomalies across nodes to detect correlated fleet-wide patterns.

Returns:
- anomaly groups
- related commands
- shared time windows
- affected nodes and metrics

#### `getAnomalyTimeline(hours?, nodeId?)`

Returns a chronological anomaly + health context timeline.

Useful for:
- root cause investigation
- before/after command analysis
- incident storytelling

### Predictions

#### `getFleetPredictions()`

Returns predictive-failure records across the fleet.

#### `getNodePredictions(nodeId)`

Returns predictive-failure records for one node. Confirm predictions against
current health, alerts, logs, and anomalies before recommending action.

### Alerts

#### `getActiveAlerts()`

Returns active alert rule violations.

Includes:
- rule name
- metric
- threshold
- current value
- node
- severity

### Commands and execution

#### `getRecentCommands(hours?)`

Returns recently created remote commands.

Includes:
- command text
- node
- status
- exit code
- duration
- timestamp

#### `execCommand(nodeId, command, args?, workingDirectory?, timeoutSeconds?)`

Executes a guarded shell command on a fleet node.

Returns:
- node name
- command and args
- exit code
- stdout
- stderr
- duration

Notes:
- node must be online
- action is audit-logged
- destructive commands are blocked
- typically approval-gated

#### `executeNaturalCommand(intent, nodeName?)`

Translates natural language intent into a command preview.

Returns:
- preview command
- args
- full command string
- target node
- whether confirmation is required

Supported intent families include:
- service management
- package management
- log access
- disk inspection
- network diagnostics
- process inspection
- uptime and memory checks

### Logs and audit

#### `getNodeLogs(nodeId, lines?)`

Returns recent database-backed logs for a node.

Includes:
- source
- level
- message
- timestamp

#### `getAuditLog(date?, action?, limit?)`

Queries audit log events.

Useful for:
- tracing command execution
- deployment history
- operator activity review
- approval auditing

### Search and discovery

#### `searchNodes(query?, status?)`

Searches nodes by name, hostname, IP, or OS.

Supports optional status filtering.

#### `getNodeDetails(nodeId, includeSoftwareVersions?)`

Returns a richer node dossier.

Includes:
- metadata
- tags
- agent status/version
- latest health snapshot
- optional live software-version probe

### Cron and fleet stats

#### `getCronJobs(nodeId?)`

Returns scheduled cron jobs across the fleet or for one node.

Includes:
- job name
- schedule
- command
- status
- last-run metadata

#### `getDashboardStats()`

Returns aggregated operational statistics.

Includes:
- node counts by status
- command counts
- cron totals
- average CPU and memory across online nodes

### Files

#### `readFile(path)`

Reads a workspace file safely.

Constraints:
- under 1 MB
- must be inside workspace
- blocked from sensitive paths

#### `writeFile(path, content)`

Writes a workspace file inside approved directories.

Allowed write roots:
- `audit-logs/`
- `src/ai/`
- `skills/`

Typical use cases:
- prompt/doc updates
- skill draft output
- generated AI artifacts

#### `listDirectory(path?)`

Lists directory contents with basic metadata.

Returns:
- name
- file or directory type
- size
- modified time

### Skills

#### `getSkills()`

Returns skill bundles known to Magnus.

Includes:
- name
- version
- description
- author
- tags
- entry point
- files

#### `runSkill(nodeId, skillName, action?)`

Runs a deployed skill action on a node.

Returns:
- skill name
- action
- node ID
- exit code
- stdout
- stderr

Notes:
- node must be online
- execution is audit-logged
- typically approval-gated

#### `createSkillDraft(name, description, tags?, scriptContent)`

Creates a new skill draft in the workspace.

Generates:
- manifest/registry entry
- `run.sh`
- `README.md`

Constraints:
- skill name must be kebab-case
- fails if the skill already exists
- typically approval-gated

#### `generateRunbook(name, description, scenario, tags?)`

Creates a runbook skill draft with pre-check, action, validation, and rollback
placeholders. It is a state-changing tool, and generated content still requires
review before execution. The current tool policy determines whether approval is
required.

#### `listSkillActions(skillName?)`

Returns skill metadata plus README content for context.

Useful for:
- choosing an existing skill
- prompting the model with skill docs before execution
- understanding available actions

### Memory

#### `storeMemory(key, content, category?)`

Stores a tagged shared memory in HiveMem when the integration is configured.

Use for:
- durable operator preferences
- learned fleet patterns
- follow-up breadcrumbs

#### `recallMemories(category?, limit?)`

Semantically searches HiveMem, optionally biased by category.

#### `forgetMemory(key)`

Deletes a HiveMem memory by its returned memory ID (the parameter retains the
legacy name `key`).

Notes:
- generally approval-gated
- use sparingly because it is destructive

### REPL scratchpad

#### `listScratchpadVariables()`

Lists datasets saved in the active conversation scratchpad.

#### `saveResult(name, sourceName?, value?)`

Saves a value into the scratchpad or aliases an existing scratchpad entry.

Use for:
- preserving intermediate tool results
- naming a dataset for later comparison

#### `transformData(sourceName, operation, outputName?, field?, value?, order?)`

Transforms scratchpad data without re-querying the fleet.

Supported operations:
- `pluck`
- `sortBy`
- `filterEquals`
- `filterGreaterThan`
- `filterIncludes`
- `count`
- `sum`
- `average`

#### `compareSnapshots(leftName, rightName)`

Compares two scratchpad datasets and summarizes the differences.

Useful for:
- before/after change review
- drift comparison
- repeated heartbeat snapshot analysis


## Parameter quick reference

| Tool | Required params | Optional params |
| --- | --- | --- |
| `getFleetStatus` | none | none |
| `getFleetReadiness` | none | none |
| `getDependencyHealth` | none | none |
| `getFleetTimeline` | none | `limit` |
| `getKnownFailurePatterns` | none | none |
| `summarizeIncident` | none | `nodeId`, `hours` |
| `classifyRemediationPlan` | `description` | none |
| `getHermesEffectiveState` | none | none |
| `getPackageSecurityPosture` | none | none |
| `getNodeHealth` | `nodeId` | none |
| `getHealthHistory` | `nodeId` | `hours` |
| `getActiveAnomalies` | none | none |
| `getNodeAnomalies` | `nodeId` | none |
| `correlateAnomalies` | none | `windowMinutes`, `includeResolved` |
| `getAnomalyTimeline` | none | `hours`, `nodeId` |
| `getFleetPredictions` | none | none |
| `getNodePredictions` | `nodeId` | none |
| `getActiveAlerts` | none | none |
| `getRecentCommands` | none | `hours` |
| `execCommand` | `nodeId`, `command` | `args`, `workingDirectory`, `timeoutSeconds` |
| `executeNaturalCommand` | `intent` | `nodeName` |
| `getNodeLogs` | `nodeId` | `lines` |
| `getAuditLog` | none | `date`, `action`, `limit` |
| `searchNodes` | none | `query`, `status` |
| `getNodeDetails` | `nodeId` | `includeSoftwareVersions` |
| `getWazuhFleetStatus` | none | none |
| `getSystemUpdateFleetStatus` | none | none |
| `getCronJobs` | none | `nodeId` |
| `getDashboardStats` | none | none |
| `readFile` | `path` | none |
| `writeFile` | `path`, `content` | none |
| `listDirectory` | none | `path` |
| `getSkills` | none | none |
| `runSkill` | `nodeId`, `skillName` | `action` |
| `createSkillDraft` | `name`, `description`, `scriptContent` | `tags` |
| `generateRunbook` | `name`, `description`, `scenario` | `tags` |
| `listSkillActions` | none | `skillName` |
| `storeMemory` | `key`, `content` | `category` |
| `recallMemories` | none | `category`, `limit` |
| `forgetMemory` | `key` | none |
| `listScratchpadVariables` | none | none |
| `saveResult` | `name` | `sourceName`, `value` |
| `transformData` | `sourceName`, `operation` | `outputName`, `field`, `value`, `order` |
| `compareSnapshots` | `rightName` | `leftName` |

## Recommended operating style

1. Start broad with fleet, anomaly, or node-detail reads.
2. Narrow down with logs, command history, or correlation tools.
3. Use scratchpad tools instead of re-running identical reads.
4. Prefer `executeNaturalCommand` before `execCommand` when the user describes intent in plain language.
5. Explain why a dangerous action is needed before requesting approval.
6. When enough evidence is gathered, stop calling tools and answer clearly.
