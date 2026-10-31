#!/usr/bin/env bash
# package-manager — Check for updates and vulnerable packages on Ubuntu
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Ubuntu package management audit. Checks for available updates,
security patches, held packages, auto-removable packages, and
installed package statistics.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Upgrade summary, security updates, held packages
  -v             Include package counts, repository sources, snap list
  -vv            Include recently installed packages and dpkg audit
  -vvv           Full apt policy output

Examples:
  $(basename "$0")             # Quick update check
  $(basename "$0") -v          # Include sources and snap info
  $(basename "$0") -vv         # Full package audit
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

echo "=== Package Manager ==="

if ! command -v apt &>/dev/null; then
  echo "apt not available — this skill is designed for Ubuntu/Debian"
  exit 0
fi

echo "--- Package Manager: APT ---"
TOTAL_INSTALLED=$(dpkg -l 2>/dev/null | grep -c ^ii || echo "unknown")
echo "  Installed packages: $TOTAL_INSTALLED"

echo "--- Upgradable Packages ---"
UPGRADABLE=$(apt list --upgradable 2>/dev/null | grep -c 'upgradable' || echo 0)
echo "  Upgradable: $UPGRADABLE"
if [[ $UPGRADABLE -gt 0 ]]; then
  apt list --upgradable 2>/dev/null | tail -30
fi

echo "--- Security Updates ---"
SECURITY=$(apt list --upgradable 2>/dev/null | grep -ci security || echo 0)
if [[ $SECURITY -gt 0 ]]; then
  echo "  ⚠ $SECURITY security update(s):"
  apt list --upgradable 2>/dev/null | grep -i security | head -20 | sed 's/^/    /'
else
  echo "  ✓ No pending security updates"
fi

echo "--- Held Packages ---"
HELD=$(apt-mark showhold 2>/dev/null)
if [[ -n "$HELD" ]]; then
  echo "$HELD" | sed 's/^/  /'
else
  echo "  ✓ No held packages"
fi

echo "--- Auto-Removable ---"
AUTOREMOVE=$(apt list --installed 2>/dev/null | grep -c auto-removable || echo 0)
if [[ $AUTOREMOVE -gt 0 ]]; then
  echo "  ⚠ $AUTOREMOVE auto-removable package(s)"
  echo "  Run: sudo apt autoremove"
else
  echo "  ✓ No auto-removable packages"
fi

# ── Snap packages (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Snap Packages ---"
  if command -v snap &>/dev/null; then
    SNAP_COUNT=$(snap list 2>/dev/null | tail -n +2 | wc -l)
    echo "  Installed snaps: $SNAP_COUNT"
    snap list 2>/dev/null | head -15 | sed 's/^/  /'
    # Check for refreshable snaps
    REFRESH=$(snap refresh --list 2>/dev/null | tail -n +2 | wc -l)
    if [[ $REFRESH -gt 0 ]]; then
      echo "  ⚠ $REFRESH snap(s) have updates available"
    fi
  else
    echo "  snap not installed"
  fi
fi

# ── APT sources (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- APT Sources ---"
  SOURCES=$(find /etc/apt/sources.list.d/ -name "*.list" -o -name "*.sources" 2>/dev/null | wc -l)
  echo "  Extra source files: $SOURCES"
  find /etc/apt/sources.list.d/ -name "*.list" -o -name "*.sources" 2>/dev/null | while read -r f; do
    echo "    $(basename "$f")"
  done
fi

# ── Recently installed (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Recently Installed (last 20) ---"
  grep " install " /var/log/dpkg.log 2>/dev/null | tail -20 | awk '{print "  " $1, $2, $4}' || echo "  No dpkg history"

  echo "--- DPKG Audit ---"
  BROKEN=$(dpkg --audit 2>/dev/null | wc -l)
  if [[ $BROKEN -gt 0 ]]; then
    echo "  ⚠ $BROKEN issue(s):"
    dpkg --audit 2>/dev/null | head -10 | sed 's/^/    /'
  else
    echo "  ✓ No broken packages"
  fi
fi

# ── Full policy (verbose 3) ──
if [[ $VERBOSE -ge 3 ]]; then
  echo "--- APT Policy ---"
  apt-cache policy 2>/dev/null | head -40 | sed 's/^/  /'
fi
