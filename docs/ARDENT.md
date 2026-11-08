# Ardent agents: New Agent, HiveMem and the service bridge

Magnus deploys and manages Ardent agents on fleet nodes. Each Ardent profile serves its management
API on loopback only; the node agent holds the profile token and the control API reaches the profile
through it. This guide covers creating an agent in one operation, enabling HiveMem memory, live task
streams, and how another product (such as an Ardent project workspace) uses the same bridge through
an Oathweave service identity.

Every route below needs a node agent that reports `studio: 1` in its ping features and in
`capabilities` of `GET /api/v1/ardent/installations`. An older agent answers 409
`AGENT_UPGRADE_REQUIRED`: upgrade it from the console first.

## New Agent

`POST /api/v1/ardent/agents` (ADMIN) creates, configures and starts a profile:

```json
{
  "nodeId": "node-1",
  "profile": "lead",
  "apiPort": 9911,
  "soul_md": "# Soul\n…",
  "identity_md": "# Identity\n…",
  "model": { "emberpath_alias": "general" },
  "skills": ["grounded-answers"],
  "hivemem": true,
  "artifacts_max_bytes": 67108864
}
```

- `apiPort` is optional; Magnus picks the first port from 9910 that no profile on the node uses.
- `model` is either `{ "emberpath_alias": "…" }`, served at the server's `MAGNUS_ARDENT_EMBERPATH_URL`,
  or `{ "base_url": "http://192.0.2.10:8080/v1", "model": "…" }` for any OpenAI-compatible endpoint.
  The model API key, when the endpoint needs one, stays in the profile's `.env` as
  `ARDENT_LLAMA_API_KEY`.
- `hivemem` must be `true`: every agent created this way gets HiveMem memory.
- `artifacts_max_bytes` is written as `artifacts.max_bytes` only on Ardent 2.2.0 or later; older
  runtimes skip it and say so in the `config-save` receipt.

The answer is `202 { "operationId": "…" }`. The operation runs these steps in order:

| Step | What it does |
|---|---|
| `profile-create` | `ardent init` with the chosen port |
| `service-start` | Installs and starts `ardent@<profile>.service`, because Ardent serves its management API from the running gateway |
| `identity-soul`, `identity-identity` | Writes `SOUL.md` and `IDENTITY.md` (skipped when unchanged) |
| `hivemem-enroll` | Enrolls a HiveMem agent credential and writes it to the profile (below) |
| `config-save` | Model provider, `memory.provider: hivemem`, artifact limit |
| `skill-set` | Enables each requested skill that is not enabled yet |
| `service-restart` | Activates the configuration and the credential |
| `ready-probe` | Waits until the profile answers and `memory/status` reports `ready` |

`GET /api/v1/ardent/agents/operations/:id` returns the operation with one receipt per step, and
`GET /api/v1/ardent/agents/operations/:id/stream` sends an `operation` event on connect and after each
change, then `done`. Every step is audited (`ardent.agent.step`), as are the start
(`ardent.agent.deploy`), each resume (`ardent.agent.resume`) and the finish (`ardent.agent.complete`).

A failing step stops the operation with every receipt kept. `POST
/api/v1/ardent/agents/operations/:id/resume` reruns the failed step and the ones after it; finished
steps never run again. Only one operation per profile runs at a time. An operation left running by a
server restart can be resumed once it has been idle for two minutes.

## HiveMem

Magnus enrolls one HiveMem agent per profile through HiveMem's durable actor-credential API, with the
scopes `memories:read`, `memories:write`, `sessions:read` and `sessions:write` in one workspace. The
token goes straight to the node agent, which writes it into the profile's private `.env` (mode 0600)
as `ARDENT_HIVEMEM_TOKEN`. Magnus never stores, returns or logs it. The HiveMem agent ID is
`ardent-<profile>-<digest of node and profile>`.

Configure the control API:

| Variable | Purpose |
|---|---|
| `MAGNUS_ARDENT_HIVEMEM_URL` | HTTPS HiveMem base URL (before `v1/`) that Magnus calls |
| `MAGNUS_ARDENT_HIVEMEM_ENROLLMENT_TOKEN` | HiveMem token with `admin:agents` and admin rights on the workspace. Keep it on the server |
| `MAGNUS_ARDENT_HIVEMEM_WORKSPACE_ID` | Existing workspace the agents join |
| `MAGNUS_ARDENT_HIVEMEM_AGENT_URL` | Optional: the URL agents use, when it differs (for example a suite ingress path) |
| `MAGNUS_ARDENT_HIVEMEM_CREDENTIAL_HOURS` | Credential lifetime, 1 to 720 hours (default 720) |

Without the first three, New Agent and Enable HiveMem answer 503 `HIVEMEM_ENROLLMENT_UNAVAILABLE`.
A retried step repeats its stored request, so HiveMem replays the same credential within its
fifteen-minute receipt window. After that, or when the agent ID already exists in HiveMem, the step
rotates the credential instead. HiveMem keeps the original deadline across rotations, so renew agent
credentials with the node agent's renewal entries (`MAGNUS_AGENT_RENEWAL_*`, which accept
`ARDENT_HIVEMEM_TOKEN` in Ardent profile env files) before they expire.

### Enable HiveMem on an existing agent

`POST /api/v1/ardent/installations/:nodeId/profiles/:name/hivemem` (ADMIN) backfills an agent created
before New Agent. The profile must be running. Its steps are `profile-check`, `hivemem-enroll`,
`config-save` (memory only; the model is left alone), `service-restart` and `ready-probe`, with the
same receipts, audit and resume as New Agent.

## Sessions, tasks and live streams

- `POST …/profiles/:name/action` with `{"action": "session-open", "body": {"key": "…", "reset": false}}`
  opens or resets a keyed Ardent session.
- `{"action": "task-submit", "body": {"prompt": "…", "idempotency_key": "<uuid>", "session_id": "<uuid>"}}`
  submits a task, optionally in that session. The answer proves admission only.
- `GET …/profiles/:name/tasks/:taskId/stream` relays the task's server-sent events unbuffered:
  `task.text` (the current step's text on connect), `task.delta` (live reply text), `task.event`
  (journal events, with an id) and `task.done`. Ardent ends a stream after 60 seconds, and the node
  agent ends one after 60 seconds without data. Reconnect with `after` or `Last-Event-ID` set to the
  last `task.event` id. Live text needs an Ardent that streams it; older ones send journal events only.
- `GET …/profiles/:name/artifacts/:sha256` streams artifact bytes up to the node agent's
  `MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES` (64 MiB by default).

## Service identity

A product that drives Ardent agents for people, without holding Ardent tokens or full ADMIN, uses an
Oathweave client-credentials token linked with role `ARDENT_SERVICE` and the permission
`magnus:ardent`. [The console API inventory](console-api.md#linked-service-identities) lists exactly
what it may call. In short:

- It may list profiles and installations, read profile status, skills, memory status, sessions,
  tasks and identity, open sessions, submit and cancel tasks, stream tasks, download artifacts and
  follow agent operations.
- It names the person it acts for in `x-acting-subject` (their Oathweave subject). That subject must
  have one person link on the same issuer, and the audit names that person with the service in its
  details.
- New Agent, resume and Enable HiveMem additionally need that person's link role to be `ADMIN`.

`@hivemagnus/magnus-contracts/ardent-service` publishes the routes (`ardentServiceRoutes`), request and
response schemas, `ARDENT_SERVICE_PERMISSION` and `ARDENT_ACTING_SUBJECT_HEADER`.
