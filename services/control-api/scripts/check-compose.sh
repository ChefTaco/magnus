#!/usr/bin/env bash
# Runs services/control-api/docker/compose.yml with throwaway secrets and checks that:
#   1. Compose refuses to start while a required secret is missing;
#   2. PostgreSQL, Redis and magnus-server become healthy (migrations applied);
#   3. the HTTPS listener answers, verified against the generated certificate;
#   4. Security Fusion is off by default and the server runs as a non-root user.
# The stack and its volumes are removed afterwards.
# Usage: bash services/control-api/scripts/check-compose.sh [--no-build]
# DOCKER_COMPOSE overrides the Compose command (default "docker compose") and
# MAGNUS_CHECK_PORT the loopback port (default 4390).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$HERE/docker/compose.yml"
PROJECT="magnus-server-check-$$"
PORT="${MAGNUS_CHECK_PORT:-4390}"
read -r -a DC <<< "${DOCKER_COMPOSE:-docker compose}"

case "${1:-}" in
  "") BUILD=--build ;;
  --no-build) BUILD=--no-build ;;
  *) echo "usage: $0 [--no-build]" >&2; exit 2 ;;
esac

WORK="$(mktemp -d)"
compose() { "${DC[@]}" -p "$PROJECT" -f "$COMPOSE_FILE" --env-file "$WORK/check.env" "$@"; }
cleanup() { compose down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
fail() {
  echo "FAIL: $*" >&2
  compose logs --no-color --tail 80 >&2 || true
  exit 1
}

(
  umask 077
  {
    for name in POSTGRES_PASSWORD REDIS_PASSWORD API_SECRET JWT_SECRET NODE_MANAGER_SECRET AUDIT_HMAC_SECRET \
      RESULT_SIGNING_SECRET LOG_INGEST_SIGNING_SECRET CREDENTIAL_ROTATION_KEY METRICS_TOKEN WEBHOOK_ENCRYPTION_KEY; do
      printf '%s=%s\n' "$name" "$(openssl rand -hex 32)"
    done
    printf 'MAGNUS_PORT=%s\n' "$PORT"
  } > "$WORK/check.env"
)

echo ">>> 1. Compose refuses a missing secret"
if "${DC[@]}" -p "$PROJECT" -f "$COMPOSE_FILE" --env-file /dev/null config -q >/dev/null 2>&1; then
  fail "compose config accepted an empty environment"
fi

echo ">>> 2. Start PostgreSQL, Redis and magnus-server ($BUILD)"
compose up -d "$BUILD" --wait --wait-timeout 300 || fail "the stack did not become healthy"

echo ">>> 3. The HTTPS listener answers with its own certificate"
compose cp magnus-server:/var/lib/magnus/tls/server.crt "$WORK/server.crt" >/dev/null || fail "no generated certificate"
body="$(curl -sS --fail --cacert "$WORK/server.crt" --resolve "localhost:$PORT:127.0.0.1" "https://localhost:$PORT/")" ||
  fail "the listener did not answer"
grep -q '"status":"ok"' <<< "$body" || fail "unexpected root response: $body"

echo ">>> 4. Optional features are off and the process is unprivileged"
code="$(curl -sS -o /dev/null -w '%{http_code}' --cacert "$WORK/server.crt" --resolve "localhost:$PORT:127.0.0.1" \
  "https://localhost:$PORT/api/v1/security-fusion/overview")"
[ "$code" = 404 ] || fail "Security Fusion answered $code instead of 404 while disabled"
[ "$(compose exec -T magnus-server id -u)" != 0 ] || fail "magnus-server runs as root"
compose exec -T magnus-server magnus-server-entrypoint check >/dev/null || fail "magnus-server check failed inside the container"

echo "magnus-server Compose check passed"
