#!/bin/sh
# Container entry point for magnus-server.
#
#   magnus-server-entrypoint [magnus-server args...]   run the CLI (default: start; MAGNUS_AUTO_MIGRATE=true migrates first)
#   magnus-server-entrypoint healthcheck               probe the HTTPS listener
#
# Production requires TLS. When TLS_CERT_PATH/TLS_KEY_PATH are unset and
# MAGNUS_TLS_SELF_SIGNED=true, a self-signed certificate for
# ${MAGNUS_TLS_HOSTNAMES:-localhost} is created once under $MAGNUS_HOME/tls.
# Use it only for evaluation; mount a real certificate for anything else.
set -eu

MAGNUS_HOME="${MAGNUS_HOME:-/var/lib/magnus}"
TLS_DIR="$MAGNUS_HOME/tls"
TLS_HOSTNAMES="${MAGNUS_TLS_HOSTNAMES:-localhost}"

if [ "${MAGNUS_TLS_SELF_SIGNED:-false}" = "true" ] && [ -z "${TLS_CERT_PATH:-}" ] && [ -z "${TLS_KEY_PATH:-}" ]; then
  export TLS_CERT_PATH="$TLS_DIR/server.crt" TLS_KEY_PATH="$TLS_DIR/server.key"
fi

if [ "${1:-}" = "healthcheck" ]; then
  port="${CONTROL_API_PORT:-4000}"
  if [ -n "${TLS_CERT_PATH:-}" ]; then
    # Trust the server's own certificate for this local probe only.
    exec env NODE_EXTRA_CA_CERTS="$TLS_CERT_PATH" node -e "fetch('https://localhost:$port/').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
  fi
  exec node -e "fetch('http://127.0.0.1:$port/').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
fi

if [ "${MAGNUS_TLS_SELF_SIGNED:-false}" = "true" ] && [ "${TLS_CERT_PATH:-}" = "$TLS_DIR/server.crt" ] && [ ! -s "$TLS_CERT_PATH" ]; then
  umask 077
  mkdir -p "$TLS_DIR"
  san=""
  for name in $(printf '%s' "$TLS_HOSTNAMES" | tr ',' ' '); do
    san="${san:+$san,}DNS:$name"
  done
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 825 \
    -subj "/CN=${TLS_HOSTNAMES%%,*}" -addext "subjectAltName=$san,IP:127.0.0.1" \
    -keyout "$TLS_KEY_PATH" -out "$TLS_CERT_PATH" >/dev/null 2>&1
  echo "magnus-server: generated a self-signed certificate in $TLS_DIR (evaluation only)"
fi

# Publish only the certificate (never the key) for clients such as the console
# container, which verifies the server against it.
if [ -n "${MAGNUS_TLS_EXPORT_DIR:-}" ] && [ -n "${TLS_CERT_PATH:-}" ] && [ -s "$TLS_CERT_PATH" ]; then
  cp "$TLS_CERT_PATH" "$MAGNUS_TLS_EXPORT_DIR/server.crt.tmp" && chmod 0644 "$MAGNUS_TLS_EXPORT_DIR/server.crt.tmp" \
    && mv "$MAGNUS_TLS_EXPORT_DIR/server.crt.tmp" "$MAGNUS_TLS_EXPORT_DIR/server.crt"
fi

exec magnus-server "$@"
