#!/usr/bin/env bash
# service-watcher — Monitor and report on systemd services on Ubuntu
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS] [SERVICE...]

Monitor systemd services and detect failures. Watches specified
services (or defaults: sshd nginx docker), reports status, restart
counts, and recent journal entries for failed units.

Positional arguments:
  SERVICE...     Services to watch (default: sshd nginx docker)

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Active/enabled status and failed units
  -v             Include restart counts and recent logs
  -vv            Include timer units and resource usage
  -vvv           Full systemctl status output for each service

Examples:
  $(basename "$0")                      # Check default services
  $(basename "$0") mysql redis nginx    # Check specific services
  $(basename "$0") -vv sshd             # Detailed sshd analysis
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
    *) break ;;
  esac
done

# Default services if none provided
if [[ $# -eq 0 ]]; then
  set -- sshd nginx docker
fi

echo "=== Service Watcher ==="

for svc in "$@"; do
  STATUS=$(systemctl is-active "$svc" 2>/dev/null || echo "unknown")
  ENABLED=$(systemctl is-enabled "$svc" 2>/dev/null || echo "unknown")
  echo "--- $svc ---"
  echo "  Active:  $STATUS"
  echo "  Enabled: $ENABLED"

  if [[ "$STATUS" == "failed" || "$STATUS" == "inactive" ]]; then
    echo "  ⚠ Service is $STATUS — checking journal"
    journalctl --no-pager -u "$svc" -n 10 --since "1h ago" 2>/dev/null | tail -5 | sed 's/^/    /' || true
  fi

  # ── Restart counts (verbose 1+) ──
  if [[ $VERBOSE -ge 1 && "$STATUS" != "unknown" ]]; then
    RESTART_COUNT=$(systemctl show "$svc" --property=NRestarts 2>/dev/null | cut -d= -f2)
    MAIN_PID=$(systemctl show "$svc" --property=MainPID 2>/dev/null | cut -d= -f2)
    UPTIME=$(systemctl show "$svc" --property=ActiveEnterTimestamp 2>/dev/null | cut -d= -f2)
    echo "  Restarts: ${RESTART_COUNT:-0}"
    echo "  Main PID: ${MAIN_PID:-N/A}"
    echo "  Active since: ${UPTIME:-N/A}"
  fi

  # ── Resource usage (verbose 2+) ──
  if [[ $VERBOSE -ge 2 && "$STATUS" == "active" ]]; then
    MEM=$(systemctl show "$svc" --property=MemoryCurrent 2>/dev/null | cut -d= -f2)
    if [[ -n "$MEM" && "$MEM" != "[not set]" && "$MEM" != "infinity" ]]; then
      MEM_MB=$((MEM / 1024 / 1024))
      echo "  Memory: ${MEM_MB}MB"
    fi
  fi

  # ── Full status (verbose 3) ──
  if [[ $VERBOSE -ge 3 ]]; then
    echo "  --- Full Status ---"
    systemctl status "$svc" --no-pager 2>/dev/null | sed 's/^/    /' || true
  fi
done

echo "--- Failed Units ---"
systemctl --failed --no-pager 2>/dev/null || echo "  Cannot list failed units"

# ── Timer units (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Active Timers ---"
  systemctl list-timers --all --no-pager 2>/dev/null | head -15 || true
fi

# ── Masked units (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Masked Units ---"
  systemctl list-unit-files --state=masked --no-pager 2>/dev/null | head -10 || echo "  None"
fi
