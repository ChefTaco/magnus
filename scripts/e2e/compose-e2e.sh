#!/usr/bin/env bash
# Runs docker/compose.yml (server, console, PostgreSQL, Redis) with throwaway
# secrets and checks the image upgrade path: the server migrates at startup,
# both services become healthy, the console verifies the server's certificate,
# and recreating the containers (what `pull && up -d` does) keeps them healthy.
#
#   bash scripts/e2e/compose-e2e.sh [REGISTRY]   REGISTRY defaults to ghcr.io/cheftaco; CI passes "local"
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
REGISTRY=${1:-ghcr.io/cheftaco}
PROJECT="magnus-compose-e2e-$$"
WORK=$(mktemp -d)
read -r -a DC <<< "${DOCKER_COMPOSE:-docker compose}"
compose() { "${DC[@]}" -p "$PROJECT" -f "$ROOT/docker/compose.yml" --env-file "$WORK/.env" "$@"; }
cleanup() { compose down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; compose logs --no-color --tail 80 >&2 || true; exit 1; }

hash=$(docker run --rm --entrypoint node -e PASSWORD=ci-only-compose-password -w /opt/magnus-ui "$REGISTRY/magnus-ui:1" --input-type=module -e \
  "import argon2 from 'argon2'; console.log(await argon2.hash(process.env.PASSWORD, { type: argon2.argon2id }))")
(
  umask 077
  {
    for name in POSTGRES_PASSWORD REDIS_PASSWORD API_SECRET JWT_SECRET NODE_MANAGER_SECRET AUDIT_HMAC_SECRET RESULT_SIGNING_SECRET \
      LOG_INGEST_SIGNING_SECRET CREDENTIAL_ROTATION_KEY METRICS_TOKEN WEBHOOK_ENCRYPTION_KEY SESSION_SECRET CONTROL_NODE_CREDENTIAL_KEY; do
      printf '%s=%s\n' "$name" "$(openssl rand -hex 32)"
    done
    printf "DASHBOARD_ADMIN_PASSWORD_HASH='%s'\n" "$hash"
    printf 'MAGNUS_REGISTRY=%s\nMAGNUS_VERSION=1\nMAGNUS_PORT=4391\nMAGNUS_UI_PORT=3391\nMAGNUS_UPDATE_CHECK=false\n' "$REGISTRY"
  } > "$WORK/.env"
)

echo ">>> 1. The stack starts; the server migrates before it listens"
compose up -d --wait --wait-timeout 300 || fail "the stack did not become healthy"
compose logs magnus-server | grep -q '\[auto-migrate\]' || fail "the server did not run auto-migrate"
pending=$(compose exec -T magnus-server magnus-server migrations --format json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).pending.length))")
[[ $pending == 0 ]] || fail "$pending migration(s) pending after startup"

echo ">>> 2. The server answers with its certificate; the console is up"
compose cp magnus-server:/var/lib/magnus/tls/server.crt "$WORK/server.crt" >/dev/null || fail "no generated certificate"
curl -sS --fail --cacert "$WORK/server.crt" --resolve "localhost:4391:127.0.0.1" https://localhost:4391/api/v1/health >/dev/null || fail "server health"
code=$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:3391/login)
(( code < 500 )) || fail "console answered $code"
compose exec -T magnus-server sh -c 'test ! -e /var/lib/magnus-cert/server.key' || fail "the server's key was exported"

echo ">>> 3. Recreating the containers (pull && up -d) keeps the stack healthy"
compose up -d --force-recreate --wait --wait-timeout 300 || fail "the recreated stack did not become healthy"
compose logs magnus-server | grep -q 'nothing to do' || fail "auto-migrate did not find the database current"

echo "PASS: docker/compose.yml"
