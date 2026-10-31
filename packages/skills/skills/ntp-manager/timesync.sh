#!/usr/bin/env bash
# ntp-manager — Time synchronization and NTP management
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Check time synchronization status on Ubuntu. Inspects timedatectl,
systemd-timesyncd or chrony configuration, NTP peer connectivity,
and clock drift.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Sync status, time zone, NTP service health
  -v             Include NTP peer details and drift measurements
  -vv            Include configuration files and service logs
  -vvv           Include full timedatectl and chronyd dump

Examples:
  $(basename "$0")             # Quick time sync check
  $(basename "$0") -v          # Include peer details
  $(basename "$0") -vv         # Full audit with configs
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

echo "=== NTP Manager ==="

# ── Current time ──
echo "--- Current Time ---"
echo "  System:   $(date -Iseconds)"
echo "  UTC:      $(date -u -Iseconds)"
echo "  Timezone: $(timedatectl show --property=Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo 'unknown')"

# ── timedatectl ──
echo "--- Time Sync Status ---"
if command -v timedatectl &>/dev/null; then
  NTP_ACTIVE=$(timedatectl show --property=NTP --value 2>/dev/null || echo "unknown")
  NTP_SYNCED=$(timedatectl show --property=NTPSynchronized --value 2>/dev/null || echo "unknown")
  echo "  NTP enabled:      $NTP_ACTIVE"
  echo "  NTP synchronized: $NTP_SYNCED"

  if [[ "$NTP_SYNCED" == "no" ]]; then
    echo "  ⚠ Clock is NOT synchronized"
  else
    echo "  ✓ Clock is synchronized"
  fi

  if [[ $VERBOSE -ge 3 ]]; then
    echo "  Full timedatectl output:"
    timedatectl status 2>/dev/null | sed 's/^/    /'
  fi
else
  echo "  timedatectl not available"
fi

# ── Detect NTP implementation ──
echo "--- NTP Service ---"
if systemctl is-active chrony &>/dev/null 2>&1 || systemctl is-active chronyd &>/dev/null 2>&1; then
  echo "  Implementation: chrony"

  echo "  Service status: $(systemctl is-active chrony 2>/dev/null || systemctl is-active chronyd 2>/dev/null)"

  if [[ $VERBOSE -ge 1 ]]; then
    echo "  --- Chrony Sources ---"
    chronyc sources -v 2>/dev/null | sed 's/^/    /' || echo "    chronyc unavailable"

    echo "  --- Chrony Tracking ---"
    chronyc tracking 2>/dev/null | sed 's/^/    /' || true
  fi

  if [[ $VERBOSE -ge 2 ]]; then
    echo "  --- Chrony Config ---"
    for f in /etc/chrony/chrony.conf /etc/chrony.conf; do
      if [[ -f "$f" ]]; then
        echo "    $f:"
        grep -Ev '^\s*#|^\s*$' "$f" 2>/dev/null | sed 's/^/      /'
        break
      fi
    done
  fi

elif systemctl is-active systemd-timesyncd &>/dev/null 2>&1; then
  echo "  Implementation: systemd-timesyncd"
  echo "  Service status: $(systemctl is-active systemd-timesyncd 2>/dev/null)"

  if [[ $VERBOSE -ge 1 ]]; then
    echo "  --- Timesyncd Status ---"
    timedatectl timesync-status 2>/dev/null | sed 's/^/    /' || true
  fi

  if [[ $VERBOSE -ge 2 ]]; then
    echo "  --- Timesyncd Config ---"
    for f in /etc/systemd/timesyncd.conf /etc/systemd/timesyncd.conf.d/*.conf; do
      if [[ -f "$f" ]]; then
        echo "    $f:"
        grep -Ev '^\s*#|^\s*$' "$f" 2>/dev/null | sed 's/^/      /'
      fi
    done
  fi

elif systemctl is-active ntpd &>/dev/null 2>&1 || systemctl is-active ntp &>/dev/null 2>&1; then
  echo "  Implementation: ntpd"
  echo "  Service status: $(systemctl is-active ntpd 2>/dev/null || systemctl is-active ntp 2>/dev/null)"

  if [[ $VERBOSE -ge 1 ]]; then
    echo "  --- NTP Peers ---"
    ntpq -p 2>/dev/null | sed 's/^/    /' || echo "    ntpq unavailable"
  fi
else
  echo "  ⚠ No NTP service detected"
  echo "  Install: apt install chrony  OR  systemctl enable systemd-timesyncd"
fi

# ── Clock drift check (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Clock Drift ---"
  if command -v chronyc &>/dev/null; then
    OFFSET=$(chronyc tracking 2>/dev/null | grep "Last offset" | awk '{print $4}')
    echo "  Last offset: ${OFFSET:-unknown}"
  elif [[ -f /run/systemd/timesync/synchronized ]]; then
    echo "  ✓ systemd-timesyncd reports synchronized"
  fi
fi

# ── Service logs (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Recent NTP Logs ---"
  journalctl -u chrony -u chronyd -u systemd-timesyncd -u ntp -u ntpd --no-pager -n 15 --since "24h ago" 2>/dev/null | sed 's/^/  /' || echo "  No NTP logs found"
fi
