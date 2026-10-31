#!/usr/bin/env bash
# mount-inspector — Audit mounted filesystems on Ubuntu
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Filesystem mount auditor. Inspects all mounted filesystems including
NFS, CIFS, tmpfs, and overlayfs. Detects stale mounts, checks
security options, verifies fstab consistency, and reports mount latency.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Mount summary, security audit, fstab check
  -v             Include network mount health, tmpfs sizing
  -vv            Include mount latency testing and overlay details
  -vvv           Full mount diagnostic dump

Examples:
  $(basename "$0")             # Quick mount audit
  $(basename "$0") -v          # Include network mount health
  $(basename "$0") -vv         # Full mount analysis with latency
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

echo "=== Mount Inspector ==="

echo "--- Mount Summary ---"
echo "  Total mounts: $(findmnt --noheadings 2>/dev/null | wc -l)"
echo "  Filesystem types:"
findmnt --noheadings -o FSTYPE 2>/dev/null | sort | uniq -c | sort -rn | sed 's/^/    /' || mount | awk '{print $5}' | sort | uniq -c | sort -rn | sed 's/^/    /'

echo "--- Disk Mounts ---"
findmnt -t ext4,xfs,btrfs,ext3,ext2,vfat --noheadings -o TARGET,SOURCE,FSTYPE,OPTIONS 2>/dev/null | while read -r target source fstype opts; do
  USAGE=$(df --output=pcent "$target" 2>/dev/null | tail -1 | tr -d ' %')
  echo "  $target ($fstype, ${USAGE:-?}% used)"
  echo "    Source: $source"
  # Flag missing security options on writable mounts
  if [[ "$target" != "/" ]] && ! echo "$opts" | grep -q 'ro'; then
    MISSING=""
    echo "$opts" | grep -q 'noexec' || MISSING="$MISSING noexec"
    echo "$opts" | grep -q 'nosuid' || MISSING="$MISSING nosuid"
    if [[ -n "$MISSING" ]]; then
      echo "    ℹ Consider adding:$MISSING"
    fi
  fi
done

echo "--- Security Audit ---"
echo "  /tmp mount options:"
TMP_OPTS=$(findmnt -n -o OPTIONS /tmp 2>/dev/null || echo "(not a separate mount)")
echo "    $TMP_OPTS"
if [[ "$TMP_OPTS" != *"noexec"* ]] && [[ "$TMP_OPTS" != *"not a separate"* ]]; then
  echo "    ⚠ /tmp should have noexec,nosuid,nodev"
fi

echo "  /dev/shm mount options:"
SHM_OPTS=$(findmnt -n -o OPTIONS /dev/shm 2>/dev/null || echo "(not found)")
echo "    $SHM_OPTS"
if [[ "$SHM_OPTS" != *"nosuid"* ]] && [[ "$SHM_OPTS" != *"not found"* ]]; then
  echo "    ⚠ /dev/shm should have nosuid,noexec,nodev"
fi

echo "--- fstab Consistency ---"
FSTAB_ISSUES=0
while IFS= read -r line; do
  [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
  TARGET=$(echo "$line" | awk '{print $2}')
  [[ "$TARGET" == "none" || "$TARGET" == "swap" ]] && continue
  if ! findmnt "$TARGET" &>/dev/null; then
    echo "  ⚠ fstab entry not mounted: $TARGET"
    FSTAB_ISSUES=$((FSTAB_ISSUES + 1))
  fi
done < /etc/fstab 2>/dev/null
if [[ $FSTAB_ISSUES -eq 0 ]]; then
  echo "  ✓ All fstab entries are mounted"
fi

# ── Network mounts (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Network Mounts ---"
  NFS_MOUNTS=$(findmnt -t nfs,nfs4 --noheadings -o TARGET,SOURCE,OPTIONS 2>/dev/null)
  CIFS_MOUNTS=$(findmnt -t cifs --noheadings -o TARGET,SOURCE,OPTIONS 2>/dev/null)

  if [[ -n "$NFS_MOUNTS" ]]; then
    echo "  NFS:"
    echo "$NFS_MOUNTS" | while read -r target source opts; do
      echo "    $target ← $source"
      # Test if mount is responsive
      if timeout 3 stat "$target" &>/dev/null; then
        echo "      ✓ Responsive"
      else
        echo "      ✗ STALE or unresponsive"
      fi
    done
  else
    echo "  NFS: none"
  fi

  if [[ -n "$CIFS_MOUNTS" ]]; then
    echo "  CIFS:"
    echo "$CIFS_MOUNTS" | while read -r target source opts; do
      echo "    $target ← $source"
      if timeout 3 stat "$target" &>/dev/null; then
        echo "      ✓ Responsive"
      else
        echo "      ✗ STALE or unresponsive"
      fi
    done
  else
    echo "  CIFS: none"
  fi

  echo "--- tmpfs Mounts ---"
  findmnt -t tmpfs --noheadings -o TARGET,SIZE,USED,AVAIL 2>/dev/null | sed 's/^/  /' || echo "  none"
fi

# ── Latency testing and overlay (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Mount Latency (stat time) ---"
  for mp in $(findmnt -t ext4,xfs,btrfs,nfs,nfs4,cifs --noheadings -o TARGET 2>/dev/null | head -10); do
    START=$(date +%s%N)
    timeout 5 stat "$mp" &>/dev/null
    END=$(date +%s%N)
    LATENCY_MS=$(( (END - START) / 1000000 ))
    if [[ $LATENCY_MS -gt 1000 ]]; then
      echo "  ⚠ $mp — ${LATENCY_MS}ms (slow)"
    else
      echo "  ✓ $mp — ${LATENCY_MS}ms"
    fi
  done

  echo "--- Overlay Mounts ---"
  OVERLAYS=$(findmnt -t overlay --noheadings -o TARGET,SOURCE,OPTIONS 2>/dev/null)
  if [[ -n "$OVERLAYS" ]]; then
    echo "$OVERLAYS" | head -10 | sed 's/^/  /'
  else
    echo "  none"
  fi
fi

# ── Full dump (verbose 3) ──
if [[ $VERBOSE -ge 3 ]]; then
  echo "--- Full Mount Table ---"
  findmnt --output TARGET,SOURCE,FSTYPE,OPTIONS 2>/dev/null | sed 's/^/  /' || mount | sed 's/^/  /'

  echo "--- /etc/fstab ---"
  cat /etc/fstab 2>/dev/null | sed 's/^/  /'

  echo "--- Mount Namespace Info ---"
  ls -la /proc/self/ns/mnt 2>/dev/null | sed 's/^/  /' || true
fi
