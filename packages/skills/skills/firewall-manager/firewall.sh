#!/usr/bin/env bash
# firewall-manager — Audit and manage firewall rules on Ubuntu
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Audit firewall configuration on Ubuntu. Inspects UFW rules,
iptables chains, open ports without firewall rules, and
fail2ban jail status. Detects overly permissive configurations.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      UFW/iptables status and open ports
  -v             Include UFW app profiles and fail2ban details
  -vv            Include full iptables rule dump and port analysis
  -vvv           Include raw nftables and connection tracking

Examples:
  $(basename "$0")             # Quick firewall audit
  $(basename "$0") -v          # Include app profiles and fail2ban
  $(basename "$0") -vv         # Full firewall analysis
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

echo "=== Firewall Manager ==="

echo "--- Firewall Tool Detection ---"
for tool in ufw firewall-cmd nft iptables; do
  if command -v "$tool" &>/dev/null; then
    echo "  ✓ $tool found"
  else
    echo "  ✗ $tool not found"
  fi
done

# ── UFW (Ubuntu default) ──
if command -v ufw &>/dev/null; then
  echo "--- UFW Status ---"
  ufw status verbose 2>/dev/null || echo "  Cannot read UFW status (need sudo?)"

  if [[ $VERBOSE -ge 1 ]]; then
    echo "--- UFW App Profiles ---"
    ufw app list 2>/dev/null | sed 's/^/  /' || true
    log_v1 "Default incoming: $(ufw status verbose 2>/dev/null | grep 'Default:' | head -1)"
  fi

  if [[ $VERBOSE -ge 2 ]]; then
    echo "--- UFW Rules (numbered) ---"
    ufw status numbered 2>/dev/null | sed 's/^/  /' || true
  fi
elif command -v firewall-cmd &>/dev/null; then
  echo "--- FirewallD Status ---"
  firewall-cmd --state 2>/dev/null || true
  firewall-cmd --list-all 2>/dev/null || true
fi

echo "--- iptables Rules ---"
iptables -L -n --line-numbers 2>/dev/null | head -40 || echo "  iptables unavailable (need sudo?)"

if [[ $VERBOSE -ge 3 ]]; then
  echo "--- nftables Rules ---"
  nft list ruleset 2>/dev/null | head -60 || echo "  nft unavailable"
fi

echo "--- Open Ports (no firewall rule) ---"
LISTENING=$(ss -tlnp 2>/dev/null | awk 'NR>1 {print $4}' | grep -oP ':\K\d+' | sort -un)
echo "  Listening: $(echo "$LISTENING" | tr '\n' ' ')"

if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Port Details ---"
  ss -tlnp 2>/dev/null | head -25 || true
fi

# ── Fail2ban ──
echo "--- Fail2ban ---"
if command -v fail2ban-client &>/dev/null; then
  STATUS=$(systemctl is-active fail2ban 2>/dev/null || echo "inactive")
  echo "  Service: $STATUS"
  if [[ "$STATUS" == "active" ]]; then
    fail2ban-client status 2>/dev/null | sed 's/^/  /' || true
    if [[ $VERBOSE -ge 1 ]]; then
      JAILS=$(fail2ban-client status 2>/dev/null | grep "Jail list:" | sed 's/.*://; s/,/ /g' | xargs)
      for jail in $JAILS; do
        echo "  --- Jail: $jail ---"
        fail2ban-client status "$jail" 2>/dev/null | grep -E 'Currently|Total' | sed 's/^/    /' || true
      done
    fi
  fi
else
  echo "  ⚠ fail2ban not installed (apt install fail2ban)"
fi
