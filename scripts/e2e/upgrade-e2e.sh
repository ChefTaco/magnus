#!/usr/bin/env bash
# Upgrade end-to-end test on a disposable Linux host with systemd and sudo (CI).
#
#   1. `magnus init` the published FROM release (default 1.0.3) as system services
#   2. `magnus upgrade` to the working tree's packed release: migrations, health, runtime version
#   3. install an agent with `install-service --unprivileged`; it enrolls and reports itself
#   4. `magnus-server agents upgrade` to a synthetic release: confirmed
#   5. upgrade to a synthetic agent that never heartbeats: the launcher reverts it
#   6. upgrade the server to a synthetic broken release with a migration: backup, auto-revert, restore hint
#   7. `magnus rollback` to FROM: healthy
#
# Needs: E2E_DATABASE_ADMIN_URL (PostgreSQL superuser, database name starting
# with magnus_ideas), E2E_REDIS_URL, `npm run build` done, sudo without a
# password, systemd. Destroys /opt/magnus-e2e and /opt/magnus-agent-e2e.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
FROM=${MAGNUS_E2E_FROM:-1.0.3}
VERSION=$(node -p "require('$ROOT/package.json').version")
WORK=$(mktemp -d)
PACKS=$WORK/packs
PROJECT=/opt/magnus-e2e
AGENT_DIR=/opt/magnus-agent-e2e
# Outside /tmp: the agent unit has PrivateTmp.
SYNTH=/opt/magnus-e2e-synthetic
SERVER_PORT=4610
UI_PORT=3610
NODE_BIN=$(command -v node)
SUDO=(sudo env "PATH=$PATH" "HOME=/root")
: "${E2E_DATABASE_ADMIN_URL:?}" "${E2E_REDIS_URL:?}"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { echo "FAIL: $*" >&2; dump; exit 1; }
dump() {
  sudo journalctl -u magnus-server -u magnus-ui -u magnus-agent-e2e -n 80 --no-pager 2>/dev/null | tail -120 || true
}
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log($1)})"; }
magnus() { "${SUDO[@]}" "MAGNUS_PROJECT_DIR=$PROJECT" "$NODE_BIN" "$PROJECT/current/node_modules/@hivemagnus/magnus/dist/cli.js" "$@"; }
# The services run as this user, which owns the project's env files.
server_cli() { "$NODE_BIN" "$PROJECT/current/node_modules/@hivemagnus/magnus-server/dist/cli.js" "$@" --env-file "$PROJECT/config/magnus-server.env"; }
psql_admin() { node -e "const pg=require('$ROOT/node_modules/pg');const c=new pg.Client({connectionString:process.env.E2E_DATABASE_ADMIN_URL});c.connect().then(()=>c.query(process.argv[1])).then(r=>{console.log(JSON.stringify(r.rows));return c.end()}).catch(e=>{console.error(e.message);process.exit(1)})" "$1"; }

cleanup() {
  sudo systemctl disable --now magnus-server magnus-ui magnus-agent-e2e >/dev/null 2>&1 || true
  sudo rm -rf /etc/systemd/system/magnus-server.service.d/e2e-agent-ca.conf
}
trap cleanup EXIT

step "Packing the working tree ($VERSION)"
mkdir -p "$PACKS"
for workspace in packages/contracts packages/skills packages/agent services/control-api apps/dashboard packages/magnus; do
  (cd "$ROOT/$workspace" && npm pack --ignore-scripts --silent --pack-destination "$PACKS" >/dev/null)
done
ls "$PACKS"

DB_NAME=magnus_ideas_upgrade_e2e
psql_admin "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE)" >/dev/null
psql_admin "CREATE DATABASE $DB_NAME" >/dev/null
DATABASE_URL=$(node -e "const u=new URL(process.env.E2E_DATABASE_ADMIN_URL);u.pathname='/$DB_NAME';console.log(u.toString())")

step "Installing the $VERSION engine and creating a $FROM project"
"${SUDO[@]}" rm -rf "$PROJECT" "$AGENT_DIR" "$SYNTH"
mkdir -p "$WORK/tool"
(cd "$WORK/tool" && npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund --loglevel=error \
  "$PACKS/hivemagnus-magnus-contracts-$VERSION.tgz" "$PACKS/hivemagnus-magnus-$VERSION.tgz")
"${SUDO[@]}" "$NODE_BIN" "$WORK/tool/node_modules/@hivemagnus/magnus/dist/cli.js" init --system --service-user "$USER" --dir "$PROJECT" \
  --version "$FROM" --source "$PACKS" --database-url "$DATABASE_URL" --redis-url "$E2E_REDIS_URL" --public-host localhost \
  --server-port $SERVER_PORT --ui-port $UI_PORT --admin-password ci-only-e2e-password --health-timeout 240 || fail "init $FROM"
[[ $(magnus status --json --offline | json 'v.current') == "$FROM" ]] || fail "init did not record $FROM"
curl -fsk "https://127.0.0.1:$SERVER_PORT/api/v1/health" >/dev/null || fail "$FROM server is not healthy"
sudo journalctl -u magnus-server --no-pager | grep -q EACCES && fail "the server cannot write its data directory"

step "Dry run and upgrade $FROM -> $VERSION"
magnus upgrade --dir "$PROJECT" --source "$PACKS" --to "$VERSION" --dry-run | tee "$WORK/dry-run.log"
grep -q "Upgrade $FROM -> $VERSION" "$WORK/dry-run.log" || fail "dry run did not describe the upgrade"
[[ $(magnus status --json --offline | json 'v.current') == "$FROM" ]] || fail "the dry run changed the project"
magnus upgrade --dir "$PROJECT" --source "$PACKS" --to "$VERSION" --yes --health-timeout 240 || fail "upgrade to $VERSION"
STATUS=$(magnus status --json --offline)
[[ $(json 'v.current' <<<"$STATUS") == "$VERSION" ]] || fail "current is not $VERSION"
[[ $(json 'v.serving.version' <<<"$STATUS") == "$VERSION" ]] || fail "the serving runtime is not $VERSION"
[[ $(server_cli migrations --format json | json 'v.pending.length') == 0 ]] || fail "migrations pending after the upgrade"
curl -fsk "https://127.0.0.1:$SERVER_PORT/api/v1/health" >/dev/null || fail "$VERSION server is not healthy"
code=$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$UI_PORT/login"); (( code < 500 )) || fail "console answered $code"
# magnus-server upgrade finds the project from its install path and hands over to the engine.
"${SUDO[@]}" "$NODE_BIN" "$PROJECT/current/node_modules/@hivemagnus/magnus-server/dist/cli.js" upgrade --source "$PACKS" --dry-run \
  | grep -q "Already on $VERSION" || fail "magnus-server upgrade did not delegate to the project"

step "Agent $VERSION with the upgrade launcher (unprivileged)"
id magnus-agent >/dev/null 2>&1 || sudo useradd --system --home "$AGENT_DIR" --shell /usr/sbin/nologin magnus-agent
sudo mkdir -p "$AGENT_DIR/tls" "$SYNTH"
sudo chown "$USER" "$SYNTH"
# The server records the node's routable address, so the agent's certificate names every local address;
# the server trusts it next to its own certificate through a unit drop-in.
san="DNS:localhost,IP:127.0.0.1"
for ip in $(hostname -I); do san="$san,IP:$ip"; done
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj /CN=localhost \
  -addext "subjectAltName=$san" -keyout "$WORK/agent.key" -out "$WORK/agent.crt" 2>/dev/null
sudo cp "$WORK/agent.crt" "$WORK/agent.key" "$AGENT_DIR/tls/"
sudo cp "$PROJECT/config/tls/server.crt" "$AGENT_DIR/tls/control-api-ca.crt"
sudo sh -c "cat '$PROJECT/config/tls/server.crt' '$WORK/agent.crt' > '$PROJECT/config/tls/trusted-agents.crt'"
sudo mkdir -p /etc/systemd/system/magnus-server.service.d
printf '[Service]\nEnvironment=NODE_EXTRA_CA_CERTS=%s\n' "$PROJECT/config/tls/trusted-agents.crt" | sudo tee /etc/systemd/system/magnus-server.service.d/e2e-agent-ca.conf >/dev/null
sudo systemctl daemon-reload && sudo systemctl restart magnus-server
"${SUDO[@]}" npm install --prefix "$AGENT_DIR" --omit=dev --no-audit --no-fund --loglevel=error \
  "$PACKS/hivemagnus-magnus-contracts-$VERSION.tgz" "$PACKS/hivemagnus-magnus-agent-$VERSION.tgz"
SERVER_ENV="$PROJECT/config/magnus-server.env"
secret() { sudo sed -n "s/^$1=//p" "$SERVER_ENV" | tr -d "'"; }
sudo tee "$AGENT_DIR/.env" >/dev/null <<ENV
NODE_ENV=production
CONTROL_API_URL=https://localhost:$SERVER_PORT
CONTROL_API_CA_PATH=$AGENT_DIR/tls/control-api-ca.crt
NODE_MANAGER_SECRET=$(secret NODE_MANAGER_SECRET)
RESULT_SIGNING_SECRET=$(secret RESULT_SIGNING_SECRET)
TLS_CERT_PATH=$AGENT_DIR/tls/agent.crt
TLS_KEY_PATH=$AGENT_DIR/tls/agent.key
MAGNUS_AGENT_UPGRADE_SOURCE_DIR=$SYNTH
MAGNUS_AGENT_UPGRADE_REQUIRE_PROVENANCE=false
MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS=20
ENV
sudo chgrp -R magnus-agent "$AGENT_DIR/.env" "$AGENT_DIR/tls"
sudo chmod 0640 "$AGENT_DIR/.env" "$AGENT_DIR/tls/"* && sudo chmod 0750 "$AGENT_DIR/tls"
"${SUDO[@]}" "$NODE_BIN" "$AGENT_DIR/node_modules/@hivemagnus/magnus-agent/dist/index.js" install-service --unprivileged --dir "$AGENT_DIR" \
  --unit /etc/systemd/system/magnus-agent-e2e.service || fail "install-service"
wait_for() { # description, seconds, command...
  local description=$1 seconds=$2; shift 2
  for ((i = 0; i < seconds; i += 3)); do "$@" >/dev/null 2>&1 && return 0; sleep 3; done
  fail "timed out waiting for $description"
}
agent_ready() { server_cli agents upgrade --to 1.1.1-ci --integrity "sha512-$(printf 'A%.0s' {1..86})==" --dry-run 2>/dev/null | grep -q "will upgrade"; }
wait_for "the agent to enroll with the launcher layout" 120 agent_ready

synthetic() { node "$ROOT/scripts/e2e/synthetic-release.mjs" --from "$PACKS" --out "$SYNTH" "$@" >/dev/null; chmod -R a+rX "$SYNTH"; }
integrity() { node -e "const c=require('node:crypto');console.log('sha512-'+c.createHash('sha512').update(require('node:fs').readFileSync(process.argv[1])).digest('base64'))" "$1"; }

step "Agent upgrade $VERSION -> 1.1.1-ci (confirms)"
# The unpublished $VERSION contracts come from the source directory as well.
cp "$PACKS/hivemagnus-magnus-contracts-$VERSION.tgz" "$SYNTH/"
synthetic --version 1.1.1-ci --only magnus-agent
server_cli agents upgrade --to 1.1.1-ci --integrity "$(integrity "$SYNTH/hivemagnus-magnus-agent-1.1.1-ci.tgz")" \
  | tee "$WORK/agents-1.log" || fail "agent upgrade to 1.1.1-ci"
grep -q "confirmed" "$WORK/agents-1.log" || fail "agent upgrade was not confirmed"
[[ $(sudo readlink "$AGENT_DIR/current") == versions/1.1.1-ci ]] || fail "agent ./current is not 1.1.1-ci"

step "Agent upgrade 1.1.1-ci -> 1.1.2-ci (never heartbeats: the launcher reverts it)"
synthetic --version 1.1.2-ci --only magnus-agent --agent-never-heartbeats
set +e
server_cli agents upgrade --to 1.1.2-ci --integrity "$(integrity "$SYNTH/hivemagnus-magnus-agent-1.1.2-ci.tgz")" | tee "$WORK/agents-2.log"
rc=${PIPESTATUS[0]}
set -e
(( rc != 0 )) || fail "a never-heartbeating agent upgrade reported success"
grep -q "reverted" "$WORK/agents-2.log" || fail "the agent did not report the revert"
[[ $(sudo readlink "$AGENT_DIR/current") == versions/1.1.1-ci ]] || fail "agent ./current was not reverted"
sudo grep -q '"state": "reverted"' "$AGENT_DIR/upgrade-state.json" || fail "agent upgrade state is not reverted"

step "Server upgrade $VERSION -> 1.1.3-ci (broken, with a migration: reverts)"
mkdir -p "$WORK/broken"
node "$ROOT/scripts/e2e/synthetic-release.mjs" --from "$PACKS" --out "$WORK/broken" --version 1.1.3-ci --broken-server \
  --migration 20991231000000_e2e_probe >/dev/null
set +e
magnus upgrade --dir "$PROJECT" --source "$WORK/broken" --to 1.1.3-ci --yes --health-timeout 60 2>&1 | tee "$WORK/broken.log"
rc=${PIPESTATUS[0]}
set -e
(( rc == 1 )) || fail "a broken release did not fail the upgrade (exit $rc)"
grep -q "switching back to $VERSION" "$WORK/broken.log" || fail "no automatic switch back"
grep -q 'pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL"' "$WORK/broken.log" || fail "no restore command printed"
sudo sh -c "ls '$PROJECT'/backups/*pre-upgrade-$VERSION-to-1.1.3-ci*.dump" >/dev/null || fail "no pre-upgrade dump"
STATUS=$(magnus status --json --offline)
[[ $(json 'v.current' <<<"$STATUS") == "$VERSION" && $(json 'v.serving.version' <<<"$STATUS") == "$VERSION" ]] || fail "$VERSION is not serving again"
[[ $(json 'v.history.at(-1).result' <<<"$STATUS") == reverted ]] || fail "history does not record the revert"

step "Rollback $VERSION -> $FROM"
magnus rollback --dir "$PROJECT" --health-timeout 240 || fail "rollback"
[[ $(magnus status --json --offline | json 'v.current') == "$FROM" ]] || fail "rollback did not switch to $FROM"
curl -fsk "https://127.0.0.1:$SERVER_PORT/api/v1/health" >/dev/null || fail "$FROM is not healthy after the rollback"

step "PASS: init, upgrade, agent upgrade and self-revert, broken-release revert and rollback"
