#!/usr/bin/env bash
# system-monitor — Collect system metrics on Ubuntu
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Collect CPU, memory, disk, swap, load, temperature, and uptime
metrics. Reports Ubuntu release info, kernel version, and
hardware summary.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      CPU, memory, disk, swap, and temperature
  -v             Include uptime, kernel info, and I/O stats
  -vv            Include hardware details and kernel modules
  -vvv           Full /proc data dump

Examples:
  $(basename "$0")             # Quick system health check
  $(basename "$0") -v          # Include uptime and I/O stats
  $(basename "$0") -vv         # Full hardware audit
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

echo "=== System Monitor ==="

# ── System info ──
echo "--- System ---"
if [[ -f /etc/os-release ]]; then
  source /etc/os-release
  echo "  OS: ${PRETTY_NAME:-Unknown}"
fi
echo "  Kernel: $(uname -r)"
echo "  Hostname: $(hostname)"
echo "  Uptime: $(uptime -p 2>/dev/null || uptime)"

echo "--- CPU ---"
CORES=$(grep -c ^processor /proc/cpuinfo)
echo "  Cores: $CORES"
uptime | awk -F'load average:' '{print "  Load:" $2}'
top -bn1 | head -5 | sed 's/^/  /'

echo "--- Memory ---"
free -h

echo "--- Swap ---"
swapon --show 2>/dev/null || echo "  No swap"
if [[ $VERBOSE -ge 1 ]]; then
  log_v1 "Swappiness: $(cat /proc/sys/vm/swappiness 2>/dev/null)"
fi

echo "--- Disk ---"
df -h --output=target,size,used,avail,pcent | head -20

echo "--- Temperature ---"
if command -v sensors &>/dev/null; then
  sensors 2>/dev/null || echo "  sensors unavailable"
else
  TEMPS=""
  for tz in /sys/class/thermal/thermal_zone*/temp; do
    [[ -f "$tz" ]] || continue
    t=$(cat "$tz" 2>/dev/null) || continue
    ZONE=$(basename "$(dirname "$tz")")
    TEMPS="$TEMPS  $ZONE: $(( t / 1000 ))°C\n"
  done
  if [[ -n "$TEMPS" ]]; then
    echo -e "$TEMPS"
  else
    echo "  No temperature data"
  fi
fi

# ── I/O stats (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Disk I/O ---"
  if command -v iostat &>/dev/null; then
    iostat -h 2>/dev/null | head -15 | sed 's/^/  /'
  else
    cat /proc/diskstats 2>/dev/null | awk '{print "  " $3, "reads=" $4, "writes=" $8}' | head -10
  fi
fi

# ── Hardware (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Hardware ---"
  CPU_MODEL=$(grep "model name" /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2 | xargs)
  TOTAL_MEM=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{printf "%.1f GB", $2/1024/1024}')
  echo "  CPU: ${CPU_MODEL:-unknown}"
  echo "  RAM: ${TOTAL_MEM:-unknown}"
  echo "  Architecture: $(uname -m)"

  if command -v lsblk &>/dev/null; then
    echo "  Block devices:"
    lsblk -d -o NAME,SIZE,TYPE,ROTA 2>/dev/null | sed 's/^/    /'
  fi
fi

# ── Kernel modules (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Loaded Kernel Modules ---"
  lsmod 2>/dev/null | wc -l | xargs -I{} echo "  Total modules: {}"
fi
