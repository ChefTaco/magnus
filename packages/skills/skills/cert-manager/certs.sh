#!/usr/bin/env bash
# cert-manager — Monitor TLS/SSL certificate expiration
set -euo pipefail

VERBOSE=0
WARN_DAYS=30

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS] [WARN_DAYS]

Monitor TLS/SSL certificate expiration dates across the system.
Scans /etc/ssl, /etc/letsencrypt, and custom paths. Checks
certificate chains, auto-renewal timers, and alerts on expiring certs.

Positional arguments:
  WARN_DAYS      Alert threshold in days (default: 30)

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Expiring/valid certificate summary
  -v             Include certificate subject/issuer details
  -vv            Include chain validation and key info
  -vvv           Full openssl x509 output for each cert

Examples:
  $(basename "$0")             # Check certs with 30-day warning
  $(basename "$0") 14          # Warn for certs expiring within 14 days
  $(basename "$0") -vv 60      # Detailed audit, 60-day threshold
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

[[ $# -ge 1 ]] && WARN_DAYS="$1"

CERT_DIRS=("/etc/ssl/certs" "/etc/letsencrypt/live" "/etc/pki/tls/certs")

echo "=== Certificate Manager ==="
echo "Warning threshold: ${WARN_DAYS} days"

echo "--- Local Certificates ---"
EXPIRING=0
VALID=0
for dir in "${CERT_DIRS[@]}"; do
  [[ -d "$dir" ]] || continue
  log_v1 "Scanning $dir"
  find "$dir" -name "*.pem" -o -name "*.crt" 2>/dev/null | while read -r cert; do
    EXPIRY=$(openssl x509 -enddate -noout -in "$cert" 2>/dev/null | cut -d= -f2) || continue
    EXPIRY_EPOCH=$(date -d "$EXPIRY" +%s 2>/dev/null) || continue
    NOW_EPOCH=$(date +%s)
    DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
    if [[ $DAYS_LEFT -lt 0 ]]; then
      echo "  ✗ $cert — EXPIRED ($EXPIRY)"
    elif [[ $DAYS_LEFT -lt $WARN_DAYS ]]; then
      echo "  ⚠ $cert — expires in ${DAYS_LEFT}d ($EXPIRY)"
    else
      echo "  ✓ $cert — ${DAYS_LEFT}d remaining"
    fi
    if [[ $VERBOSE -ge 1 ]]; then
      SUBJECT=$(openssl x509 -subject -noout -in "$cert" 2>/dev/null | sed 's/subject=//')
      ISSUER=$(openssl x509 -issuer -noout -in "$cert" 2>/dev/null | sed 's/issuer=//')
      echo "      Subject: $SUBJECT"
      echo "      Issuer:  $ISSUER"
    fi
    if [[ $VERBOSE -ge 2 ]]; then
      KEY_SIZE=$(openssl x509 -text -noout -in "$cert" 2>/dev/null | grep "Public-Key:" | head -1)
      SIG_ALG=$(openssl x509 -text -noout -in "$cert" 2>/dev/null | grep "Signature Algorithm:" | head -1)
      echo "      ${KEY_SIZE:-}"
      echo "      ${SIG_ALG:-}"
      # Chain validation
      openssl verify "$cert" 2>/dev/null | sed 's/^/      /' || true
    fi
    if [[ $VERBOSE -ge 3 ]]; then
      openssl x509 -text -noout -in "$cert" 2>/dev/null | sed 's/^/      /'
    fi
  done
done

echo "--- Let's Encrypt Status ---"
if command -v certbot &>/dev/null; then
  certbot certificates 2>/dev/null | grep -E "Domains:|Expiry" || echo "No certbot certs"
  if [[ $VERBOSE -ge 1 ]]; then
    echo "  Certbot version: $(certbot --version 2>/dev/null)"
    echo "  Renewal timer:"
    systemctl status certbot.timer 2>/dev/null | grep -E 'Active|Trigger' | sed 's/^/    /' || echo "    No certbot timer found"
  fi
else
  echo "  certbot not installed"
fi

# ── Auto-renewal check ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Auto-Renewal ---"
  if systemctl is-active certbot.timer &>/dev/null; then
    echo "  ✓ certbot.timer is active"
  elif [[ -f /etc/cron.d/certbot ]]; then
    echo "  ✓ certbot cron job exists"
  else
    echo "  ⚠ No auto-renewal mechanism detected"
  fi
fi
