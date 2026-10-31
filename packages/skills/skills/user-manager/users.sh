#!/usr/bin/env bash
# user-manager — Audit user accounts and access on Ubuntu
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

User account lifecycle audit for Ubuntu servers. Lists active
accounts, detects dormant users, audits SSH keys, checks password
policies, and reports sudo group membership.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Active users, UID 0 accounts, recent logins
  -v             Include password aging, SSH keys, and sudo group
  -vv            Include last login per user and home directory sizes
  -vvv           Full account dump

Examples:
  $(basename "$0")             # Quick user audit
  $(basename "$0") -v          # Include password and SSH info
  $(basename "$0") -vv         # Full user audit
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

echo "=== User Manager ==="

echo "--- Active Users (with shell) ---"
awk -F: '$7 !~ /nologin|false/ {printf "  %-20s UID=%-6s %s\n", $1, $3, $7}' /etc/passwd

echo "--- Users with UID 0 ---"
awk -F: '$3 == 0 {print "  " $1}' /etc/passwd

echo "--- Recently Logged In ---"
last -n 10 --time-format short 2>/dev/null || last -10 2>/dev/null || echo "  last unavailable"

# ── Sudo group (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Sudo Group Members ---"
  getent group sudo 2>/dev/null | cut -d: -f4 | tr ',' '\n' | sed 's/^/  /' || echo "  No sudo group"

  echo "--- Admin Group Members ---"
  getent group adm 2>/dev/null | cut -d: -f4 | tr ',' '\n' | sed 's/^/  /' || echo "  No adm group"
fi

echo "--- Password Aging ---"
for user in $(awk -F: '$7 !~ /nologin|false/ {print $1}' /etc/passwd); do
  EXPIRY=$(chage -l "$user" 2>/dev/null | grep "Password expires" | cut -d: -f2) || continue
  LAST_CHANGE=$(chage -l "$user" 2>/dev/null | grep "Last password change" | cut -d: -f2) || continue
  echo "  $user: expires${EXPIRY}, last changed${LAST_CHANGE}"
done

echo "--- SSH Authorized Keys ---"
for home in /home/* /root; do
  [[ -d "$home" ]] || continue
  USER=$(basename "$home")
  AK="$home/.ssh/authorized_keys"
  if [[ -f "$AK" ]]; then
    COUNT=$(wc -l < "$AK")
    echo "  $USER: $COUNT key(s)"
    if [[ $VERBOSE -ge 1 ]]; then
      # Show key types
      awk '{print $1}' "$AK" 2>/dev/null | sort | uniq -c | sed 's/^/    /' || true
    fi
    if [[ $VERBOSE -ge 2 ]]; then
      PERMS=$(stat -c '%a' "$AK" 2>/dev/null)
      echo "    Permissions: $PERMS"
      [[ "$PERMS" != "600" && "$PERMS" != "644" ]] && echo "    ⚠ Unusual permissions"
    fi
  fi
done

# ── Currently logged in ──
echo "--- Currently Logged In ---"
who 2>/dev/null || echo "  No one"

# ── Last login per user (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Last Login Per User ---"
  lastlog 2>/dev/null | grep -v "Never" | head -20 | sed 's/^/  /' || true

  echo "--- Home Directory Sizes ---"
  for home in /home/*; do
    [[ -d "$home" ]] || continue
    SIZE=$(du -sh "$home" 2>/dev/null | awk '{print $1}')
    echo "  $(basename "$home"): ${SIZE:-unknown}"
  done
fi

# ── Locked accounts (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Locked Accounts ---"
  awk -F: '$2 ~ /^!/ {print "  " $1}' /etc/shadow 2>/dev/null || echo "  Cannot read /etc/shadow (need sudo)"
fi
