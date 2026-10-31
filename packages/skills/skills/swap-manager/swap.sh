#!/usr/bin/env bash
# swap-manager — Inspect swap configuration and memory pressure on Ubuntu
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Swap configuration inspector. Analyzes swap usage, swappiness tuning,
zram/zswap status, OOM-killer history, and memory pressure indicators.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Swap summary, swappiness, memory overview
  -v             Include zram/zswap, OOM history, PSI metrics
  -vv            Include per-process swap usage and recommendations
  -vvv           Full memory diagnostic dump

Examples:
  $(basename "$0")             # Quick swap overview
  $(basename "$0") -v          # Include OOM and zram info
  $(basename "$0") -vv         # Full swap analysis with recommendations
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

echo "=== Swap Manager ==="

echo "--- Memory Overview ---"
free -h 2>/dev/null || free -m 2>/dev/null

echo "--- Swap Devices ---"
if swapon --show 2>/dev/null | grep -q .; then
  swapon --show 2>/dev/null | sed 's/^/  /'
else
  echo "  No swap devices active"
fi

echo "--- Swap Usage ---"
SWAP_TOTAL=$(awk '/SwapTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
SWAP_FREE=$(awk '/SwapFree/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
SWAP_USED=$((SWAP_TOTAL - SWAP_FREE))
if [[ $SWAP_TOTAL -gt 0 ]]; then
  SWAP_PCT=$((SWAP_USED * 100 / SWAP_TOTAL))
  echo "  Total: $((SWAP_TOTAL / 1024)) MB"
  echo "  Used:  $((SWAP_USED / 1024)) MB (${SWAP_PCT}%)"
  echo "  Free:  $((SWAP_FREE / 1024)) MB"
  if [[ $SWAP_PCT -ge 80 ]]; then
    echo "  ⚠ Swap usage critical (${SWAP_PCT}%)"
  elif [[ $SWAP_PCT -ge 50 ]]; then
    echo "  ⚠ Swap usage elevated (${SWAP_PCT}%)"
  else
    echo "  ✓ Swap usage healthy"
  fi
else
  echo "  No swap configured"
fi

echo "--- Swappiness ---"
SWAPPINESS=$(cat /proc/sys/vm/swappiness 2>/dev/null || echo "unknown")
echo "  vm.swappiness = $SWAPPINESS"
if [[ "$SWAPPINESS" =~ ^[0-9]+$ ]]; then
  if [[ $SWAPPINESS -ge 60 ]]; then
    echo "  ℹ Default/aggressive — system will swap early"
  elif [[ $SWAPPINESS -le 10 ]]; then
    echo "  ℹ Conservative — system avoids swap until memory pressure is high"
  fi
fi

echo "  vm.vfs_cache_pressure = $(cat /proc/sys/vm/vfs_cache_pressure 2>/dev/null || echo 'unknown')"

# ── zram / zswap (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- zram Status ---"
  if [[ -d /sys/block/zram0 ]]; then
    echo "  ✓ zram0 detected"
    echo "  Algorithm: $(cat /sys/block/zram0/comp_algorithm 2>/dev/null | grep -oP '\[\K[^\]]+' || echo 'unknown')"
    echo "  Disk size: $(cat /sys/block/zram0/disksize 2>/dev/null | awk '{printf "%.0f MB", $1/1024/1024}')"
    ORIG=$(cat /sys/block/zram0/mm_stat 2>/dev/null | awk '{print $1}' || echo 0)
    COMPR=$(cat /sys/block/zram0/mm_stat 2>/dev/null | awk '{print $2}' || echo 0)
    if [[ $ORIG -gt 0 && $COMPR -gt 0 ]]; then
      RATIO=$(awk "BEGIN {printf \"%.1f\", $ORIG / $COMPR}")
      echo "  Compression ratio: ${RATIO}:1"
    fi
  else
    echo "  Not configured"
  fi

  echo "--- zswap Status ---"
  if [[ -d /sys/module/zswap ]]; then
    ENABLED=$(cat /sys/module/zswap/parameters/enabled 2>/dev/null || echo "N")
    echo "  Enabled: $ENABLED"
    if [[ "$ENABLED" == "Y" ]]; then
      echo "  Compressor: $(cat /sys/module/zswap/parameters/compressor 2>/dev/null || echo 'unknown')"
      echo "  Zpool: $(cat /sys/module/zswap/parameters/zpool 2>/dev/null || echo 'unknown')"
      echo "  Max pool %: $(cat /sys/module/zswap/parameters/max_pool_percent 2>/dev/null || echo 'unknown')"
    fi
  else
    echo "  Module not loaded"
  fi

  echo "--- OOM Killer History ---"
  OOM_COUNT=$(journalctl --no-pager -k 2>/dev/null | grep -ci "out of memory\|oom-kill" || echo 0)
  echo "  Total OOM events in journal: $OOM_COUNT"
  if [[ "$OOM_COUNT" -gt 0 ]]; then
    echo "  Recent OOM kills:"
    journalctl --no-pager -k 2>/dev/null | grep -i "out of memory\|oom-kill\|killed process" | tail -5 | sed 's/^/    /'
  fi

  echo "--- Memory Pressure (PSI) ---"
  if [[ -f /proc/pressure/memory ]]; then
    cat /proc/pressure/memory | sed 's/^/  /'
  else
    echo "  PSI not available (kernel < 4.20 or CONFIG_PSI=n)"
  fi
fi

# ── Per-process swap usage (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Top Swap Consumers ---"
  echo "  PID     SWAP(KB)   COMMAND"
  for pid in /proc/[0-9]*; do
    [[ -f "$pid/status" ]] || continue
    SWAP_KB=$(awk '/VmSwap/ {print $2}' "$pid/status" 2>/dev/null || echo 0)
    if [[ "${SWAP_KB:-0}" -gt 0 ]]; then
      COMM=$(cat "$pid/comm" 2>/dev/null || echo "?")
      echo "  $(basename "$pid")  ${SWAP_KB}  $COMM"
    fi
  done 2>/dev/null | sort -t' ' -k2 -rn | head -15

  echo "--- Recommendations ---"
  if [[ $SWAP_TOTAL -eq 0 ]]; then
    MEM_TOTAL_MB=$(($(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024))
    echo "  ⚠ No swap configured."
    if [[ $MEM_TOTAL_MB -le 2048 ]]; then
      echo "  → Recommend: Create swap file equal to RAM (${MEM_TOTAL_MB}MB)"
    else
      echo "  → Recommend: Create swap file of 2-4GB for safety net"
    fi
    echo "  → Consider: zram for compressed in-memory swap"
  fi
  if [[ "$SWAPPINESS" =~ ^[0-9]+$ ]] && [[ $SWAPPINESS -ge 60 ]]; then
    echo "  ℹ Consider lowering swappiness for database/latency-sensitive workloads:"
    echo "    sysctl vm.swappiness=10"
  fi
fi

# ── Full dump (verbose 3) ──
if [[ $VERBOSE -ge 3 ]]; then
  echo "--- /proc/meminfo ---"
  cat /proc/meminfo | sed 's/^/  /'

  echo "--- Swap fstab entries ---"
  grep -i swap /etc/fstab 2>/dev/null | sed 's/^/  /' || echo "  No swap in fstab"
fi
