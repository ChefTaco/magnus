# Observability

This guide covers what Magnus measures, suggested objectives and alerts, how long operational data
is kept, application probes, and the Hermes proxy's security event log.

## Metrics and traces

The server exports Prometheus metrics at `/metrics`, protected by the bearer token in
`METRICS_TOKEN`. The metrics are low-cardinality: request outcomes, latency by route template,
command queue age, Redis stream pending counts and consumer age, stale nodes, agent version skew,
and process and fleet gauges.

Set `OTEL_EXPORTER_OTLP_ENDPOINT` on the server or the agent to export traces over OTLP HTTP. The
agent can also forward journald logs to the server.

Read-only summaries for dashboards and agents are under `/api/v1/ops/*`: dependency health, fleet
readiness, timeline, retention, trace map, predictive maintenance, incident summary, package
security posture, Hermes effective state, Codex fleet status and application probes. Console pages
show when their data was collected and distinguish unavailable data from a real zero.

## Suggested objectives

Start with these objectives and tighten them once you have a baseline.

| Signal | Objective | Window |
| --- | ---: | ---: |
| Server successful requests | 99.9% | 30 days |
| Server p95 request latency | under 500 ms | 7 days |
| Mission Control successful loads | 99.5% | 30 days |
| Mission Control p95 server render | under 2 s | 7 days |
| Heartbeats accepted within 120 s | 99.5% of managed nodes | rolling hour |
| Command queue oldest age | under 60 s | 15 minutes |
| Agent version convergence | 95% within 30 minutes | each rollout |
| Verified database backup freshness | under 24 hours | continuous |

## Suggested alerts

| Alert | Trigger | First response |
| --- | --- | --- |
| Server unhealthy | health degraded or unreachable for 5 minutes | Check the `database` and `migration-safety` health checks, then the service journal. |
| Database backup failure | integrity check fails, checksum fails, or the newest backup is older than 24 hours | Stop deployments until a verified backup exists. |
| Redis consumer stalled | pending entries grow and the consumer is idle for more than two heartbeat intervals | Inspect Redis and the heartbeat consumer. Keep the pending entries before restarting anything. |
| Heartbeat acceptance falling | accepted nodes below 99.5% | Compare node credential fingerprints before changing agent secrets. |
| Tailscale node key expiring | a heartbeat reports node-key expiry within 30 days | Renew the key before the host loses tailnet access. |
| GPU fan saturation | a GPU fan stays at 100% for more than 8 hours with no telemetry gap over 5 minutes | Check workload, temperature, airflow and stale GPU processes before restarting jobs or the host. |
| Stale fleet rising | the stale node count grows for 10 minutes | Open the incident workspace and group the stale nodes by network or site. |
| Deployment health failure | application health or the browser smoke test fails after a deployment | Roll back the code. Do not restore the database automatically. |

The console pages for operators are `/mission-control`, `/incidents`, `/rollouts`,
`/fleet-readiness`, `/fleet-timeline`, `/retention` and `/application-operations`, plus
`/hermes-drift` and `/hermes-security` when Hermes Agent is enabled.

## Data retention

The server keeps health snapshots at full detail for 24 hours. From then until day 7 it keeps,
for each node and 15-minute bucket, the last observation plus the CPU, memory, swap and disk
extremes. Snapshots referenced by an anomaly are never expired or downsampled, so a
`normal → critical → normal` spike stays visible. GPU load and fan samples follow the 30-second
heartbeat and are kept for the same seven days; GPU alerts are computed from these stored samples,
so a server restart does not reset a fan-saturation window. Logs are kept for 30 days. Read
notifications are kept for 30 days and all notifications for at most 90 days.

| Variable | Controls |
| --- | --- |
| `HEALTH_SNAPSHOT_RETENTION_DAYS` | Health snapshot retention |
| `LOG_RETENTION_DAYS` | Log retention |
| `NOTIFICATION_READ_RETENTION_DAYS` | Retention of read notifications |
| `NOTIFICATION_MAX_RETENTION_DAYS` | Maximum retention of any notification |

The server refuses to start with inconsistent windows (for example a read-notification window
longer than the maximum). Check PostgreSQL table growth and backup duration before lengthening a
window. The `/retention` page shows row counts, the oldest records, the effective policy and the
calculated cutoffs.

Disk severity on the node list comes from the fullest workload-relevant persistent filesystem
(root, home, data and service-data volumes); known system and read-only mounts are ignored. The
node detail page lists every volume with its growth, estimated days until full, a confidence
level and capacity guidance. Forecasts look back at most 365 days and need at least three
observations.

## Application probes

The server can probe the HTTP services that run on your nodes and show them on
`/application-operations` and in dependency health. Set `MAGNUS_APPLICATION_PROBES_FILE` to a JSON
file that is a regular file (not a symlink), at most 128 KB, and not group- or world-writable.
[`examples/application-probes.json`](examples/application-probes.json) is a starting point.

| Field | Required | Meaning |
| --- | --- | --- |
| `id`, `projectId`, `serviceId` | yes | Identifiers (letters, digits, `.`, `_`, `/`, `-`) |
| `nodeId` | yes | The inventory ID of the node that runs the service |
| `baseUrl` | yes | HTTPS origin without credentials, query or path |
| `healthPath` | yes | Unauthenticated reachability check |
| `readinessPath`, `queuePath` | no | Authenticated readiness and worker-queue checks |
| `tokenEnv` | no | Name of the server environment variable that holds the probe's bearer token |
| `kind` | no | `http` (default), `workflow-queue`, `backend-pool`, `hive-router` or `hivemem` |
| `maxQueueAgeMs` | no | Queue latency limit for `workflow-queue` (default 300000) |
| `canaryModel` | no | Model expected in a `hive-router` readiness response |
| `restartService` | no | systemd unit an approved remediation plan may restart |
| `dependsOn` | no | IDs of other probes this one depends on |

A check passes when the response is JSON whose `status` is `ok`, `ready`, `healthy`, `pass` or
`online`, or whose `ok` is `true`. A `revision` or `commit` field is shown as the release revision.
Probes never follow redirects and time out after 8 seconds. If `tokenEnv` names an unset
variable, the authenticated checks report `unconfigured` instead of failing.

## Hermes proxy security events

When Hermes Agent is enabled, `/hermes-security` reads the console's bounded JSONL event log at
`.magnus/hermes-proxy-security.jsonl` in the console's data directory. It shows rejected origins,
invalid console sessions, blocked DNS destinations, rejected WebSocket paths, queue pressure,
sustained backpressure per direction (duration and peak bytes), connection durations and
correlation IDs. Events are written by a bounded, single-writer queue, and `/api/health` on the
console reports the pending and dropped event counts. The log holds proxy metadata only: no
cookies, tokens, WebSocket payloads, terminal contents or SSH credentials.

Use a correlation ID to find the matching `[hermes-ws:<id>]` entry in the console's journal. A
burst of invalid sessions right after a `SESSION_SECRET` rotation is expected until old browser
tabs sign in again; if it continues for longer than one session lifetime, investigate.
