#!/usr/bin/env bash
# Upgrade end-to-end test on a disposable Linux host with systemd and sudo (CI).
#
#   1. `magnus init` the published FROM release as system services (default: the release's minUpgradeFrom,
#      at least 1.0.3; 2.10.2 for 3.0.0)
#   2. `magnus upgrade` to the working tree's packed release: migrations, health, runtime version; with no
#      node yet, the start-up guard lets it start in enforce mode (the default since 3.0.0)
#   3. switch the server to an explicit (deprecated) NODE_AUTH_MODE=compat, as a fleet still on the shared
#      secret would be, and install an agent with `install-service --unprivileged`; it enrolls, reports itself
#      and binds its own node key, after which the shared node secret can no longer report as that node
#   3b. remove the setting: the server starts in enforce mode now that the node is keyed and signs its
#      evidence, refuses the shared secret and the legacy upgrade, and still reaches the agent; then rotate the
#      server key (stage, the agent pins it, promote, retire) with the agent reachable throughout
#   4. pre-seed a high fence on the agent: `agents doctor --heal` moves the server past it;
#      `magnus-server agents upgrade` to a synthetic release: confirmed
#   5. upgrade to a synthetic agent that never heartbeats: the launcher reverts it
#   6. upgrade the server to a synthetic broken release with a migration: backup, auto-revert, restore hint
#   7. `magnus restore` the pre-upgrade dump: the broken release's migration is gone, the server healthy
#   8. `magnus rollback` to FROM: healthy
#
# Needs: E2E_DATABASE_ADMIN_URL (PostgreSQL superuser, database name starting
# with magnus_ideas), E2E_REDIS_URL, `npm run build` done, sudo without a
# password, systemd. Destroys /opt/magnus-e2e and /opt/magnus-agent-e2e.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
VERSION=$(node -p "require('$ROOT/package.json').version")
# The oldest release this one upgrades from (release/<VERSION>.json minUpgradeFrom), but never older than 1.0.3.
DEFAULT_FROM=$(node -e "const fs=require('fs');const f='$ROOT/release/$VERSION.json';const m=fs.existsSync(f)&&JSON.parse(fs.readFileSync(f,'utf8')).minUpgradeFrom;
const n=v=>v.split('.').map(Number);const newer=(a,b)=>{const[x,y]=[n(a),n(b)];for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];return false};
console.log(m&&newer(m,'1.0.3')?m:'1.0.3')")
FROM=${MAGNUS_E2E_FROM:-$DEFAULT_FROM}
# Synthetic releases must sort above VERSION (a -ci prerelease of VERSION itself would be a downgrade).
IFS=. read -r V_MAJOR V_MINOR V_PATCH <<<"${VERSION%%-*}"
AGENT_OK="$V_MAJOR.$V_MINOR.$((V_PATCH + 1))-ci"
AGENT_SILENT="$V_MAJOR.$V_MINOR.$((V_PATCH + 2))-ci"
SERVER_BROKEN="$V_MAJOR.$V_MINOR.$((V_PATCH + 3))-ci"
WORK=$(mktemp -d)
PACKS=$WORK/packs
PROJECT=/opt/magnus-e2e
AGENT_DIR=/opt/magnus-agent-e2e
# Outside /tmp: the agent unit has PrivateTmp.
SYNTH=/opt/magnus-e2e-synthetic
SERVER_PORT=4610
UI_PORT=3610
NODE_BIN=$(command -v node)
SUDO=(sudo env "PATH=$PATH" "HOME=/root" ${MAGNUS_PG_DUMP:+"MAGNUS_PG_DUMP=$MAGNUS_PG_DUMP"})
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
# One query against a named database, as JSON rows.
psql_url() { DB="$1" node -e "const pg=require('$ROOT/node_modules/pg');const c=new pg.Client({connectionString:process.env.DB});c.connect().then(()=>c.query(process.argv[1])).then(r=>{console.log(JSON.stringify(r.rows));return c.end()}).catch(e=>{console.error(e.message);process.exit(1)})" "$2"; }
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
major_flags=()
if [[ ${FROM%%.*} != "$V_MAJOR" ]]; then
  if magnus upgrade --dir "$PROJECT" --source "$PACKS" --to "$VERSION" --dry-run > "$WORK/major-refusal.log" 2>&1; then
    fail "a major upgrade was accepted without explicit permission"
  fi
  grep -q 'crosses a major version' "$WORK/major-refusal.log" || fail "major upgrade refusal did not explain the required permission"
  [[ $(magnus status --json --offline | json 'v.current') == "$FROM" ]] || fail "the rejected major upgrade changed the project"
  major_flags=(--allow-major)
fi
magnus upgrade --dir "$PROJECT" --source "$PACKS" --to "$VERSION" "${major_flags[@]}" --dry-run | tee "$WORK/dry-run.log"
grep -q "Upgrade $FROM -> $VERSION" "$WORK/dry-run.log" || fail "dry run did not describe the upgrade"
[[ $(magnus status --json --offline | json 'v.current') == "$FROM" ]] || fail "the dry run changed the project"
magnus upgrade --dir "$PROJECT" --source "$PACKS" --to "$VERSION" "${major_flags[@]}" --yes --health-timeout 240 || fail "upgrade to $VERSION"
STATUS=$(magnus status --json --offline)
[[ $(json 'v.current' <<<"$STATUS") == "$VERSION" ]] || fail "current is not $VERSION"
[[ $(json 'v.serving.version' <<<"$STATUS") == "$VERSION" ]] || fail "the serving runtime is not $VERSION"
[[ $(server_cli migrations --format json | json 'v.pending.length') == 0 ]] || fail "migrations pending after the upgrade"
curl -fsk "https://127.0.0.1:$SERVER_PORT/api/v1/health" >/dev/null || fail "$VERSION server is not healthy"
code=$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$UI_PORT/login"); (( code < 500 )) || fail "console answered $code"
# No node yet: the start-up guard has nothing to protect, so the default mode (enforce) applies.
sudo journalctl -u magnus-server --no-pager | grep -q 'node-auth mode=enforce (default)' || fail "the upgraded server does not run in enforce mode by default"
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
# `magnus-server agents` reads it from the env file (init wrote the self-signed certificate there).
sudo sed -i "s#^NODE_EXTRA_CA_CERTS=.*#NODE_EXTRA_CA_CERTS=$PROJECT/config/tls/trusted-agents.crt#" "$PROJECT/config/magnus-server.env"
SERVER_ENV="$PROJECT/config/magnus-server.env"
# A fleet that still runs on the shared secret: an explicit, deprecated compat, as before 3.0.0.
set_server_mode() { sudo sed -i '/^NODE_AUTH_MODE=/d' "$SERVER_ENV"; [[ -z $1 ]] || echo "NODE_AUTH_MODE=$1" | sudo tee -a "$SERVER_ENV" >/dev/null; }
server_up() { curl -fsk "https://127.0.0.1:$SERVER_PORT/api/v1/health" >/dev/null; }
set_server_mode compat
sudo systemctl daemon-reload && sudo systemctl restart magnus-server
for ((i = 0; i < 120; i += 3)); do server_up && break; sleep 3; done
server_up || fail "the server did not start with NODE_AUTH_MODE=compat"
sudo journalctl -u magnus-server --no-pager | grep -q 'DEPRECATED: NODE_AUTH_MODE=compat is deprecated' || fail "an explicit compat did not log its deprecation"
"${SUDO[@]}" npm install --prefix "$AGENT_DIR" --omit=dev --no-audit --no-fund --loglevel=error \
  "$PACKS/hivemagnus-magnus-contracts-$VERSION.tgz" "$PACKS/hivemagnus-magnus-agent-$VERSION.tgz"
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
agent_ready() { server_cli agents upgrade --allow-prerelease --to $AGENT_OK --integrity "sha512-$(printf 'A%.0s' {1..86})==" --dry-run 2>/dev/null | grep -q "will upgrade"; }
wait_for "the agent to enroll with the launcher layout" 120 agent_ready

step "The agent binds its own node key, and the shared secret can no longer report as that node"
bound_node() { psql_url "$DATABASE_URL" "SELECT n.hostname FROM node_credentials c JOIN nodes n ON n.id = c.\"nodeId\" WHERE c.status = 'ACTIVE' AND c.origin = 'LEGACY_UPGRADE'" | json 'v.length === 1 ? v[0].hostname : (() => { throw new Error("not bound") })()'; }
wait_for "the agent to bind its node key" 120 bound_node
BOUND_HOST=$(bound_node)
[[ $(sudo stat -c %a "$AGENT_DIR/identity/node.key") == 600 ]] || fail "the node key is not mode 0600"
# Captured first: `grep -q` closing a pipe early would fail the pipeline under pipefail.
JOURNAL=$(sudo journalctl -u magnus-agent-e2e -u magnus-server --no-pager)
grep -q "Node key bound" <<<"$JOURNAL" || fail "the agent did not log its key binding"
grep -q "PRIVATE KEY" <<<"$JOURNAL" && fail "a private key reached the journal"
heartbeat_as() { curl -sk -o /dev/null -w '%{http_code}' -X POST -H "x-node-token: $(secret NODE_MANAGER_SECRET)" -H 'content-type: application/json' \
  -d "{\"agentVersion\":\"$VERSION\",\"fqdn\":\"$1\"}" "https://127.0.0.1:$SERVER_PORT/api/v1/heartbeat"; }
[[ $(heartbeat_as "$BOUND_HOST") == 401 ]] || fail "the shared node secret still reports as a node that has its own key"
signed_heartbeat() { [[ $(psql_url "$DATABASE_URL" "SELECT count(*)::int AS n FROM node_credentials WHERE \"lastUsedAt\" IS NOT NULL" | json 'v[0].n') == 1 ]]; }
wait_for "a signed heartbeat from the agent" 90 signed_heartbeat
agent_ready || fail "the server cannot reach the agent after it bound its key"

step "Enforce by default: the guard lets the server start once the node is keyed and signs its evidence"
evidence_signing() { [[ $(psql_url "$DATABASE_URL" "SELECT count(*)::int AS n FROM node_credentials WHERE status = 'ACTIVE' AND \"evidenceSigning\" = true" | json 'v[0].n') == 1 ]]; }
wait_for "the agent to report that it signs its evidence" 120 evidence_signing
set_server_mode ''
sudo systemctl restart magnus-server
wait_for "the server to start in enforce mode" 120 server_up
sudo journalctl -u magnus-server --no-pager | grep -q 'node-auth mode=enforce (default)' || fail "the server did not start in enforce mode"
# The shared secret no longer speaks for any node, and binds nothing.
[[ $(heartbeat_as "new-node.example.com") == 401 ]] || fail "enforce mode accepted a heartbeat with the shared node secret"
code=$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H "x-node-token: $(secret NODE_MANAGER_SECRET)" -H 'content-type: application/json' -d '{}' \
  "https://127.0.0.1:$SERVER_PORT/api/v1/node-enrollment/legacy-upgrade")
[[ $code == 410 ]] || fail "enforce mode did not close the legacy upgrade (answered $code)"
wait_for "the server to reach the agent with signatures only" 90 agent_ready

step "Rotate the server key: stage, the agent pins it, promote, retire; the agent stays reachable"
key_state() { server_cli node-auth server-key status --format json; }
server_cli node-auth server-key stage >/dev/null || fail "server-key stage"
NEXT_KEY=$(key_state | json 'v.next.keyId')
pins_next() { sudo sh -c "cat '$AGENT_DIR'/identity/binding-*.json" | grep -q "$NEXT_KEY"; }
wait_for "the agent to pin the staged server key" 150 pins_next
server_cli node-auth server-key promote --force --grace-hours 1 >/dev/null || fail "server-key promote"
[[ $(key_state | json 'v.active.keyId') == "$NEXT_KEY" ]] || fail "the staged key is not active after the promotion"
wait_for "the server to reach the agent with the promoted key" 60 agent_ready
# The heartbeat reply lists the promoted key first; the agent then signs for it.
signs_for_next() { [[ $(sudo sh -c "cat '$AGENT_DIR'/identity/binding-*.json" | json 'v.serverKeys[0].keyId') == "$NEXT_KEY" ]]; }
wait_for "the agent to sign for the promoted key" 150 signs_for_next
server_cli node-auth server-key retire --force >/dev/null || fail "server-key retire"
[[ $(key_state | json 'v.retired.length') == 1 ]] || fail "the replaced key was not retired"
RETIRED_AT=$(date +%s)
wait_for "the server to reach the agent after the retirement" 60 agent_ready
signed_since() { [[ $(psql_url "$DATABASE_URL" "SELECT count(*)::int AS n FROM node_credentials WHERE \"lastUsedAt\" > to_timestamp($RETIRED_AT)" | json 'v[0].n') == 1 ]]; }
wait_for "a signed heartbeat after the retirement" 180 signed_since

synthetic() { node "$ROOT/scripts/e2e/synthetic-release.mjs" --from "$PACKS" --out "$SYNTH" "$@" >/dev/null; chmod -R a+rX "$SYNTH"; }
integrity() { node -e "const c=require('node:crypto');console.log('sha512-'+c.createHash('sha512').update(require('node:fs').readFileSync(process.argv[1])).digest('base64'))" "$1"; }

step "A ledger with a fence far above the server's: the check reports it, and a repair moves the server past it"
NODE_ID=$(psql_url "$DATABASE_URL" "SELECT id FROM nodes WHERE metadata LIKE '%agentSelfUpgrade%' LIMIT 1" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d)[0].id))")
FENCE_KEY="node:$NODE_ID"
FENCE_VALUE=1789962351090
FENCE_FILE=fence-$(printf '%s' "$FENCE_KEY" | sha256sum | cut -d' ' -f1).json
LEDGER=$AGENT_DIR/.magnus/command-receipts
sudo -u magnus-agent mkdir -p "$LEDGER"
sudo chmod 700 "$LEDGER"
printf '{"resourceKey":"%s","fence":"%s"}' "$FENCE_KEY" "$FENCE_VALUE" | sudo -u magnus-agent tee "$LEDGER/$FENCE_FILE" >/dev/null
sudo chmod 600 "$LEDGER/$FENCE_FILE"
fence_generation() { psql_url "$DATABASE_URL" "SELECT generation::text AS g FROM command_resource_fences WHERE \"resourceKey\" = '$FENCE_KEY'"; }
server_cli agents doctor --nodes "$NODE_ID" --to $AGENT_OK --integrity "sha512-$(printf 'A%.0s' {1..86})==" | tee "$WORK/doctor-1.log" || fail "agents doctor"
grep -q "FENCE_AHEAD" "$WORK/doctor-1.log" || fail "agents doctor did not report the fence ahead"
[[ $(fence_generation) == "[]" ]] || fail "agents doctor changed the fence without --heal"
server_cli agents doctor --heal --nodes "$NODE_ID" --to $AGENT_OK --integrity "sha512-$(printf 'A%.0s' {1..86})==" | tee "$WORK/doctor-2.log" || fail "agents doctor --heal"
grep -q "moved the fence" "$WORK/doctor-2.log" || fail "agents doctor --heal did not repair the fence"
fence_generation | grep -q "\"$((FENCE_VALUE + 1))\"" || fail "the fence generation is not past the agent's"

step "Agent upgrade $VERSION -> $AGENT_OK (confirms)"
# The unpublished $VERSION contracts come from the source directory as well.
cp "$PACKS/hivemagnus-magnus-contracts-$VERSION.tgz" "$SYNTH/"
synthetic --version $AGENT_OK --only magnus-agent
server_cli agents upgrade --allow-prerelease --to $AGENT_OK --integrity "$(integrity "$SYNTH/hivemagnus-magnus-agent-$AGENT_OK.tgz")" \
  | tee "$WORK/agents-1.log" || fail "agent upgrade to $AGENT_OK"
grep -q "confirmed" "$WORK/agents-1.log" || fail "agent upgrade was not confirmed"
[[ $(sudo readlink "$AGENT_DIR/current") == versions/$AGENT_OK ]] || fail "agent ./current is not $AGENT_OK"
wait_for "last-good to record $AGENT_OK" 30 bash -c "[[ \$(sudo readlink '$AGENT_DIR/last-good') == versions/$AGENT_OK ]]"
[[ -z $(sudo find "$AGENT_DIR/staging" -mindepth 1 -maxdepth 1 2>/dev/null) ]] || fail "staging/ was not cleaned up"

step "Agent upgrade $AGENT_OK -> $AGENT_SILENT (never heartbeats: the launcher reverts it)"
synthetic --version $AGENT_SILENT --only magnus-agent --agent-never-heartbeats
set +e
server_cli agents upgrade --allow-prerelease --to $AGENT_SILENT --integrity "$(integrity "$SYNTH/hivemagnus-magnus-agent-$AGENT_SILENT.tgz")" | tee "$WORK/agents-2.log"
rc=${PIPESTATUS[0]}
set -e
(( rc != 0 )) || fail "a never-heartbeating agent upgrade reported success"
grep -q "reverted" "$WORK/agents-2.log" || fail "the agent did not report the revert"
[[ $(sudo readlink "$AGENT_DIR/current") == versions/$AGENT_OK ]] || fail "agent ./current was not reverted"
sudo grep -q '"state": "reverted"' "$AGENT_DIR/upgrade-state.json" || fail "agent upgrade state is not reverted"
sudo grep -q 'no confirmed heartbeat' "$AGENT_DIR/upgrade-state.json" || fail "the revert reason does not name the missing heartbeat"
[[ $(sudo readlink "$AGENT_DIR/last-good") == versions/$AGENT_OK ]] || fail "last-good moved during a failed trial"

step "Server upgrade $VERSION -> $SERVER_BROKEN (broken, with a migration: reverts)"
mkdir -p "$WORK/broken"
node "$ROOT/scripts/e2e/synthetic-release.mjs" --from "$PACKS" --out "$WORK/broken" --version $SERVER_BROKEN --broken-server \
  --migration 20991231000000_e2e_probe >/dev/null
set +e
magnus upgrade --dir "$PROJECT" --source "$WORK/broken" --to $SERVER_BROKEN --yes --health-timeout 60 2>&1 | tee "$WORK/broken.log"
rc=${PIPESTATUS[0]}
set -e
(( rc == 1 )) || fail "a broken release did not fail the upgrade (exit $rc)"
grep -q "switching back to $VERSION" "$WORK/broken.log" || fail "no automatic switch back"
grep -q "magnus restore .*pre-upgrade-$VERSION-to-$SERVER_BROKEN.*\.dump --dir $PROJECT" "$WORK/broken.log" || fail "no restore command printed"
DUMP=$(sudo sh -c "ls '$PROJECT'/backups/*pre-upgrade-$VERSION-to-$SERVER_BROKEN*.dump" | head -1)
[[ -n $DUMP ]] || fail "no pre-upgrade dump"
STATUS=$(magnus status --json --offline)
[[ $(json 'v.current' <<<"$STATUS") == "$VERSION" && $(json 'v.serving.version' <<<"$STATUS") == "$VERSION" ]] || fail "$VERSION is not serving again"
[[ $(json 'v.history.at(-1).result' <<<"$STATUS") == reverted ]] || fail "history does not record the revert"
[[ $(json 'v.inProgress' <<<"$STATUS") == null ]] || fail "the reverted upgrade left its journal behind"
[[ $(server_cli migrations --format json | json "v.unknown.map(m => m.name).join(',')") == 20991231000000_e2e_probe ]] \
  || fail "migrations does not report the broken release's migration as unknown to $VERSION"

step "Restore the pre-upgrade dump"
magnus restore "$DUMP" --dir "$PROJECT" --yes --health-timeout 240 || fail "magnus restore"
[[ $(server_cli migrations --format json | json "v.applied.includes('20991231000000_e2e_probe')") == false ]] \
  || fail "the restore kept the broken release's migration"
[[ $(magnus status --json --offline | json 'v.serving.version') == "$VERSION" ]] || fail "$VERSION is not serving after the restore"
curl -fsk "https://127.0.0.1:$SERVER_PORT/api/v1/health" >/dev/null || fail "$VERSION is not healthy after the restore"

step "Rollback $VERSION -> $FROM"
magnus rollback --dir "$PROJECT" --health-timeout 240 || fail "rollback"
[[ $(magnus status --json --offline | json 'v.current') == "$FROM" ]] || fail "rollback did not switch to $FROM"
curl -fsk "https://127.0.0.1:$SERVER_PORT/api/v1/health" >/dev/null || fail "$FROM is not healthy after the rollback"

step "PASS: init, upgrade, compat to enforce, server-key rotation, agent upgrade and self-revert, broken-release revert, restore and rollback"
