#!/usr/bin/env bash
# update-manager — Ubuntu update and upgrade management
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Check Ubuntu update status: pending package updates, security patches,
unattended-upgrades configuration, reboot-required flag, and release
upgrade availability.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Summary of pending updates and reboot status
  -v             Include unattended-upgrades config and APT sources
  -vv            Include update history and dpkg audit
  -vvv           Include full apt policy output

Examples:
  $(basename "$0")             # Quick update status
  $(basename "$0") -v          # Include config details
  $(basename "$0") -vv         # Full audit with history
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

echo "=== Update Manager ==="

# ── OS info ──
echo "--- System ---"
if [[ -f /etc/os-release ]]; then
  source /etc/os-release
  echo "  Distribution: ${PRETTY_NAME:-Unknown}"
  echo "  Version: ${VERSION_ID:-Unknown}"
fi
echo "  Kernel: $(uname -r)"

# ── Reboot required ──
echo "--- Reboot Status ---"
if [[ -f /var/run/reboot-required ]]; then
  echo "  ⚠ REBOOT REQUIRED"
  if [[ -f /var/run/reboot-required.pkgs ]]; then
    echo "  Packages requiring reboot:"
    cat /var/run/reboot-required.pkgs | sed 's/^/    /'
  fi
else
  echo "  ✓ No reboot required"
fi

# ── Pending updates ──
echo "--- Pending Updates ---"
if command -v apt &>/dev/null; then
  log_v1 "Running apt list --upgradable..."
  UPGRADABLE=$(apt list --upgradable 2>/dev/null | grep -c 'upgradable' || echo 0)
  echo "  Upgradable packages: $UPGRADABLE"

  SECURITY=$(apt list --upgradable 2>/dev/null | grep -ci 'security' || echo 0)
  if [[ $SECURITY -gt 0 ]]; then
    echo "  ⚠ Security updates: $SECURITY"
    apt list --upgradable 2>/dev/null | grep -i 'security' | head -10 | sed 's/^/    /'
  else
    echo "  ✓ No pending security updates"
  fi
else
  echo "  apt not available"
fi

# ── Held packages ──
echo "--- Held Packages ---"
HELD=$(apt-mark showhold 2>/dev/null | wc -l)
if [[ $HELD -gt 0 ]]; then
  echo "  ⚠ $HELD held package(s):"
  apt-mark showhold 2>/dev/null | sed 's/^/    /'
else
  echo "  ✓ No held packages"
fi

# ── Unattended-upgrades ──
echo "--- Unattended-Upgrades ---"
if dpkg -l unattended-upgrades &>/dev/null 2>&1; then
  echo "  ✓ Package installed"
  if systemctl is-active apt-daily-upgrade.timer &>/dev/null; then
    echo "  ✓ Timer active"
    if [[ $VERBOSE -ge 1 ]]; then
      systemctl status apt-daily-upgrade.timer --no-pager 2>/dev/null | grep -E 'Loaded|Active|Trigger' | sed 's/^/    /'
    fi
  else
    echo "  ⚠ Timer not active"
  fi

  if [[ $VERBOSE -ge 1 ]]; then
    echo "  Configuration:"
    for f in /etc/apt/apt.conf.d/50unattended-upgrades /etc/apt/apt.conf.d/20auto-upgrades; do
      if [[ -f "$f" ]]; then
        echo "    $f:"
        grep -Ev '^\s*//|^\s*$' "$f" 2>/dev/null | head -10 | sed 's/^/      /'
      fi
    done
  fi
else
  echo "  ⚠ Not installed (apt install unattended-upgrades)"
fi

# ── Last update ──
echo "--- Last APT Activity ---"
if [[ -f /var/log/apt/history.log ]]; then
  LAST_UPDATE=$(grep "Start-Date" /var/log/apt/history.log 2>/dev/null | tail -1 | cut -d: -f2- | xargs)
  echo "  Last apt operation: ${LAST_UPDATE:-unknown}"
else
  echo "  No apt history available"
fi

if [[ -f /var/lib/apt/periodic/update-stamp ]]; then
  STAMP=$(stat -c %Y /var/lib/apt/periodic/update-stamp 2>/dev/null)
  if [[ -n "$STAMP" ]]; then
    AGE_HOURS=$(( ($(date +%s) - STAMP) / 3600 ))
    echo "  Last apt-get update: ${AGE_HOURS}h ago"
  fi
fi

# ── APT sources (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- APT Sources ---"
  if [[ -f /etc/apt/sources.list ]]; then
    grep -cEv '^\s*#|^\s*$' /etc/apt/sources.list 2>/dev/null | xargs -I{} echo "  /etc/apt/sources.list: {} entries"
  fi
  EXTRA=$(find /etc/apt/sources.list.d/ -name "*.list" -o -name "*.sources" 2>/dev/null | wc -l)
  echo "  Extra source files: $EXTRA"
  if [[ $VERBOSE -ge 2 ]]; then
    find /etc/apt/sources.list.d/ -name "*.list" -o -name "*.sources" 2>/dev/null | while read -r f; do
      echo "    $(basename "$f")"
    done
  fi
fi

# ── dpkg audit (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- DPKG Audit ---"
  BROKEN=$(dpkg --audit 2>/dev/null | wc -l)
  if [[ $BROKEN -gt 0 ]]; then
    echo "  ⚠ $BROKEN issue(s) found:"
    dpkg --audit 2>/dev/null | head -10 | sed 's/^/    /'
  else
    echo "  ✓ No broken packages"
  fi

  echo "--- Recent Install History ---"
  grep " install " /var/log/dpkg.log 2>/dev/null | tail -10 | awk '{print "  " $1, $2, $4}' || echo "  No history"
fi

# ── Release upgrade (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Release Upgrade ---"
  if command -v do-release-upgrade &>/dev/null; then
    do-release-upgrade -c 2>/dev/null | head -5 | sed 's/^/  /' || echo "  No new release available"
  else
    echo "  do-release-upgrade not available"
  fi
fi
