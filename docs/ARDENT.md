# Ardent agents: New Agent, HiveMem and the service bridge

Magnus deploys and manages Ardent agents on fleet nodes. Each Ardent profile serves its management
API on loopback only; the node agent holds the profile token and the control API reaches the profile
through it. This guide covers creating an agent in one operation, enabling HiveMem memory, live task
streams, and how another product (such as an Ardent project workspace) uses the same bridge through
an Oathweave service identity.

Every route below needs a node agent that reports a `studio` level in its ping features and in
`capabilities` of `GET /api/v1/ardent/installations`:

| `studio` | Node agent supports |
|---|---|
| 1 | Sessions, task streams, streamed artifacts, New Agent and Enable HiveMem |
| 2 | Also missions, task pause and resume, previews, development history and notes, artifact manifests and session contexts (Ardent 2.2.0) |

A request that needs a higher level than the agent reports answers 409 `AGENT_UPGRADE_REQUIRED`:
upgrade the agent from the console first. Level 2 features also need Ardent 2.2.0 or later on the
node; an older Ardent answers 404 for their routes.

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
- `artifacts_max_bytes` (1 KiB to 64 MiB) is written as `artifacts.max_bytes`. When it is omitted, a
  new agent gets 64 MiB, the node agent's default relay cap, instead of Ardent's 2 MiB default. Only
  Ardent 2.2.0 or later has the setting; older runtimes skip it, and say so in the `config-save`
  receipt when it was requested.

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

Magnus calls HiveMem as its own service identity: an Oathweave machine client with the audience
`hivemem`, whose short-lived `client_credentials` tokens Magnus fetches and renews itself. HiveMem
links that client to a local principal (`HIVEMEM_OATHWEAVE_SERVICES_JSON`) allowed to enroll agents.
Before New Agent or Enable HiveMem starts, Magnus checks that it gets a token and that the agents'
workspace exists, creating it (owned by Magnus's principal) when it does not. A static HiveMem token
remains available for an installation without Oathweave.

Configure the control API:

| Variable | Purpose |
|---|---|
| `MAGNUS_ARDENT_HIVEMEM_URL` | HTTPS HiveMem base URL (before `v1/`) that Magnus calls |
| `MAGNUS_ARDENT_HIVEMEM_CLIENT_ID` | Oathweave machine client (audience `hivemem`) Magnus authenticates as |
| `MAGNUS_ARDENT_HIVEMEM_CLIENT_SECRET` | Its secret. Keep it on the server |
| `MAGNUS_ARDENT_HIVEMEM_TOKEN_URL` | HTTPS Oathweave token endpoint, for example `https://oathweave.example.com/api/v1/oauth/token` |
| `MAGNUS_ARDENT_HIVEMEM_SCOPE` | Optional: the permissions requested. Default `hivemem:admin:agents hivemem:workspaces:write hivemem:memories:read hivemem:memories:write hivemem:sessions:read hivemem:sessions:write` |
| `MAGNUS_ARDENT_HIVEMEM_ENROLLMENT_TOKEN` | Instead of the client: a HiveMem token with `admin:agents` and admin rights on an existing workspace. Keep it on the server |
| `MAGNUS_ARDENT_HIVEMEM_WORKSPACE_ID` | Workspace the agents join. Default `ardent-agents` with the client, which creates it; required with a token |
| `MAGNUS_ARDENT_HIVEMEM_AGENT_URL` | Optional: the URL agents use, when it differs (for example a suite ingress path) |
| `MAGNUS_ARDENT_HIVEMEM_CREDENTIAL_HOURS` | Credential lifetime, 1 to 720 hours (default 720) |

The client, its Oathweave policy and the HiveMem link belong together:

```text
# Oathweave
IAM_MACHINE_CLIENT_POLICIES={"magnus-hivemem":{"audience":"hivemem","permissions":["hivemem:admin:agents","hivemem:workspaces:write","hivemem:memories:read","hivemem:memories:write","hivemem:sessions:read","hivemem:sessions:write"],"lifetimeSeconds":300,"rotationOwner":"operator"}}
IAM_MACHINE_CLIENT_SECRETS={"magnus-hivemem":"<generated secret>"}
# HiveMem (issuer: Oathweave's native JWT_ISSUER)
HIVEMEM_OATHWEAVE_SERVICES_JSON=[{"issuer":"<JWT_ISSUER>","clientId":"magnus-hivemem","localId":"magnus","scopes":["admin:agents","workspaces:write","memories:read","memories:write","sessions:read","sessions:write"]}]
```

Merge these into existing values rather than replacing them. The Hive suite generates all of them for
a fresh installation with Magnus.

Without a URL and either the client or the token, New Agent and Enable HiveMem answer 503
`HIVEMEM_ENROLLMENT_UNAVAILABLE`. When Oathweave refuses the client they answer 503
`HIVEMEM_IDENTITY_UNAVAILABLE`, and when HiveMem refuses the workspace (the link lacks
`workspaces:write`, or an existing workspace is one Magnus does not administer) 503
`HIVEMEM_WORKSPACE_UNAVAILABLE`, before anything on the node changes. A `hivemem-enroll` step that
fails later names the same codes, or `HIVEMEM_ENROLLMENT_FAILED` with HiveMem's answer. A service
token HiveMem rejects is replaced once.

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

## Missions, pause, previews and development (studio 2)

All of these go through `POST …/profiles/:name/action`, or the profile resource reads, and need a
node agent at `studio` level 2 and Ardent 2.2.0. Magnus checks each body against the shapes in
`@hivemagnus/magnus-contracts` before it reaches the node, and the node agent and Ardent check it
again. For these actions Ardent's own 400, 404 and 409 answers come back with that status.

| Action | Body | Ardent route |
|---|---|---|
| `session-open` with `context` | `{"key": "…", "context": "direct" \| "mission" \| "preview"}` | `POST /api/v1/sessions` |
| `mission-submit` | `{"session_id"?, "objective", "mission", "context_items"?, "labels"?, "idempotency_key"}`, at most 200 KB | `POST /api/v1/missions` |
| `task-pause`, `task-resume` | none; the task ID is the `target` | `POST /api/v1/tasks/:id/pause\|resume` |
| `preview-submit` | `{"prompt", "overrides"?: {"soul"?, "identity"?, "skills_enabled"?, "model"?}, "session_id"?, "idempotency_key"?}`, at most 300 KB | `POST /api/v1/preview/tasks` |
| `development-note` | `{"kind", "title", "body", "sources"?, "author"?: "operator" \| "agent"}` | `POST /api/v1/development` |

- `mission` is an Ardent TeamMission 1.0 (`id`, `revision`, `parent_task`, `constraints`,
  `allowed_actions`, `resources`, `deadline`, `acceptance_criteria`, `expected_artifacts`). Its
  `resources` grant tools (`tool:artifact_write`, …) and project memory (`project:<id>`). Context
  items may hold 64 KiB of text in all. A mission's `session_id` must come from a session opened with
  context `mission`; a direct session answers 400.
- Missions and previews answer a task admission (`task_id`, `state`) and stream on
  `…/tasks/:taskId/stream` like any task. Their journal adds the `task.event` kinds `mission`,
  `team_handoff`, `team_ask_user`, `team_propose_decision`, `artifact_registered`,
  `development_note`, `team_result`, `team_result_rejected`, `pause_requested`, `paused`, `resumed`
  and `preview`.
- Pause takes effect at the task's next step boundary, and its deadline keeps running. Pausing a
  finished task answers 409. Both actions answer `{task_id, state, admission: "open" | "paused"}`.
- A preview runs unsaved soul, identity, skill or model changes without writing memory, identity,
  configuration or development records; its artifacts expire after 24 hours.

Reads:

- `GET …/profiles/:name/tasks/:taskId/artifacts`: the current manifests of a task's artifacts.
- `GET …/profiles/:name/artifacts/:sha256/manifest`: the newest manifest for one digest.
- `GET …/profiles/:name/development?after=&limit=&kind=`: the agent's development history,
  `{records, next}`; pass `next` back as `after`.
- `GET …/profiles/:name/sessions?context=mission` lists sessions of one context.

The audit keeps a mission's ID, revision, session and idempotency key, a preview's session and the
names of its overrides, and a note's kind. It never records objectives, context items or identity
texts.

## Service identity

A product that drives Ardent agents for people, without holding Ardent tokens or full ADMIN, uses an
Oathweave client-credentials token linked with role `ARDENT_SERVICE` and the permission
`magnus:ardent`. [The console API inventory](console-api.md#linked-service-identities) lists exactly
what it may call. In short:

- It may list profiles and installations, read profile status, skills, memory status, sessions,
  tasks, artifact manifests, development history and identity, open sessions, submit and cancel
  tasks, submit missions, pause and resume tasks, stream tasks, download artifacts and follow agent
  operations.
- Previews and development notes need `x-acting-subject` naming a linked person of any role, or answer
  403 `ACTING_SUBJECT_REQUIRED`.
- It names the person it acts for in `x-acting-subject` (their Oathweave subject). That subject must
  have one person link on the same issuer, and the audit names that person with the service in its
  details.
- New Agent, resume and Enable HiveMem additionally need that person's link role to be `ADMIN`.
- So do agent changes: `identity-save`, `skill-set` and `config-save`, and reading `config` (as a
  person needs ADMIN to read it). Without an acting ADMIN they answer 403 `ACTING_ADMIN_REQUIRED`.
- A service's `config-save` may change only the backend and model settings, `skills.enabled` and
  `artifacts.max_bytes` (`ARDENT_SERVICE_CONFIG_PATHS`); anything else answers 403
  `CONFIG_PATH_FORBIDDEN`. A stale revision answers 409 `CONFLICT`.

Applying a draft from a product such as an agent studio:

1. `GET …/profiles/:name/identity/soul` (and `identity/identity`) for each file's `revision`, and, with
   an acting ADMIN, `GET …/profiles/:name/config` for the configuration `revision` and text.
2. `identity-save` with target `soul` or `identity` and `{text, revision}`; the answer carries the new
   identity revision.
3. `skill-set` with the skill name as target and `{enabled, revision}`, where `revision` is the
   configuration revision. Each answer's `revision` is the base for the next skill change.
4. `config-save` with `{text, revision}`: the configuration text from step 1 with only allowlisted
   values changed. It answers the new configuration revision.

Skill and configuration changes apply after the profile restarts (`activation_required`).

`@hivemagnus/magnus-contracts/ardent-service` publishes the routes (`ardentServiceRoutes`), request and
response schemas, `ARDENT_SERVICE_PERMISSION`, `ARDENT_ACTING_SUBJECT_HEADER`,
`ARDENT_SERVICE_ADMIN_ACTIONS` and `ARDENT_SERVICE_CONFIG_PATHS`.
