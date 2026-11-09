# @hivemagnus/magnus-fleet-gateway

The web terminal for the Magnus browser console. A separate small service holds the restricted SSH
key, so neither the browser nor the Magnus API process ever does. It speaks HTTP streaming with a
bearer token: no WebSockets and no tickets.

On a fully enrolled node, the gateway uses the agent's supervised terminal protocol through a
fixed Control API relay. The account is explicit (`MAGNUS_AGENT_MANAGED_TERMINAL_USER`), non-root
and has no supplementary groups. The shell runs in a time-bounded systemd cgroup, with a read-only
host filesystem, private temporary files, no privilege escalation or user-manager IPC. Closing,
expiry or agent shutdown stops the entire group before a signed node receipt releases ownership.
Input, output and shell history are not persisted. A lost proof retains ownership; it never replays
a shell. The receipt proves local process cleanup, not reversal of external network side effects.
While a terminal owns a node, exclusive commands and managed cron wait for its verified completion.

Protocol negotiation preserves older API/gateway combinations and legacy SSH terminals. The API
still never holds the gateway's SSH key, and browsers still name only a node id and PTY size.

Opening a terminal gives an authenticated browser user a shell on a fleet node, so everything here
fails closed.

## Security model

| Requirement | What happens |
|---|---|
| Identity | Oathweave resource token: issuer, JWKS signature (RS256 only), audience `magnus`, lifetime at most 15 minutes, actor `USER`, online revocation. The same verifier as the server (`@hivemagnus/magnus-oathweave`). |
| Authority | Exactly one account link with role `ADMIN`, and the `magnus:terminal` permission. Otherwise `403 FORBIDDEN`. |
| Fresh verification | To open, `auth_time` within 5 minutes. Otherwise `403 {"error":"STEP_UP_REQUIRED"}`. Missing, malformed or future values count as stale. |
| Destination | The client sends `nodeId` and PTY size. The gateway asks the API what that node is, then requires an operator-approved record naming the same host. Request bodies are strict, so a `host`, `port`, `username` or `command` is a `400`. Loopback, link-local, multicast and metadata addresses are never dialled. DNS is resolved once and the validated address is what gets dialled. |
| Host keys | Legacy SSH uses strict pinning from an approved store the server only reads. Unknown refuses before connecting; changed refuses during the handshake. Nothing is ever learned from a connection. |
| Ownership | A session belongs to one issuer, subject and Oathweave session. Anyone else gets the same `404` as an unknown id, on every verb. |
| Revocation | Re-checked every 5 seconds, the same cadence as event streams. With the verifier's 10-second cache, logout ends the shell within 15 seconds. Undelivered output is discarded. |
| Time limits | Token expiry, 15 minutes without input, 60 minutes in total, and 60 seconds with no reader attached. Output does not count as activity. |
| Capacity | 3 sessions per subject and 32 overall (configurable, with hard bounds), 10 opens per minute per subject. Slots are taken before any await. Output waiting for a reader pauses the shell at 1 MiB, and a node that keeps sending past 4 MiB loses the session. |
| Audit | Metadata only: who, which node, when, duration, outcome. Written to the Magnus audit log and to stdout. The request is recorded before anything reaches a node, so if the audit log is down there is no login. If the record after the shell starts fails, the shell ends and no handle is returned. |
| Browser | `Origin` must equal `FLEET_GATEWAY_PUBLIC_ORIGIN`. `Sec-Fetch-Site` must be `same-origin` or `none`. No CORS headers, no preflight, no credential or option in a URL except the `sessionId` handle, which grants nothing without the owner's token. |
| Input | 16 KiB of data per request, JSON bodies only, and small fixed limits on everything else, enforced while reading. |

### Choices worth reviewing

- **Five-minute freshness.** Oathweave sets `auth_time` to the session's last step-up, or its
  creation. Freshness is checked only to open: a session survives the window, bounded by the limits
  above, so a long task is not interrupted by a re-prompt.
- **Token renewal.** A browser token lives at most 15 minutes, so a session needs a later token. Any
  call by the owner carrying a newer token from the same Oathweave session replaces the one being
  watched. The session ends when the newest token expires, which is what makes a closed tab end the
  shell. A console should call `POST /terminal/renew` about once a minute. A token from another
  Oathweave session is refused, even for the same person.
- **Losing the permission.** Permissions are claims inside the token, and the online check says only
  whether the Oathweave session is alive. So removing `magnus:terminal` ends the terminal when a token
  without it arrives from that session (any call, including an open), and otherwise when the
  last token expires, at most 15 minutes later. To cut someone off immediately, revoke their
  Oathweave session: the shell ends within 15 seconds.
- **A failed identity check ends the shell.** A userinfo outage longer than the check window ends
  open terminals. This matches event streams and fails closed.
- **Account links are read at startup**, as on the server. Removing a person's link takes effect
  when the gateway restarts, which also ends every session.
- **One replica.** Sessions live in this process's memory. Run a single instance; a restart ends
  every shell and leaves their work rows `unknown`.

## Trusting a host key

The gateway never trusts on first use. A node has no terminal until an operator approves its key:

```bash
# 1. On the node itself, over a path you already trust (console, existing SSH session):
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub

# 2. From the gateway, see what the network path presents:
magnus-fleet-gateway trust scan --node-id <node id> --host node-1.example.com

# 3. If they match, approve the value read on the node. The gateway connects and confirms that the
#    node presents it, then records who approved it and under which reference:
magnus-fleet-gateway trust add --node-id <node id> --host node-1.example.com \
  --fingerprint SHA256:... --approved-by alice --approval-ref change-1234
```

`--host` must be the node's inventory hostname or address. If inventory later names a different
host, the terminal refuses with `NODE_TARGET_CHANGED`, because agents report their own address.

| Key event | Command |
|---|---|
| A node's key was replaced | `trust rotate --node-id ID --previous SHA256:old --fingerprint SHA256:new --approved-by NAME --approval-ref REF` |
| Approve another of the node's keys | `trust extra --node-id ID --fingerprint SHA256:... --approved-by NAME --approval-ref REF` |
| Remove a node | `trust remove --node-id ID --approved-by NAME --approval-ref REF` |
| Review approvals | `trust list` |

A refused changed key is audited with the fingerprint that was presented, so an operator can compare
it. A damaged store, or one with the wrong owner or permissions, refuses every connection.

## HTTP API

Every call needs `Authorization: Bearer <token>`. Refusals are `{ "error": "CODE", "message": "..." }`.

| Method and path | Body | Success |
|---|---|---|
| `POST /terminal/open` | `{ nodeId, cols?, rows? }` (cols 1-500, rows 1-200) | `201 { sessionId, nodeId, openedAt, expiresAt, idleTimeoutSeconds, maxLifetimeSeconds }` |
| `GET /terminal/stream?sessionId=` | | `200`, raw bytes as `application/octet-stream`. One reader: a newer one replaces it. |
| `POST /terminal/input` | `{ sessionId, data }` (1 to 16 KiB) | `200 { ok: true }` |
| `POST /terminal/resize` | `{ sessionId, cols, rows }` | `200 { ok: true }` |
| `POST /terminal/renew` | `{ sessionId }` | `200 { ok: true, tokenExpiresAt }` |
| `POST /terminal/close` | `{ sessionId }` | `200 { ok: true }` |
| `GET /terminal/status?sessionId=` | | `{ state: "open", nodeId, idleDeadline, expiresAt }` or `{ state: "ended", reason }` for five minutes after the end |

| Status | Code | Meaning |
|---|---|---|
| 400 | `INVALID_REQUEST`, `CREDENTIAL_IN_URL` | Malformed, an unknown field, or a query option |
| 401 | `UNAUTHORIZED` | The token failed verification |
| 403 | `FORBIDDEN` | No `ADMIN` link or no `magnus:terminal` |
| 403 | `STEP_UP_REQUIRED` | Verify identity again, then open again |
| 403 | `CROSS_ORIGIN_REJECTED` | Another origin |
| 404 | `SESSION_NOT_FOUND`, `NODE_NOT_FOUND` | Unknown, or not yours |
| 409 | `HOST_KEY_UNTRUSTED`, `HOST_KEY_CHANGED`, `NODE_TARGET_CHANGED`, `NODE_TARGET_REFUSED` | See above |
| 409 | `RESOURCE_ADMISSION_REFUSED` | Resource coordination refused; `reason` holds its code, such as `RESOURCE_DRAIN_REQUIRED` or `RESOURCE_SSH_UNAVAILABLE` |
| 413, 415 | `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE` | |
| 429 | `SESSION_LIMIT_REACHED`, `RATE_LIMITED`, `INPUT_BUSY` | |
| 502 | `SSH_CONNECT_FAILED` | |
| 503 | `CONTROL_API_UNAVAILABLE`, `TRUST_STORE_UNAVAILABLE`, `AUDIT_UNAVAILABLE`, `GATEWAY_STOPPING` | |

End reasons: `client-closed`, `remote-ended`, `connection-lost`, `token-revoked`, `token-expired`,
`authority-lost`, `idle-timeout`, `max-lifetime`, `detached`, `gateway-shutdown`, `audit-unavailable`,
`output-overflow`.

Machine and probe routes, which an ingress must not expose to browsers, apart from health:

| Route | Use |
|---|---|
| `GET /health` | `{ "status": "ok" }` |
| `POST /internal/resource-enrollment/drain` | The Magnus API's drain challenge, authenticated by `x-resource-drain-key` |

## Resource enrollment

The gateway is the console participant in [resource enrollment](../../docs/COMMAND_RESOURCE_LEASES.md).
Before any SSH connection it reserves and starts durable work on the API (`terminal-http`), so a
crash leaves a visible record. A shell's exit never proves that what it started has finished, so each
session stays `unknown` until reconciled, and blocks a later drain until then.

The API refuses a terminal on a node that is enrolled or draining, and everywhere while
`MAGNUS_RESOURCE_LEASES_ENABLED=true`, because enrolled SSH descendants have no completion evidence
yet. The gateway reports this as `RESOURCE_ADMISSION_REFUSED`.

## Running it

The gateway ships as the container image `ghcr.io/cheftaco/magnus-fleet-gateway`, tagged `X.Y.Z`, `X.Y`
and `X`. It is not published to npm.

```bash
magnus-fleet-gateway check        # configuration, key, trust store and API, without opening a port
magnus-fleet-gateway start
```

See [`.env.example`](.env.example) for every setting, and the [`Dockerfile`](Dockerfile) header for a
hardened `docker run`. On the Magnus server, set `FLEET_GATEWAY_URL`, `FLEET_GATEWAY_TOKEN_SHA256`
and `RESOURCE_ENROLLMENT_DASHBOARD_SECRET`, and make it trust the gateway's certificate
(`NODE_EXTRA_CA_CERTS`).

## Deploying behind an ingress

| Item | Requirement |
|---|---|
| Service | One replica of the image, reachable only from the ingress and the Magnus API, port 4310. Run with `--read-only`, `--tmpfs /tmp`, `--cap-drop ALL`, `no-new-privileges`. |
| Network | Outbound to the Magnus API, the Oathweave JWKS and userinfo endpoints, and each node's SSH port. Nothing else. |
| Key mount | The private key read-only at `FLEET_GATEWAY_SSH_PRIVATE_KEY_PATH`, not writable by group or readable by others. Its account on each node should be a dedicated restricted one. |
| Known hosts | A volume at `/var/lib/fleet-gateway/known-hosts`, owned by the `node` user (uid 1000), mode 0700. Approvals survive restarts only with it. |
| TLS | A certificate for the name the ingress and API use. Set `FLEET_GATEWAY_TLS_NAME` to that name for the health check, and `NODE_EXTRA_CA_CERTS` if it is not self-signed. |
| Secrets | `FLEET_GATEWAY_API_TOKEN` and `RESOURCE_ENROLLMENT_DASHBOARD_SECRET`: 32 or more characters, distinct. |
| Server | `FLEET_GATEWAY_URL=https://<gateway name>:4310`, `FLEET_GATEWAY_TOKEN_SHA256=<sha256 hex of FLEET_GATEWAY_API_TOKEN>`, the same `RESOURCE_ENROLLMENT_DASHBOARD_SECRET`, and `NODE_EXTRA_CA_CERTS` trusting the gateway's certificate. |
| Enrollment | With no gateway, set `RESOURCE_ENROLLMENT_DASHBOARD_PARTICIPANT=absent` on the server instead of the above. It verifies only for a node with no console work rows in any state, and refuses to start alongside `FLEET_GATEWAY_URL`. `DASHBOARD_PUBLIC_ORIGIN` no longer selects a drain target. |

The ingress exposes these browser routes and nothing else, matched exactly with their methods. It
maps `/<prefix>/terminal/<verb>` to `/terminal/<verb>` on the gateway.

```text
POST /terminal/open    POST /terminal/input   POST /terminal/resize
POST /terminal/renew   POST /terminal/close
GET  /terminal/stream  GET  /terminal/status
```

- Never route `/internal/*` or forward `x-resource-drain-key` or `x-fleet-gateway-token` from a browser.
- **Forward `Origin` and `Sec-Fetch-Site`.** An ingress that drops them silently disables the
  cross-origin check. Also forward `Authorization` and `Content-Type`. Overwrite `X-Forwarded-For` with
  exactly one client address and set `FLEET_GATEWAY_TRUST_FORWARDED_FOR=true`, or the audit records the
  ingress's address. Remove `Cookie`.
- Do not buffer or compress `/terminal/stream`: its output must flush as it arrives.
- Refuse encoded slashes, dot segments and repeated slashes before matching, as for the Magnus API.

Then approve each node's host key (see [Trusting a host key](#trusting-a-host-key)): a node with no
approval refuses every terminal.

## Console integration

- Read `capabilities.terminal` from `GET /api/v1/console/session`. False means do not offer it. True
  means a gateway is deployed and this person holds the authority; the node can still refuse.
- Send every call with the bearer token through the same-origin prefix. Send no cookies.
- `POST /terminal/open` answering `403 {"error":"STEP_UP_REQUIRED"}` means verify identity and open
  again. Do not replay an open automatically after step-up: ask the person to confirm.
- Read `GET /terminal/stream` with `fetch` and write the bytes to xterm.js. A clean end or an error
  means the shell has gone: read `GET /terminal/status` for the reason. Reconnect within 60 seconds
  after a network drop, and `/terminal/stream` delivers what was held back.
- Call `POST /terminal/renew` about once a minute with a current token. Stopping is what ends a
  session when a tab closes. Call `POST /terminal/close` on an intentional close.
- Batch keystrokes, and chunk a paste into requests of at most 16 KiB, sending each after the last
  completes. `429 INPUT_BUSY` means retry that chunk shortly.
- Show `HOST_KEY_UNTRUSTED` and `HOST_KEY_CHANGED` as an operator action, not a retry. A changed key
  can mean an attack.
- Terminal output is written by the node, so treat it as untrusted: do not load xterm addons that
  give it clipboard access or that open links without confirmation.
- A session is bound to one Oathweave session, so keep the token flow on one sign-in.

## Development

```bash
npm test                 # uses a fake SSH channel
npm run test:ssh         # real SSH against a disposable local sshd container; needs Docker
```
