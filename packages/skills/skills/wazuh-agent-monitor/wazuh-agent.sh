#!/usr/bin/env bash
# wazuh-agent-monitor — Report local Wazuh agent posture without exposing secrets
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Reports the local Wazuh agent's installation, service health, enablement,
version, and configured manager addresses. It never prints keys, enrollment
passwords, or the full agent configuration.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Concise security posture
  -v             Include service timestamps and restart count
  -vv            Include recent Wazuh service journal entries
  -vvv           Include selected non-secret systemd properties

Examples:
  $(basename "$0")
  $(basename "$0") -vv
EOF
  exit 0
}

log_v1() { [[ $VERBOSE -ge 1 ]] && echo "[DEBUG] $*" >&2 || true; }
log_v2() { [[ $VERBOSE -ge 2 ]] && echo "[TRACE] $*" >&2 || true; }
log_v3() { [[ $VERBOSE -ge 3 ]] && echo "[DETAIL] $*" >&2 || true; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage ;;
    -vvv) VERBOSE=3; shift ;;
    -vv) VERBOSE=2; shift ;;
    -v) VERBOSE=$((VERBOSE + 1)); shift ;;
    --) shift; break ;;
    -*) echo "Unknown option: $1" >&2; usage ;;
    *) echo "Unexpected argument: $1" >&2; usage ;;
  esac
done

UNIT="wazuh-agent.service"
CONFIG="/var/ossec/etc/ossec.conf"

echo "=== Wazuh Agent Posture ==="

LOAD_STATE=$(systemctl show "$UNIT" --property=LoadState --value 2>/dev/null || true)
if [[ "$LOAD_STATE" == "not-found" || -z "$LOAD_STATE" ]]; then
  PACKAGE_VERSION=$(dpkg-query -W -f='${Version}' wazuh-agent 2>/dev/null || true)
  if [[ -z "$PACKAGE_VERSION" ]]; then
    echo "Installation: not installed"
    echo "Service: not installed"
    exit 0
  fi
fi

ACTIVE=$(systemctl is-active "$UNIT" 2>/dev/null || true)
ENABLED=$(systemctl is-enabled "$UNIT" 2>/dev/null || true)
VERSION=$(dpkg-query -W -f='${Version}' wazuh-agent 2>/dev/null || true)

echo "Installation: installed"
echo "Service: ${ACTIVE:-unknown}"
echo "Startup: ${ENABLED:-unknown}"
echo "Version: ${VERSION:-unknown}"

MANAGERS=()
if [[ -r "$CONFIG" ]]; then
  while IFS= read -r manager; do
    [[ -n "$manager" ]] && MANAGERS+=("$manager")
  done < <(sed -n 's|.*<address>[[:space:]]*\([^<[:space:]]*\)[[:space:]]*</address>.*|\1|p' "$CONFIG" | sort -u)
fi
echo "Managers: ${MANAGERS[*]:-none configured}"

if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Service Detail ---"
  systemctl show "$UNIT" --property=MainPID --property=NRestarts --property=ActiveEnterTimestamp --no-pager 2>/dev/null || true
fi

if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Recent Journal ---"
  journalctl -u "$UNIT" --no-pager -n 20 2>/dev/null || true
fi

if [[ $VERBOSE -ge 3 ]]; then
  echo "--- Systemd Properties ---"
  systemctl show "$UNIT" --property=LoadState --property=ActiveState --property=SubState --property=UnitFileState --property=ExecMainStatus --no-pager 2>/dev/null || true
fi
