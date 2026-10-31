# Magnus UI

`@hivemagnus/magnus-ui` is the web console for the [Magnus](https://github.com/ChefTaco/magnus)
fleet control plane. It shows fleet and node inventory, runs commands, browses files and logs,
manages rollouts, cron jobs, webhooks, retention and audit, and surveys Ardent and Codex agents
on managed nodes. Hermes Agent pages and other integrations are optional.

The package ships a prebuilt Next.js standalone server and the `magnus-ui` CLI. It needs a running
Magnus Control API (`@hivemagnus/magnus-server`) and Redis.

## Requirements

- Node.js `^24.22.1` or `^26.13.0`
- A reachable Magnus Control API and its `API_SECRET`
- Redis (login throttling fails closed without it)
- A TLS certificate and key, unless you terminate TLS in front of the UI

## Install

```bash
npm install @hivemagnus/magnus-ui
# or globally
npm install --global @hivemagnus/magnus-ui
```

## Configure

Copy `.env.example` from the package (`node_modules/@hivemagnus/magnus-ui/.env.example`) to a
private file, for example `/etc/magnus-ui/magnus-ui.env` with mode `0600`, and fill it in.

Required settings:

| Variable | Purpose |
| --- | --- |
| `CONTROL_API_URL` | Magnus Control API base URL, reached server-side |
| `API_SECRET` | Must match the Control API `API_SECRET` |
| `SESSION_SECRET` | Dashboard-only session signing secret (32+ random characters) |
| `CONTROL_NODE_CREDENTIAL_KEY` | Dedicated 32+ character key for stored control-node credentials |
| `REDIS_URL` | Redis for login throttling |
| `DASHBOARD_PUBLIC_ORIGIN` | Browser origin of this UI, for example `https://magnus.example.com` |
| `DASHBOARD_ADMIN_USERNAME` | Administrator login name |
| `DASHBOARD_ADMIN_PASSWORD_HASH` | Argon2id hash of the administrator password |
| `TLS_CERT_PATH`, `TLS_KEY_PATH` | PEM certificate and key (or `MAGNUS_UI_ALLOW_HTTP=true`) |

Generate the password hash:

```bash
PASSWORD='choose-a-password' node --input-type=module -e \
  "import argon2 from 'argon2'; console.log(await argon2.hash(process.env.PASSWORD, { type: argon2.argon2id }))"
```

The node terminal and the Hermes proxy also need a dedicated unprivileged SSH identity on the
managed nodes: `DASHBOARD_SSH_USERNAME` with `DASHBOARD_SSH_PRIVATE_KEY_PATH` (or
`DASHBOARD_SSH_PASSWORD`). Without it everything else works.

`magnus-ui env-schema` lists every supported variable with its default.

## Run

```bash
magnus-ui check --env-file /etc/magnus-ui/magnus-ui.env   # validate and list integrations
magnus-ui start --env-file /etc/magnus-ui/magnus-ui.env   # start (also the default command)
```

| Option | Variable | Default |
| --- | --- | --- |
| `--env-file FILE` | | Variables already set in the environment win over the file |
| `--port N` | `PORT` | `3000` |
| `--host ADDR` | `HOST` | `0.0.0.0` |
| `--data-dir DIR` | `MAGNUS_UI_DATA_DIR` | The current directory |

`start` validates the configuration first and refuses to start when required settings are
missing. It serves HTTPS with `TLS_CERT_PATH` and `TLS_KEY_PATH`. To serve plain HTTP, for local
development or behind a TLS-terminating reverse proxy, set `MAGNUS_UI_ALLOW_HTTP=true`; the server
prints a warning. Session cookies are `Secure`, so browsers keep them only over HTTPS or on
`http://localhost`.

Runtime state (the control-node registry, Hermes SSH bindings, terminal audit and the
authentication audit log) is written under the data directory, mostly in `.magnus/`. Keep it on
persistent storage and readable only by the service account.

### systemd

`deploy/magnus-ui.service` in the package is an example unit that runs `magnus-ui start` as a
dedicated `magnus` user with state in `/var/lib/magnus-ui` and the install in `/opt/magnus-ui`.
Adjust the paths and port, then:

```bash
sudo cp deploy/magnus-ui.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now magnus-ui
```

## Optional integrations

Every integration is off until configured. When it is off its navigation entry is hidden, its
pages show how to enable it, and its proxy routes answer `503`. `magnus-ui check` shows the
current state.

| Integration | Enable with | Adds |
| --- | --- | --- |
| External security console | `MAGNUS_SECURITY_CONSOLE_URL` | Security navigation, fleet security summary, links and redirects to the console |
| Hive Router | `HIVE_ROUTER_ADMIN_URL` (optional `HIVE_ROUTER_CA_PATH`) | Embedded router admin UI at `/api/hive-router/dashboard` |
| Hive IAM login | `HIVE_OAUTH_DISCOVERY_URL`, `HIVE_OAUTH_CLIENT_ID`, `HIVE_OAUTH_ISSUER`, `HIVE_OAUTH_API_AUDIENCE` (+ `DASHBOARD_PUBLIC_ORIGIN`) | Named-user OIDC sign-in next to the local administrator |
| Hermes Agent | `MAGNUS_HERMES_ENABLED=true`, `HERMES_SSH_AUTHORIZATIONS_FILE`, `DASHBOARD_SSH_*` | Hermes installation, profile, drift and proxy-security pages, and the embedded Hermes dashboard over SSH |

## Environment reference

Every variable the runtime configuration accepts. `magnus-ui env-schema` prints the same list.

<!-- dashboard-environment:start -->
<!-- Generated from runtime-environment.mjs by scripts/check-documentation.mjs. -->
| Variable | Requirement | Default | Purpose |
| --- | --- | --- | --- |
| `CONTROL_API_URL` | Optional | `https://localhost:4000` | Default Magnus Control API target. |
| `CONTROL_API_CA_PATH` | Optional | None | Private CA bundle used for verified Control API TLS. |
| `CONTROL_API_MAX_RESPONSE_BYTES` | Optional | `1048576` | Maximum accepted Control API response size in bytes. |
| `API_SECRET` | Required | None | Server-side secret injected into Control API proxy requests. |
| `CONTROL_NODE_CREDENTIAL_KEY` | Required | None | Dedicated key for encrypted control-node credentials at rest. |
| `SESSION_SECRET` | Required; temporary legacy fallback is separately gated | None | Dedicated dashboard session signing secret. |
| `SESSION_ISSUER` | Optional | `magnus-dashboard` | Required issuer claim for dashboard session tokens. |
| `SESSION_AUDIENCE` | Optional | `magnus-dashboard-session` | Required audience claim for dashboard session tokens. |
| `ALLOW_LEGACY_SESSION_SECRET` | Optional | `false` | Temporary opt-in for the expiring JWT_SECRET session fallback. |
| `HERMES_SSH_AUTHORIZATIONS_FILE` | Required (default path shown) | `.magnus/hermes-ssh-authorizations.json` | Reviewed installation, node, address, and SSH host-key bindings. |
| `DASHBOARD_PUBLIC_ORIGIN` | Required | None | Canonical browser origin allowed to open the Hermes WebSocket bridge. |
| `HERMES_WEBSOCKET_ALLOWED_ORIGINS` | Optional | None | Comma-separated additional allowed Hermes WebSocket origins. |
| `DASHBOARD_ADMIN_USERNAME` | Required with DASHBOARD_ADMIN_PASSWORD_HASH; deployment may serialize it | None | Dedicated dashboard administrator identity. |
| `DASHBOARD_ADMIN_USERNAME_B64` | Optional | None | Serializer-managed base64 form of the dashboard administrator identity. |
| `DASHBOARD_ADMIN_PASSWORD_HASH` | Required with DASHBOARD_ADMIN_USERNAME; Argon2id only | None | Non-reusable Argon2id dashboard administrator password verifier. |
| `DASHBOARD_ADMIN_PASSWORD_HASH_B64` | Optional | None | Serializer-managed base64 form of the Argon2id verifier. |
| `DASHBOARD_ADMIN_CREDENTIAL_METADATA_B64` | Optional | None | Versioned non-secret credential purpose, rotation, fleet-password, and fingerprint-separation evidence. |
| `DASHBOARD_LOGIN_USERNAME` | Optional | None | Temporary two-phase migration source for the former dedicated dashboard login. |
| `DASHBOARD_LOGIN_PASSWORD` | Optional | None | Temporary two-phase reusable secret; rejected when equal to fleet or bootstrap credentials. |
| `REDIS_URL` | Optional | None | Durable dashboard authentication throttling and concurrency store. |
| `REDIS_PREFIX` | Optional | `magnus-` | Namespace prefix for durable Redis authentication limiter keys. |
| `AUTH_RATE_LIMIT_LABEL_KEY` | Optional | None | Optional dedicated HMAC key for de-identifying authentication limiter labels. |
| `DASHBOARD_SSH_USERNAME` | Required for the terminal and Hermes proxy | None | Dedicated, unprivileged dashboard proxy account on managed nodes. |
| `DASHBOARD_SSH_PASSWORD` | Optional | None | Optional dedicated dashboard SSH password; restricted keys are preferred. |
| `DASHBOARD_SSH_PRIVATE_KEY_PATH` | Required for the terminal and Hermes proxy (or DASHBOARD_SSH_PASSWORD) | None | Restricted dashboard-proxy private key with no deployment privileges. |
| `NEXT_PUBLIC_API_URL` | Optional | `https://localhost:4000` | Legacy build-time Control API URL; must never contain a secret. |
| `HIVE_OAUTH_DISCOVERY_URL` | Optional | None | Hive OAuth discovery URL for optional named dashboard login; HTTPS required. |
| `HIVE_OAUTH_CLIENT_ID` | Optional | None | Registered Magnus dashboard OAuth client ID. |
| `HIVE_OAUTH_CLIENT_SECRET` | Optional | None | Optional confidential OAuth client secret, kept server-side. |
| `HIVE_OAUTH_ISSUER` | Optional | None | Exact trusted Hive access-token issuer. |
| `HIVE_OAUTH_API_AUDIENCE` | Optional | None | Exact access-token audience accepted by the Control API. |
| `HIVE_OAUTH_SCOPE` | Optional | `openid profile email` | Registered named-user OAuth scopes. |
| `HIVE_ROUTER_ADMIN_URL` | Optional | None | Optional Hive Router admin plane; enables the embedded router dashboard proxy. |
| `HIVE_ROUTER_CA_PATH` | Optional | None | Optional private CA bundle for hostname-verified Hive Router TLS. |
| `MAGNUS_SECURITY_CONSOLE_URL` | Optional | None | Optional external security console; enables the Security pages and nav entry. |
| `MAGNUS_HERMES_ENABLED` | Optional | `false` | Enables the optional Hermes Agent pages, dashboard proxy and WebSocket bridge. |
| `PORT` | Optional | `3000` | Listen port for magnus-ui start. |
| `HOST` | Optional | `0.0.0.0` | Listen address for magnus-ui start. |
| `TLS_CERT_PATH` | Required unless MAGNUS_UI_ALLOW_HTTP=true | None | PEM certificate served by magnus-ui start. |
| `TLS_KEY_PATH` | Required unless MAGNUS_UI_ALLOW_HTTP=true | None | PEM private key for TLS_CERT_PATH. |
| `MAGNUS_UI_DATA_DIR` | Optional | None | Working directory for runtime state (.magnus/, terminal-audit/); magnus-ui start defaults it to the current directory. |
| `UI_SECURITY_LOG_PATH` | Optional | `.magnus/security-events.jsonl` | Append-only authentication audit log; login fails closed when it cannot be written. |
| `MAGNUS_UI_ALLOW_HTTP` | Optional | `false` | Serve plain HTTP when no TLS certificate is configured (local development or behind a TLS proxy only). |
<!-- dashboard-environment:end -->

## Develop

From a checkout of the monorepo:

```bash
npm install
npm --workspace @hivemagnus/magnus-contracts run build
cd apps/dashboard
cp .env.example .env    # point CONTROL_API_URL at a local Control API
npm run dev             # https://localhost:3000, expects ../../certs/server.{crt,key}
```

Checks: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`. Browser tests use
Playwright (`npm run test:e2e`, credentials in `TEST_USERNAME` and `TEST_PASSWORD`).

To build the package locally: `npm run build && npm pack`. `npm pack` runs `scripts/stage-package.mjs`,
which assembles the standalone server, static assets, the TLS wrapper and its runtime helpers in
`dist/app`.

## License

Apache-2.0. See [LICENSE](LICENSE).
