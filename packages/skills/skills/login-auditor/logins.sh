#!/usr/bin/env bash
# login-auditor — Audit authentication events on Ubuntu
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Authentication event auditor. Tracks successful/failed logins, sudo
usage patterns, session durations, concurrent sessions, and unusual
login times or source IPs.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Login summary, failed attempts, active sessions
  -v             Include sudo audit, session durations, SSH keys used
  -vv            Include IP geolocation hints, unusual hours, PAM analysis
  -vvv           Full auth log dump

Examples:
  $(basename "$0")             # Quick login audit
  $(basename "$0") -v          # Include sudo and SSH details
  $(basename "$0") -vv         # Full authentication analysis
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

echo "=== Login Auditor ==="

echo "--- Currently Logged In ---"
who 2>/dev/null | sed 's/^/  /' || echo "  (who command unavailable)"
LOGGED_IN=$(who 2>/dev/null | wc -l)
echo "  Total sessions: $LOGGED_IN"

echo "--- Recent Logins (last 20) ---"
last -n 20 --time-format short 2>/dev/null | head -22 | sed 's/^/  /' || last -20 2>/dev/null | head -22 | sed 's/^/  /'

echo "--- Failed Login Attempts (last 24h) ---"
FAILED_COUNT=$(journalctl --no-pager --since "24h ago" 2>/dev/null | grep -ci "failed password\|authentication failure\|invalid user" || echo 0)
echo "  Count: $FAILED_COUNT"
if [[ "$FAILED_COUNT" -gt 0 ]]; then
  echo "  Top source IPs:"
  journalctl --no-pager --since "24h ago" 2>/dev/null | grep -i "failed password" | grep -oP 'from \K[\d.]+' | sort | uniq -c | sort -rn | head -10 | sed 's/^/    /'
  echo "  Top targeted users:"
  journalctl --no-pager --since "24h ago" 2>/dev/null | grep -i "failed password\|invalid user" | grep -oP '(user |for )\K\S+' | sort | uniq -c | sort -rn | head -10 | sed 's/^/    /'
fi

echo "--- Last Login Per User ---"
lastlog 2>/dev/null | grep -v "Never logged in" | head -20 | sed 's/^/  /' || echo "  lastlog unavailable"

echo "--- Account Lockouts ---"
if command -v faillock &>/dev/null; then
  faillock 2>/dev/null | grep -v "^$\|When" | sed 's/^/  /' || echo "  No locked accounts"
elif command -v pam_tally2 &>/dev/null; then
  pam_tally2 2>/dev/null | sed 's/^/  /' || echo "  No locked accounts"
else
  echo "  faillock/pam_tally2 not available"
fi

# ── Sudo audit (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Sudo Usage (last 24h) ---"
  SUDO_COUNT=$(journalctl --no-pager --since "24h ago" 2>/dev/null | grep -c "sudo:" || echo 0)
  echo "  Total sudo invocations: $SUDO_COUNT"
  if [[ "$SUDO_COUNT" -gt 0 ]]; then
    echo "  By user:"
    journalctl --no-pager --since "24h ago" 2>/dev/null | grep "sudo:" | grep -oP '^\S+ \S+ \S+ \S+ sudo:\s+\K\S+' | sort | uniq -c | sort -rn | head -10 | sed 's/^/    /'
    echo "  Recent commands:"
    journalctl --no-pager --since "24h ago" 2>/dev/null | grep "sudo:" | grep "COMMAND=" | tail -10 | sed 's/^/    /'
  fi

  echo "--- SSH Key Authentication ---"
  SSH_KEY_COUNT=$(journalctl --no-pager --since "24h ago" 2>/dev/null | grep -c "Accepted publickey" || echo 0)
  SSH_PASS_COUNT=$(journalctl --no-pager --since "24h ago" 2>/dev/null | grep -c "Accepted password" || echo 0)
  echo "  Key-based logins (24h): $SSH_KEY_COUNT"
  echo "  Password logins (24h):  $SSH_PASS_COUNT"
  if [[ $SSH_PASS_COUNT -gt 0 ]]; then
    echo "  ⚠ Password authentication in use — consider key-only"
  fi

  echo "--- Session Durations (recent) ---"
  last -n 10 --time-format short 2>/dev/null | grep -v "still\|reboot\|wtmp\|^$" | awk '{print $1, $NF}' | head -10 | sed 's/^/  /' || true
fi

# ── Unusual patterns (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Off-Hours Logins (22:00-06:00) ---"
  journalctl --no-pager --since "7 days ago" 2>/dev/null | grep -i "accepted\|session opened" | awk '{
    split($3, t, ":");
    h = t[1] + 0;
    if (h >= 22 || h < 6) print "  " $0
  }' | tail -15 || echo "  None detected"

  echo "--- Concurrent Sessions per User ---"
  who 2>/dev/null | awk '{print $1}' | sort | uniq -c | sort -rn | while read -r count user; do
    if [[ $count -gt 1 ]]; then
      echo "  ⚠ $user has $count concurrent sessions"
    else
      echo "  $user: $count session"
    fi
  done

  echo "--- Root Login Attempts ---"
  ROOT_ATTEMPTS=$(journalctl --no-pager --since "7 days ago" 2>/dev/null | grep -ci "user root\|user=root" || echo 0)
  echo "  Direct root login attempts (7d): $ROOT_ATTEMPTS"
fi

# ── Full dump (verbose 3) ──
if [[ $VERBOSE -ge 3 ]]; then
  echo "--- Full Auth Log (last 50 entries) ---"
  journalctl --no-pager -u ssh -u sshd --since "24h ago" 2>/dev/null | tail -50 | sed 's/^/  /' || true

  echo "--- /var/log/auth.log tail ---"
  tail -50 /var/log/auth.log 2>/dev/null | sed 's/^/  /' || echo "  auth.log not accessible"

  echo "--- utmp/wtmp stats ---"
  echo "  utmp entries: $(utmpdump /var/run/utmp 2>/dev/null | wc -l || echo '?')"
  echo "  wtmp entries: $(utmpdump /var/log/wtmp 2>/dev/null | wc -l || echo '?')"
fi
