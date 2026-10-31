#!/usr/bin/env bash
# security-auditor — Audit system security posture on Ubuntu
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Security posture assessment for Ubuntu servers. Audits user accounts,
SSH configuration, open ports, SUID binaries, file permissions,
AppArmor status, and unattended-upgrades configuration.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Key security checks and open ports
  -v             Include AppArmor, failed logins, and sudo config
  -vv            Include full SUID listing and SSH key audit
  -vvv           Full security dump

Examples:
  $(basename "$0")             # Quick security audit
  $(basename "$0") -v          # Include AppArmor and logins
  $(basename "$0") -vv         # Full security assessment
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

echo "=== Security Auditor ==="

echo "--- Users with Login Shell ---"
grep -v '/nologin\|/false' /etc/passwd | awk -F: '{printf "  %-20s UID=%-6s %s\n", $1, $3, $7}' || true

echo "--- Users with UID 0 ---"
awk -F: '$3 == 0 {print "  " $1}' /etc/passwd

echo "--- SUID Binaries ---"
SUID_COUNT=$(find / -perm -4000 -type f 2>/dev/null | wc -l)
echo "  Found: $SUID_COUNT SUID binaries"
if [[ $VERBOSE -ge 2 ]]; then
  find / -perm -4000 -type f 2>/dev/null | head -30 | sed 's/^/  /'
else
  find / -perm -4000 -type f 2>/dev/null | head -15 | sed 's/^/  /'
fi

echo "--- Listening Ports ---"
ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo "  ss/netstat unavailable"

echo "--- SSH Config Highlights ---"
if [[ -f /etc/ssh/sshd_config ]]; then
  for key in PermitRootLogin PasswordAuthentication PubkeyAuthentication PermitEmptyPasswords MaxAuthTries X11Forwarding; do
    VAL=$(grep -i "^$key" /etc/ssh/sshd_config 2>/dev/null | head -1 || echo "  $key: (default)")
    echo "  $VAL"
  done
else
  echo "  sshd_config not found"
fi

echo "--- World-Writable Files in /etc ---"
WW_COUNT=$(find /etc -perm -o+w -type f 2>/dev/null | wc -l)
if [[ $WW_COUNT -gt 0 ]]; then
  echo "  ⚠ $WW_COUNT world-writable file(s):"
  find /etc -perm -o+w -type f 2>/dev/null | head -20 | sed 's/^/    /'
else
  echo "  ✓ None"
fi

echo "--- Firewall Status ---"
if command -v ufw &>/dev/null; then
  UFW_STATUS=$(ufw status 2>/dev/null | head -1)
  echo "  UFW: $UFW_STATUS"
else
  echo "  ⚠ UFW not installed"
fi

# ── AppArmor (Ubuntu, verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- AppArmor ---"
  if command -v aa-status &>/dev/null; then
    aa-status 2>/dev/null | head -15 | sed 's/^/  /' || echo "  Cannot read AppArmor (need sudo?)"
  else
    echo "  AppArmor tools not installed"
  fi
fi

# ── Failed logins (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Failed Login Attempts (last 24h) ---"
  FAILED=$(journalctl --no-pager --since "24h ago" 2>/dev/null | grep -ci "failed password\|authentication failure" || echo 0)
  echo "  Count: $FAILED"
  if [[ $FAILED -gt 0 ]]; then
    echo "  Top IPs:"
    journalctl --no-pager --since "24h ago" 2>/dev/null | grep -i "failed password" | grep -oP 'from \K[\d.]+' | sort | uniq -c | sort -rn | head -5 | sed 's/^/    /' || true
  fi

  echo "--- Sudo Configuration ---"
  echo "  Sudoers files:"
  ls -la /etc/sudoers.d/ 2>/dev/null | tail -n +2 | sed 's/^/    /' || echo "    None"
  echo "  Users in sudo group:"
  getent group sudo 2>/dev/null | cut -d: -f4 | tr ',' '\n' | sed 's/^/    /' || true
fi

# ── Unattended-upgrades check (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Unattended-Upgrades ---"
  if dpkg -l unattended-upgrades &>/dev/null 2>&1; then
    echo "  ✓ Installed"
    systemctl is-active apt-daily-upgrade.timer &>/dev/null && echo "  ✓ Timer active" || echo "  ⚠ Timer inactive"
  else
    echo "  ⚠ Not installed (recommended: apt install unattended-upgrades)"
  fi
fi

# ── SSH key audit (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- SSH Authorized Keys Audit ---"
  for home in /home/* /root; do
    [[ -d "$home" ]] || continue
    USER=$(basename "$home")
    AK="$home/.ssh/authorized_keys"
    if [[ -f "$AK" ]]; then
      COUNT=$(wc -l < "$AK")
      PERMS=$(stat -c '%a' "$AK" 2>/dev/null)
      echo "  $USER: $COUNT key(s), perms=$PERMS"
      if [[ "$PERMS" != "600" && "$PERMS" != "644" ]]; then
        echo "    ⚠ Unusual permissions (expected 600 or 644)"
      fi
    fi
  done
fi
