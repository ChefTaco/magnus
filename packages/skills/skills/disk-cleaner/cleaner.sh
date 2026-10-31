#!/usr/bin/env bash
# disk-cleaner — Clean up disk space on Ubuntu servers
set -euo pipefail

VERBOSE=0
THRESHOLD=80

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS] [THRESHOLD]

Automated disk space management for Ubuntu. Identifies cleanup
opportunities: temp files, old logs, APT cache, snap cache,
journal logs, Docker dangling images, and orphaned packages.

Positional arguments:
  THRESHOLD      Disk usage % to consider critical (default: 80)

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Usage summary and cleanup opportunities
  -v             Include individual file listings and sizes
  -vv            Include package cache details and journal analysis
  -vvv           Full file discovery output

Examples:
  $(basename "$0")             # Check disk with 80% threshold
  $(basename "$0") 90          # Only flag at 90%+ usage
  $(basename "$0") -vv         # Detailed cleanup analysis
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

[[ $# -ge 1 ]] && THRESHOLD="$1"

echo "=== Disk Cleaner ==="
echo "Critical threshold: ${THRESHOLD}%"

echo "--- Current Usage ---"
df -h --output=target,pcent,avail,size | head -15
# Flag any partition over threshold
df --output=target,pcent 2>/dev/null | awk -v thresh="$THRESHOLD" 'NR>1 {gsub(/%/,"",$2); if ($2+0 >= thresh+0) print "  ⚠ " $1 " at " $2 "%"}'

echo "--- Temp Files (> 7 days) ---"
COUNT=$(find /tmp /var/tmp -type f -mtime +7 2>/dev/null | wc -l)
SIZE=$(find /tmp /var/tmp -type f -mtime +7 -exec du -ch {} + 2>/dev/null | tail -1 | awk '{print $1}')
echo "  Found $COUNT old temp files (${SIZE:-0})"
if [[ $VERBOSE -ge 1 ]]; then
  find /tmp /var/tmp -type f -mtime +7 2>/dev/null -exec ls -lh {} \; | awk '{print "    " $5, $9}' | head -15
fi

echo "--- Large Log Files (> 100MB) ---"
find /var/log -type f -size +100M 2>/dev/null -exec ls -lh {} \; | awk '{print "  " $5, $9}' | head -10 || echo "  None"

echo "--- Journal Disk Usage ---"
if command -v journalctl &>/dev/null; then
  JOURNAL_SIZE=$(journalctl --disk-usage 2>/dev/null | grep -oP '[\d.]+\s*[KMGT]' || echo "unknown")
  echo "  Journal size: ${JOURNAL_SIZE}"
  echo "  Vacuum with: sudo journalctl --vacuum-size=100M"
fi

echo "--- APT Cache ---"
if command -v apt &>/dev/null; then
  CACHE_SIZE=$(du -sh /var/cache/apt/archives 2>/dev/null | awk '{print $1}')
  echo "  APT cache: ${CACHE_SIZE:-unknown}"
  echo "  Clean with: sudo apt clean && sudo apt autoremove"
  if [[ $VERBOSE -ge 2 ]]; then
    AUTOREMOVE=$(apt list --installed 2>/dev/null | grep -c 'auto-removable' || apt-get --dry-run autoremove 2>/dev/null | grep -c 'Remv' || echo 0)
    echo "  Auto-removable packages: $AUTOREMOVE"
  fi
fi

echo "--- Snap Cache ---"
if command -v snap &>/dev/null; then
  SNAP_CACHE=$(du -sh /var/lib/snapd/cache 2>/dev/null | awk '{print $1}')
  echo "  Snap cache: ${SNAP_CACHE:-N/A}"
  # Count disabled snap revisions
  DISABLED=$(snap list --all 2>/dev/null | awk '/disabled/ {print $1, $3}' | wc -l)
  if [[ $DISABLED -gt 0 ]]; then
    echo "  ⚠ $DISABLED disabled snap revision(s) can be removed"
    if [[ $VERBOSE -ge 1 ]]; then
      snap list --all 2>/dev/null | awk '/disabled/ {print "    " $1, "rev", $3}'
    fi
  fi
fi

echo "--- Docker (if present) ---"
if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
  DANGLING=$(docker images -f "dangling=true" -q 2>/dev/null | wc -l)
  STOPPED=$(docker ps -aq --filter "status=exited" 2>/dev/null | wc -l)
  echo "  Dangling images: $DANGLING"
  echo "  Stopped containers: $STOPPED"
  if [[ $DANGLING -gt 0 || $STOPPED -gt 0 ]]; then
    echo "  Clean with: docker system prune"
  fi
fi

echo "--- Top 10 Largest Directories ---"
du -hx --max-depth=2 / 2>/dev/null | sort -rh | head -10 || true

if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Old Kernel Packages ---"
  CURRENT_KERNEL=$(uname -r)
  dpkg -l 'linux-image-*' 2>/dev/null | grep ^ii | grep -v "$CURRENT_KERNEL" | awk '{print "  " $2, $3}' | head -10 || echo "  None"
fi
