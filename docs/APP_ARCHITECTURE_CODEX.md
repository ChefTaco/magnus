# Codex Agent Fleet Management

Magnus exposes Codex CLI release and ChatGPT OAuth posture at `/codex` and
`/codex/installations`. The feature is a fleet-management surface; it does not
proxy prompts or model traffic through the Control API.

Both Codex pages retain fleet totals but render detail rows or cards only for
nodes where Codex is detected and reachable. Detection covers system installs
and common user-managed Node layouts including NVM, FNM, asdf, mise, Volta,
Bun, pnpm, Nix, and Snap.

The Control API scans the managed fleet in the background and caches Codex
posture for five minutes (`CODEX_FLEET_SCAN_INTERVAL_MS=300000`). Normal UI and
agent-tool reads use that cache, so opening a Codex page does not fan out to
every node. The Refresh actions force an immediate scan, including a fresh npm
release lookup.

Cached version, update-availability, and ChatGPT OAuth posture is included in
`stats/overview` and exposed directly at `ops/codex-fleet-status`. Agents with read
access to the Magnus API (for example Ardent's Magnus Control tools) can read the
same bounded data. No API-key credentials or token values are returned.

## Authentication boundary

Every managed node keeps its own Codex home and OAuth credential store in the
home directory of `CODEX_USER`. Magnus never reads or returns token
values. The node agent starts the local `codex app-server` as that user and uses
its structured account RPCs:

- `account/read` verifies that the active account type is `chatgpt`;
- `account/logout` clears an expired or operator-revoked login;
- `account/login/start` with `chatgptDeviceCode` creates the manual device flow;
- `account/login/cancel` stops an unfinished device flow.

For the standard `~/.codex` location, the node agent sets the target user's
`HOME` and lets Codex create the directory on first use. It does not export an
explicit `CODEX_HOME` for that default path: current Codex clients reject an
explicitly configured home that does not exist, which would prevent a new host
from reaching the initial device-login state. A non-default `CODEX_HOME`
override remains explicit and must already be a valid operator-managed path.

Magnus removes `OPENAI_API_KEY` and `CODEX_ACCESS_TOKEN` from the App Server
child environment. An API-key account is reported as the wrong authentication
mode and is never treated as healthy. The device button can only initiate the
ChatGPT OAuth flow.

For expiry proof, the node agent decodes only the `exp` timestamp from the local
OAuth access-token JWT. It does not transmit the JWT, account ID, email, or
refresh token. A ChatGPT access token past that timestamp is logged out before
the installation state is returned. The resulting Control API event is audited
as `codex.auth.expired_logout`.

## Version and update flow

The node agent runs `codex --version` and compares it with the current
`@openai/codex` release reported by npm. The Control API refreshes the fleet
cache every five minutes and forces the node-local release lookup during that
scan. Release discovery uses the npm executable beside a detected user-managed
Codex client before trying system npm paths, and accepts both scalar and
one-or-more-version JSON responses from npm. If a release lookup is temporarily
unavailable, the dashboard reports that state as unknown and retains a
**Check & Update Codex** retry action. The Update action then rechecks version
and OAuth posture. Standalone clients are upgraded with their built-in
`codex update` flow so Magnus preserves the standalone release store and
launcher symlink. For npm-managed clients, Magnus installs the exact release
resolved during the check, pins the update to the prefix that owns the detected
`codex` binary, and puts that binary directory first on `PATH`. This keeps NVM
and other user-managed installations in their existing Node tree instead of
accidentally targeting the system-wide npm prefix.

## Device authorization flow

Selecting **Generate Device Code** opens an in-memory, node-local App Server
session. Magnus displays only the verification URL, one-time user code, status,
and expiry. The operator completes authorization on OpenAI's site. The dashboard
polls the node-local session through the Control API and refreshes the card when
Codex reports completion. Requests expire after fifteen minutes and can be
cancelled. Restarting the node agent intentionally cancels any pending login;
no device-code state is written to the database.

## Routes

| Surface | Route |
| --- | --- |
| Dashboard overview | `/codex` |
| Dashboard installations | `/codex/installations` |
| Control API inventory | `/api/v1/codex/installations` |
| Cached agent health posture | `/api/v1/ops/codex-fleet-status` |
| Node-local Codex manager | `/api/v1/codex/*` |

Mutations require a Magnus administrator, remain node-scoped, and are written
to the audit ledger. Browser requests continue through the dashboard's
same-origin proxy, so node-manager credentials stay server-side.

## Configuration

On each host, set `CODEX_USER` in the agent's environment to the account that owns the Codex CLI.
`CODEX_BIN` overrides the detected binary and `CODEX_HOME` a non-default Codex home. On the
server, `CODEX_FLEET_SCAN_INTERVAL_MS` sets the scan interval (default five minutes).

Do not use **Generate Device Code** on a healthy installation unless you intend to replace that
host's current login.
