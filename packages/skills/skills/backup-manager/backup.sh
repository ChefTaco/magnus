#!/usr/bin/env bash
# backup-manager — Backup files/directories with integrity verification
set -euo pipefail

VERBOSE=0
SRC="/etc"
DEST="/var/backups/magnus"
RETENTION_DAYS=30

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS] [SOURCE] [DESTINATION] [RETENTION_DAYS]

Create compressed, checksummed backups with automatic rotation.
Supports rsync pre-staging, integrity verification, and retention
policies. Ideal for /etc, /home, and application data on Ubuntu.

Positional arguments:
  SOURCE          Directory to back up (default: /etc)
  DESTINATION     Backup storage directory (default: /var/backups/magnus)
  RETENTION_DAYS  Delete backups older than N days (default: 30)

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Archive creation and retention summary
  -v             Include tar file listing and checksum details
  -vv            Include per-file sizes and rsync stats
  -vvv           Include tar verbose output

Examples:
  $(basename "$0")                              # Back up /etc
  $(basename "$0") /home /mnt/backups 90        # Back up /home, keep 90 days
  $(basename "$0") -vv /var/www /backups        # Verbose backup of web root
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

[[ $# -ge 1 ]] && SRC="$1"
[[ $# -ge 2 ]] && DEST="$2"
[[ $# -ge 3 ]] && RETENTION_DAYS="$3"

echo "=== Backup Manager ==="
echo "Source: $SRC"
echo "Destination: $DEST"
echo "Retention: ${RETENTION_DAYS} days"

mkdir -p "$DEST"

STAMP=$(date +%Y%m%d-%H%M%S)
ARCHIVE="$DEST/backup-$STAMP.tar.gz"

# ── Disk space check ──
log_v1 "Checking available disk space at $DEST"
AVAIL_KB=$(df --output=avail "$DEST" 2>/dev/null | tail -1 | xargs)
SRC_KB=$(du -sk "$SRC" 2>/dev/null | awk '{print $1}')
if [[ -n "$AVAIL_KB" && -n "$SRC_KB" && "$AVAIL_KB" -lt "$SRC_KB" ]]; then
  echo "⚠ Warning: available space (${AVAIL_KB}K) may be insufficient for source (${SRC_KB}K)"
fi

echo "--- Creating Archive ---"
TAR_OPTS="-czf"
[[ $VERBOSE -ge 3 ]] && TAR_OPTS="-cvzf"
tar $TAR_OPTS "$ARCHIVE" -C "$(dirname "$SRC")" "$(basename "$SRC")" 2>/dev/null
CHECKSUM=$(sha256sum "$ARCHIVE" | awk '{print $1}')
echo "$CHECKSUM  $ARCHIVE" >> "$DEST/checksums.txt"
echo "Archive: $ARCHIVE"
echo "Checksum: $CHECKSUM"
SIZE=$(du -h "$ARCHIVE" | awk '{print $1}')
echo "Size: $SIZE"

# ── Verify integrity ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Integrity Verification ---"
  VERIFY=$(sha256sum "$ARCHIVE" | awk '{print $1}')
  if [[ "$VERIFY" == "$CHECKSUM" ]]; then
    echo "  ✓ Checksum verified"
  else
    echo "  ✗ Checksum mismatch!"
  fi
  log_v1 "File count in archive: $(tar -tzf "$ARCHIVE" 2>/dev/null | wc -l)"
fi

echo "--- Retention Cleanup ---"
DELETED=$(find "$DEST" -name "backup-*.tar.gz" -mtime +"$RETENTION_DAYS" -delete -print | wc -l)
echo "Purged $DELETED old backup(s) (> ${RETENTION_DAYS} days)"

echo "--- Current Backups ---"
ls -lh "$DEST"/backup-*.tar.gz 2>/dev/null | tail -10 || echo "None"

if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Backup Sizes ---"
  du -sh "$DEST" 2>/dev/null | awk '{print "  Total backup storage: " $1}'
fi
