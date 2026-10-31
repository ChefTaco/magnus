#!/usr/bin/env bash
# network-diagnostics — Run network health checks on Ubuntu
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Network health toolkit for Ubuntu servers. Tests connectivity,
DNS resolution, routing, interface status, and identifies
listening services. Supports Netplan and systemd-resolved.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Interface status, routing, DNS, and connectivity
  -v             Include Netplan config, MTU, and connection stats
  -vv            Include systemd-resolved details and ARP table
  -vvv           Include full routing table and interface details

Examples:
  $(basename "$0")             # Quick network check
  $(basename "$0") -v          # Include Netplan and MTU
  $(basename "$0") -vv         # Full network audit
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

echo "=== Network Diagnostics ==="

echo "--- Interfaces ---"
ip -brief addr 2>/dev/null || ifconfig 2>/dev/null || echo "  No IP tool"

if [[ $VERBOSE -ge 1 ]]; then
  echo "--- MTU Settings ---"
  ip link show 2>/dev/null | grep -E 'mtu' | awk '{print "  " $2, "mtu=" $5}' || true
fi

echo "--- Default Route ---"
ip route show default 2>/dev/null || route -n 2>/dev/null | head -5 || true

if [[ $VERBOSE -ge 3 ]]; then
  echo "--- Full Routing Table ---"
  ip route show 2>/dev/null | sed 's/^/  /' || true
fi

echo "--- DNS Resolution ---"
for host in google.com cloudflare.com github.com; do
  RESULT=$(dig +short "$host" A 2>/dev/null | head -1)
  if [[ -n "$RESULT" ]]; then
    echo "  ✓ $host → $RESULT"
  else
    echo "  ✗ $host — FAILED"
  fi
done

# ── systemd-resolved (Ubuntu default) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- DNS Resolver ---"
  if command -v resolvectl &>/dev/null; then
    resolvectl status 2>/dev/null | grep -E 'DNS Servers|DNS Domain|DNSSEC|Current' | head -10 | sed 's/^/  /' || true
  elif [[ -f /etc/resolv.conf ]]; then
    grep nameserver /etc/resolv.conf | sed 's/^/  /'
  fi
fi

if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Resolved Statistics ---"
  resolvectl statistics 2>/dev/null | sed 's/^/  /' || true
fi

echo "--- Connectivity ---"
ping -c 2 -W 3 8.8.8.8 2>/dev/null | tail -2 || echo "  Ping to 8.8.8.8 failed"

echo "--- Listening Services ---"
ss -tlnp 2>/dev/null | head -20 || true

echo "--- Established Connections ---"
CONN_COUNT=$(ss -tnp state established 2>/dev/null | wc -l)
echo "  Established connections: $CONN_COUNT"

if [[ $VERBOSE -ge 1 ]]; then
  echo "  Top remote addresses:"
  ss -tnp state established 2>/dev/null | awk 'NR>1 {print $5}' | cut -d: -f1 | sort | uniq -c | sort -rn | head -10 | sed 's/^/    /' || true
fi

# ── Netplan (Ubuntu) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Netplan Configuration ---"
  if command -v netplan &>/dev/null; then
    for f in /etc/netplan/*.yaml; do
      [[ -f "$f" ]] || continue
      echo "  $f:"
      cat "$f" 2>/dev/null | sed 's/^/    /' || true
    done
  else
    echo "  Netplan not available"
  fi
fi

# ── ARP table (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- ARP Table ---"
  ip neigh show 2>/dev/null | head -20 | sed 's/^/  /' || true
fi

# ── Connection stats (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Socket Statistics ---"
  ss -s 2>/dev/null | sed 's/^/  /' || true
fi
