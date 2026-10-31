#!/usr/bin/env bash
# log-analyzer — Parse and detect patterns in system logs on Ubuntu
set -euo pipefail

VERBOSE=0
SINCE="--since=1h"

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS] [SINCE]

Intelligent log analysis for Ubuntu servers. Parses journald,
syslog, auth.log, and kern.log. Detects recurring errors,
authentication failures, OOM events, and security anomalies.

Positional arguments:
  SINCE          journalctl time filter (default: --since=1h)

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Error summary and auth failures
  -v             Include dmesg warnings and APT history
  -vv            Include full recurring error analysis and kernel log
  -vvv           Include raw journalctl output

Examples:
  $(basename "$0")                     # Last hour of logs
  $(basename "$0") "--since=24h"       # Last 24 hours
  $(basename "$0") -vv "--since=7d"    # Detailed week analysis
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
    --since=*) SINCE="$1"; shift ;;
    -*) echo "Unknown option: $1" >&2; usage ;;
    *) SINCE="$1"; shift ;;
  esac
done

echo "=== Log Analyzer ==="
echo "Time range: ${SINCE}"

echo "--- Recent Errors (journald) ---"
journalctl --no-pager -p err "$SINCE" 2>/dev/null | tail -30 || echo "  journalctl unavailable"

echo "--- Auth Failures ---"
AUTH_FAILS=$(journalctl --no-pager -u sshd "$SINCE" 2>/dev/null | grep -ci "failed\|invalid" || echo 0)
echo "  SSH auth failures: $AUTH_FAILS"
journalctl --no-pager -u sshd "$SINCE" 2>/dev/null | grep -i "failed\|invalid" | tail -15 || true

# ── Failed login IPs ──
if [[ $AUTH_FAILS -gt 0 ]]; then
  echo "  Top offending IPs:"
  journalctl --no-pager -u sshd "$SINCE" 2>/dev/null | grep -i "failed" | grep -oP 'from \K[\d.]+' | sort | uniq -c | sort -rn | head -10 | sed 's/^/    /' || true
fi

echo "--- OOM Events ---"
journalctl --no-pager -k "$SINCE" 2>/dev/null | grep -i "oom\|out of memory" | tail -10 || echo "  None"

echo "--- Recurring Errors ---"
journalctl --no-pager -p err "$SINCE" 2>/dev/null | awk '{$1=$2=$3=""; print}' | sort | uniq -c | sort -rn | head -10 || echo "  None"

# ── dmesg warnings (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Dmesg Warnings ---"
  dmesg --level=warn,err 2>/dev/null | tail -15 | sed 's/^/  /' || echo "  dmesg unavailable"

  echo "--- APT History ---"
  if [[ -f /var/log/apt/history.log ]]; then
    tail -20 /var/log/apt/history.log | sed 's/^/  /'
  else
    echo "  No APT history"
  fi
fi

# ── Auth log analysis (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Sudo Activity ---"
  journalctl --no-pager "$SINCE" 2>/dev/null | grep -i "sudo:" | tail -10 | sed 's/^/  /' || true
fi

# ── Kernel log (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Kernel Errors ---"
  journalctl --no-pager -k -p err "$SINCE" 2>/dev/null | tail -20 | sed 's/^/  /' || true

  echo "--- Service Crashes ---"
  journalctl --no-pager "$SINCE" 2>/dev/null | grep -i "segfault\|core dump\|killed process" | tail -10 | sed 's/^/  /' || echo "  None"
fi

# ── Disk I/O errors (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Disk I/O Errors ---"
  journalctl --no-pager -k "$SINCE" 2>/dev/null | grep -iE "i/o error|medium error|read error|write error" | tail -10 | sed 's/^/  /' || echo "  None"
fi
