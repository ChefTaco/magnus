#!/bin/sh
# Container entry point for magnus-ui.
#
#   magnus-ui-entrypoint [magnus-ui args...]   run the CLI (default: start)
#   magnus-ui-entrypoint healthcheck           probe the listener
#
# Without TLS_CERT_PATH/TLS_KEY_PATH and with MAGNUS_TLS_SELF_SIGNED=true, a
# self-signed certificate for ${MAGNUS_TLS_HOSTNAMES:-localhost} is created
# once under $MAGNUS_UI_DATA_DIR/tls (evaluation only).
set -eu

DATA_DIR="${MAGNUS_UI_DATA_DIR:-/var/lib/magnus-ui}"
TLS_DIR="$DATA_DIR/tls"
TLS_HOSTNAMES="${MAGNUS_TLS_HOSTNAMES:-localhost}"

if [ "${MAGNUS_TLS_SELF_SIGNED:-false}" = "true" ] && [ -z "${TLS_CERT_PATH:-}" ] && [ -z "${TLS_KEY_PATH:-}" ]; then
  export TLS_CERT_PATH="$TLS_DIR/server.crt" TLS_KEY_PATH="$TLS_DIR/server.key"
fi

if [ "${1:-}" = "healthcheck" ]; then
  port="${PORT:-3000}"
  if [ -n "${TLS_CERT_PATH:-}" ]; then
    exec env NODE_EXTRA_CA_CERTS="$TLS_CERT_PATH" node -e "fetch('https://localhost:$port/login').then(r => process.exit(r.status < 500 ? 0 : 1), () => process.exit(1))"
  fi
  exec node -e "fetch('http://127.0.0.1:$port/login').then(r => process.exit(r.status < 500 ? 0 : 1), () => process.exit(1))"
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
  echo "magnus-ui: generated a self-signed certificate in $TLS_DIR (evaluation only)"
fi

exec magnus-ui "$@"
