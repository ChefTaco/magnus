# Hermes registry

The Hermes registry makes the Magnus server the source of revisions for fleet-managed Hermes
Agent skills, plugin pins, operator-owned MCP servers and per-profile tool policy. Hosts pull
their desired state on a timer and report receipts back.

The registry does not take over Hermes's bundled skills, project-local skills, or skills that come
inside a plugin; plugin skills move with their plugin's revision.

The registry is optional and off by default. See [Hermes Agent management](APP_ARCHITECTURE_HERMES.md)
for the rest of the Hermes integration.

## Configuration

On the server:

| Variable | Purpose |
| --- | --- |
| `MAGNUS_HERMES_REGISTRY_ENABLED=true` | Imports the bundled skills catalogue at startup and checks tracked plugin and MCP sources every 30 minutes |
| `MAGNUS_REGISTRY_DEPLOY_HOSTS` | Hosts that may pull deployments, with an optional rollout stage, for example `canary-1:0,node-1:1,node-2:2`. A host without a stage is stage 0. Unset means no host receives deployments. |
| `MAGNUS_REGISTRY_SUBMIT_ONLY_HOSTS` | Hosts that may submit skill captures and inventory but never receive deployments |

On each host, the agent package includes `deploy/magnus-hermes-sync.service` and
`deploy/magnus-hermes-sync.timer`. The timer runs `dist/hermes-sync.js` five minutes after the
previous run finished, with up to 45 seconds of jitter. The service holds a `flock`, so two runs
never overlap. Network or API errors back off exponentially; a failed component writes a receipt
and is retried on a later run. The timer never starts a Hermes gateway that is not running.

| Agent variable | Purpose |
| --- | --- |
| `HERMES_REGISTRY_TOKEN` | The host's registry credential. Without it the sync job does nothing. |
| `MAGNUS_HERMES_SYNC_PULL=true` | Apply desired skills, plugins and MCP releases. Without it the job only reports inventory. |

## Enrolling a host

1. Install or upgrade the agent on the host. Its package must contain `dist/hermes-sync.js`.
2. As an administrator, call `POST /api/v1/hermes-registry/clients` with the host's enrolled
   `nodeId` and `installationId`. The response contains the 64-character credential once.
   Enrolling the same installation again rotates the credential.
3. Put the credential in the agent's private `.env` as `HERMES_REGISTRY_TOKEN` (and set
   `MAGNUS_HERMES_SYNC_PULL=true` if the host is in `MAGNUS_REGISTRY_DEPLOY_HOSTS`). Do not pass it
   on a command line or leave copies on disk.
4. Install and enable the timer:

   ```bash
   sudo cp /opt/magnus-agent/node_modules/@hivemagnus/magnus-agent/deploy/magnus-hermes-sync.* /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now magnus-hermes-sync.timer
   ```

5. Check `systemctl list-timers magnus-hermes-sync.timer` and
   `journalctl -u magnus-hermes-sync.service`, then compare desired and observed revisions in
   `GET /api/v1/hermes-registry/status`.

A submit-only host can send skill captures, but its credential is rejected for the manifest,
artifact downloads, component receipts, core rollout slots and tool policy.

## Revisions and targets

A skill artifact contains `SKILL.md` and every supporting file, each with its own SHA-256 hash, and
the whole artifact is SHA-256 pinned in a numbered, immutable revision. Before applying a central
change the host captures local edits. A duplicate capture does not create a revision. A capture
against a stale base revision, from a changed installation path, or with suspicious content is
held for review; an invalid hash is rejected. Passing captures are published automatically.
Skill tags select explicit profile groups (`PUT /api/v1/hermes-registry/profile-groups/:profileId`);
an unmatched capture falls back to its author profile.

`POST /api/v1/hermes-registry/targets` assigns or pins a published revision to one installation
and, optionally, one profile. An explicit pin stays in place when later revisions arrive.

**MCP servers.** An operator-owned MCP artifact declares its source URL, exact commit, owning host,
adapter (`systemd-user-tree-v1`), health probe and rollback method (`symlink-restore-v1`). A release
is switched through a managed symlink only while its user service is active and runs from that
symlink. If the probe or restart fails, the previous release is restored. Unknown third-party MCP
endpoints are listed for onboarding and are never deployed.

**Plugins.** Plugins are inventoried by type and exact Git commit where the source is known. Local
or unknown sources stay visible for onboarding. Source updates are published automatically only if
the declared capabilities, dependencies, tools, hooks and desktop components are unchanged. A
changed surface is marked `needs-consent` and stays pinned until an administrator records consent
with evidence (`POST /api/v1/hermes-registry/revisions/:kind/:slug/:revision/consent`). Compatible
plugin releases roll out by stage: stage 0 hosts first, then each later stage once every lower
stage has applied the release. A failed receipt holds later stages.

`POST /api/v1/hermes-registry/sources/refresh` refreshes tracked sources immediately.

## Hermes core updates

The server resolves the latest stable Hermes release to an immutable commit and admits one host
at a time. The host runs Hermes's read-only update plan, takes a full backup, runs the native
stable updater, and checks the update receipt, gateway state, enabled plugins and enabled tools
before it reports back. A failed host blocks the rollout and keeps its backup and recovery
evidence. An unsupported installation stays visible for onboarding. See the
[Hermes update guide](https://hermes-agent.nousresearch.com/docs/getting-started/updating).

## Child roles

`GET /api/v1/orchestra/roles/:id/child-preview?installationId=...&profileId=...&platform=cli`
returns a role's assigned skill revisions, observed skill loading, required toolsets, the platform
tools a child actually inherits, and a briefing. Hermes's `delegate_task` inherits the parent's
tool access, so a role briefing is guidance and does not restrict permissions. See
[Hermes delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation).

## Troubleshooting

Read the failed target's receipts and the host's sync journal before retrying or unpinning. When
an MCP adapter cannot restart or fails its probe, the previous release is restored; inspect the
existing service before trying again. The registry never starts a gateway or MCP service that was
not already running.
