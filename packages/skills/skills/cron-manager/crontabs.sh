#!/usr/bin/env bash
# cron-manager — Audit and inspect all cron jobs and scheduled tasks
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Audit all user and system cron jobs, systemd timers, and at queues.
Detects orphaned entries (cron jobs for deleted users) and validates
that referenced commands exist.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Summary of cron jobs and timers
  -v             Include crontab contents and timer details
  -vv            Include file permission checks and command validation
  -vvv           Include raw crontab parsing and systemd unit details

Examples:
  $(basename "$0")             # Quick overview
  $(basename "$0") -v          # Show crontab contents
  $(basename "$0") -vv         # Full audit with validation
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

echo "=== Cron Manager ==="

# ── System crontabs ──
echo "--- System Crontabs ---"
for f in /etc/crontab /etc/cron.d/*; do
  [[ -f "$f" ]] || continue
  LINES=$(grep -cEv '^\s*#|^\s*$' "$f" 2>/dev/null || echo 0)
  echo "  $f ($LINES entries)"
  if [[ $VERBOSE -ge 1 ]]; then
    grep -Ev '^\s*#|^\s*$' "$f" 2>/dev/null | sed 's/^/    /' || true
  fi
done

echo "--- Cron Directories ---"
for dir in /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do
  if [[ -d "$dir" ]]; then
    COUNT=$(find "$dir" -maxdepth 1 -type f -executable 2>/dev/null | wc -l)
    echo "  $dir: $COUNT script(s)"
    if [[ $VERBOSE -ge 1 ]]; then
      find "$dir" -maxdepth 1 -type f -executable 2>/dev/null | while read -r s; do
        echo "    $(basename "$s")"
      done
    fi
  fi
done

# ── User crontabs ──
echo "--- User Crontabs ---"
CRON_SPOOL="/var/spool/cron/crontabs"
if [[ -d "$CRON_SPOOL" ]]; then
  for f in "$CRON_SPOOL"/*; do
    [[ -f "$f" ]] || continue
    USER=$(basename "$f")
    LINES=$(grep -cEv '^\s*#|^\s*$' "$f" 2>/dev/null || echo 0)
    # Check if user still exists
    if id "$USER" &>/dev/null; then
      echo "  $USER: $LINES job(s)"
    else
      echo "  ⚠ $USER: $LINES job(s) [USER DELETED — orphaned crontab]"
    fi
    if [[ $VERBOSE -ge 1 ]]; then
      grep -Ev '^\s*#|^\s*$' "$f" 2>/dev/null | sed 's/^/    /' || true
    fi
    if [[ $VERBOSE -ge 2 ]]; then
      log_v2 "Permissions: $(ls -la "$f" 2>/dev/null)"
    fi
  done
else
  echo "  No user crontabs found"
fi

# ── Systemd timers ──
echo "--- Systemd Timers ---"
systemctl list-timers --all --no-pager 2>/dev/null | head -25 || echo "  systemctl unavailable"
if [[ $VERBOSE -ge 1 ]]; then
  log_v1 "Active timer count: $(systemctl list-timers --no-pager 2>/dev/null | grep -c 'timer' || echo 0)"
fi

# ── At queue ──
echo "--- At Queue ---"
if command -v atq &>/dev/null; then
  AT_JOBS=$(atq 2>/dev/null | wc -l)
  echo "  Pending at jobs: $AT_JOBS"
  if [[ $VERBOSE -ge 1 && $AT_JOBS -gt 0 ]]; then
    atq 2>/dev/null | head -10 | sed 's/^/    /'
  fi
else
  echo "  at not installed"
fi

# ── Command validation (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Command Validation ---"
  for f in /etc/crontab /etc/cron.d/*; do
    [[ -f "$f" ]] || continue
    grep -Ev '^\s*#|^\s*$|^(SHELL|PATH|MAILTO|HOME)' "$f" 2>/dev/null | while read -r line; do
      CMD=$(echo "$line" | awk '{for(i=6;i<=NF;i++) printf "%s ", $i; print ""}' | awk '{print $1}')
      [[ -z "$CMD" ]] && continue
      if command -v "$CMD" &>/dev/null; then
        log_v2 "  ✓ $CMD exists"
      else
        echo "  ⚠ $CMD not found (in $f)"
      fi
    done
  done
fi
