#!/usr/bin/env bash
set -euo pipefail

CRON_USER="${CRON_USER:-root}"
MAGNUS_HOME="${MAGNUS_HOME:-/opt/magnus-api}"
ENV_FILE="${MAGNUS_ENV_FILE:-${MAGNUS_HOME}/.env}"
SCRIPT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/magnus_fleet_check.py"
SCRIPT_DEST="${MAGNUS_FLEET_CHECK_SCRIPT:-/usr/local/bin/magnus-fleet-check}"
LOG_DIR="${MAGNUS_FLEET_CHECK_LOG_DIR:-/var/log/magnus/fleet-checks}"
CRON_FILE="${MAGNUS_FLEET_CRON_FILE:-/etc/cron.d/magnus-fleet-checks}"

install -D -m 0755 "$SCRIPT_SRC" "$SCRIPT_DEST"
install -d -m 0755 "$LOG_DIR"

cat > "$CRON_FILE" <<EOF
# Magnus fleet checks, consumed by Hermes Agent via /api/v1/fleet-checks.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAGNUS_FLEET_CHECK_LOG_DIR=${LOG_DIR}
MAGNUS_ENV_FILE=${ENV_FILE}

*/5 * * * * ${CRON_USER} ${SCRIPT_DEST} --kind fleet-status --env-file ${ENV_FILE} --log-dir ${LOG_DIR} >/dev/null 2>&1
*/15 * * * * ${CRON_USER} ${SCRIPT_DEST} --kind anomaly-scan --env-file ${ENV_FILE} --log-dir ${LOG_DIR} >/dev/null 2>&1
EOF

chmod 0644 "$CRON_FILE"

echo "Installed ${SCRIPT_DEST}"
echo "Installed ${CRON_FILE}"
echo "Logs: ${LOG_DIR}"
