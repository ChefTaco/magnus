#!/usr/bin/env bash
# process-inspector — Analyze running processes on Ubuntu
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Process analysis toolkit for Ubuntu servers. Identifies resource-hungry
processes, detects zombies, monitors file descriptor usage, and
reports systemd slice/cgroup resource allocation.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Top CPU/memory consumers, zombie detection
  -v             Include file descriptors, process count, and systemd slices
  -vv            Include cgroup details and process tree
  -vvv           Full process listing

Examples:
  $(basename "$0")             # Quick process overview
  $(basename "$0") -v          # Include FD and systemd info
  $(basename "$0") -vv         # Full process audit
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

echo "=== Process Inspector ==="

echo "--- Top CPU Consumers ---"
ps aux --sort=-%cpu | head -11

echo "--- Top Memory Consumers ---"
ps aux --sort=-%mem | head -11

echo "--- Zombie Processes ---"
ZOMBIES=$(ps aux | awk '$8 ~ /Z/ {print $2, $11}')
if [[ -n "$ZOMBIES" ]]; then
  echo "$ZOMBIES" | sed 's/^/  /'
else
  echo "  None"
fi

echo "--- Process Count ---"
echo "  Total: $(ps aux | wc -l)"
echo "  Unique: $(ps -eo comm --no-headers | sort -u | wc -l)"

echo "--- Open File Descriptors (top 10) ---"
if command -v lsof &>/dev/null; then
  lsof 2>/dev/null | awk '{print $1}' | sort | uniq -c | sort -rn | head -10 | sed 's/^/  /'
else
  for pid in /proc/[0-9]*; do
    name=$(cat "$pid/comm" 2>/dev/null) || continue
    count=$(ls "$pid/fd" 2>/dev/null | wc -l) || continue
    echo "$count $name"
  done | sort -rn | head -10 | sed 's/^/  /'
fi

# ── Systemd slices (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Systemd Slices ---"
  systemd-cgtop -n 1 --batch 2>/dev/null | head -15 | sed 's/^/  /' || echo "  systemd-cgtop unavailable"

  echo "--- Long-Running Processes (> 24h) ---"
  ps -eo pid,etime,comm --sort=-etime 2>/dev/null | head -11 | sed 's/^/  /'
fi

# ── Cgroup details (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Memory by Cgroup ---"
  systemctl --type slice --no-pager 2>/dev/null | head -10 | sed 's/^/  /' || true

  echo "--- Process Tree ---"
  pstree -p 2>/dev/null | head -30 | sed 's/^/  /' || ps axjf 2>/dev/null | head -30 | sed 's/^/  /' || true
fi

# ── Full listing (verbose 3) ──
if [[ $VERBOSE -ge 3 ]]; then
  echo "--- Full Process List ---"
  ps auxf 2>/dev/null | head -60 | sed 's/^/  /'
fi
