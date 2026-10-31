#!/usr/bin/env bash
# dns-manager — Audit and manage DNS resolution on Ubuntu
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

DNS resolution audit and management. Checks resolv.conf, validates
upstream resolvers respond, detects split-horizon mismatches,
verifies DNSSEC support, and alerts on resolution failures.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      resolv.conf, resolver health, basic lookups
  -v             Include DNSSEC checks and systemd-resolved status
  -vv            Include split-horizon detection and full resolver trace
  -vvv           Full DNS diagnostic dump

Examples:
  $(basename "$0")             # Quick DNS audit
  $(basename "$0") -v          # Include DNSSEC checks
  $(basename "$0") -vv         # Full DNS diagnostics
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

echo "=== DNS Manager ==="

echo "--- resolv.conf ---"
if [[ -f /etc/resolv.conf ]]; then
  # Show if it's a symlink
  if [[ -L /etc/resolv.conf ]]; then
    TARGET=$(readlink -f /etc/resolv.conf)
    echo "  Symlink → $TARGET"
  fi
  echo "  Nameservers:"
  grep -E '^nameserver' /etc/resolv.conf | sed 's/^/    /' || echo "    (none)"
  echo "  Search domains:"
  grep -E '^search|^domain' /etc/resolv.conf | sed 's/^/    /' || echo "    (none)"
  echo "  Options:"
  grep -E '^options' /etc/resolv.conf | sed 's/^/    /' || echo "    (defaults)"
else
  echo "  ⚠ /etc/resolv.conf not found"
fi

echo "--- Resolver Health ---"
# Test each configured nameserver
NAMESERVERS=$(grep -E '^nameserver' /etc/resolv.conf 2>/dev/null | awk '{print $2}' || true)
TEST_DOMAIN="google.com"
for ns in $NAMESERVERS; do
  if dig +short +timeout=3 +tries=1 "$TEST_DOMAIN" "@$ns" >/dev/null 2>&1; then
    LATENCY=$(dig +noall +stats "$TEST_DOMAIN" "@$ns" 2>/dev/null | grep 'Query time' | awk '{print $4 " " $5}')
    echo "  ✓ $ns — responsive ($LATENCY)"
  else
    echo "  ✗ $ns — FAILED to resolve $TEST_DOMAIN"
  fi
done

echo "--- Basic Resolution Test ---"
for domain in google.com github.com apt.ubuntu.com; do
  RESULT=$(dig +short "$domain" 2>/dev/null | head -3 | tr '\n' ', ' | sed 's/,$//')
  if [[ -n "$RESULT" ]]; then
    echo "  ✓ $domain → $RESULT"
  else
    echo "  ✗ $domain — resolution FAILED"
  fi
done

echo "--- Reverse DNS ---"
# Check if this node's IPs have valid PTR records
for ip in $(hostname -I 2>/dev/null | tr ' ' '\n' | head -3); do
  PTR=$(dig +short -x "$ip" 2>/dev/null | head -1)
  if [[ -n "$PTR" ]]; then
    echo "  $ip → $PTR"
  else
    echo "  $ip → (no PTR record)"
  fi
done

# ── systemd-resolved status (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- systemd-resolved ---"
  if systemctl is-active systemd-resolved &>/dev/null; then
    echo "  Status: active"
    resolvectl status 2>/dev/null | grep -E 'DNS Server|DNS Domain|DNSSEC' | head -10 | sed 's/^/  /' || true
  else
    echo "  Not running (using direct resolv.conf)"
  fi

  echo "--- DNSSEC Validation ---"
  # Test DNSSEC with a known signed zone
  DNSSEC_RESULT=$(dig +dnssec +short dnssec.works 2>/dev/null | head -1)
  if [[ -n "$DNSSEC_RESULT" ]]; then
    echo "  ✓ DNSSEC validation working (dnssec.works resolved)"
  else
    echo "  ⚠ DNSSEC may not be enabled or working"
  fi
  # Test with a known DNSSEC-failing domain
  FAIL_RESULT=$(dig +dnssec +short fail01.dnssec.works 2>/dev/null | head -1)
  if [[ -z "$FAIL_RESULT" ]]; then
    echo "  ✓ DNSSEC correctly rejects invalid signatures"
  else
    echo "  ⚠ DNSSEC validation may not be enforced (resolved despite bad sig)"
  fi
fi

# ── Split-horizon detection (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Split-Horizon Check ---"
  HOSTNAME_FQDN=$(hostname -f 2>/dev/null || hostname)
  for ns in $NAMESERVERS; do
    RESULT=$(dig +short "$HOSTNAME_FQDN" "@$ns" 2>/dev/null | head -1)
    echo "  $ns resolves $(hostname -f 2>/dev/null || hostname) → ${RESULT:-(NXDOMAIN)}"
  done
  # Also check against public resolvers
  for public in 8.8.8.8 1.1.1.1; do
    RESULT=$(dig +short +timeout=3 "$HOSTNAME_FQDN" "@$public" 2>/dev/null | head -1)
    echo "  $public resolves $(hostname -f 2>/dev/null || hostname) → ${RESULT:-(NXDOMAIN)}"
  done

  echo "--- DNS Trace ($(hostname -f 2>/dev/null || hostname)) ---"
  dig +trace +nodnssec "$(hostname -f 2>/dev/null || hostname)" 2>/dev/null | tail -10 | sed 's/^/  /' || echo "  trace unavailable"
fi

# ── Full dump (verbose 3) ──
if [[ $VERBOSE -ge 3 ]]; then
  echo "--- /etc/nsswitch.conf (hosts line) ---"
  grep hosts /etc/nsswitch.conf 2>/dev/null | sed 's/^/  /' || echo "  not found"

  echo "--- /etc/hosts entries ---"
  grep -v '^#\|^$' /etc/hosts 2>/dev/null | sed 's/^/  /' || echo "  empty"

  echo "--- DNS Cache Stats ---"
  resolvectl statistics 2>/dev/null | sed 's/^/  /' || echo "  resolvectl statistics unavailable"
fi
