#!/usr/bin/env bash
# Lightweight repository secret scanner for Hive. It scans tracked and
# non-ignored files only, so private local .env files stay outside the gate.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v rg >/dev/null 2>&1; then
  echo "ERROR: ripgrep (rg) is required for scripts/scan-secrets.sh" >&2
  exit 2
fi

TMP_FILES=$(mktemp /tmp/hive-secret-scan-files-XXXXXX)
TMP_MATCHES=$(mktemp /tmp/hive-secret-scan-matches-XXXXXX)
trap 'rm -f "$TMP_FILES" "$TMP_MATCHES"' EXIT
PLACEHOLDER_PATTERN='change_me_|replace-with|playwright-secret|example|dummy|placeholder|\$\{|<[^>]+>|your-'

{
  git ls-files
  git ls-files --others --exclude-standard
} | sort -u \
  | rg -v '(^|/)(node_modules|dist|build|coverage|playwright-report|test-results|output|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)(/|$)' \
  | rg -v '(^|/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$' \
  > "$TMP_FILES"

if [[ ! -s "$TMP_FILES" ]]; then
  echo "No files to scan."
  exit 0
fi

PATTERNS=(
  "DEPLOY_PASSWORD[[:space:]]*=[[:space:]]*[^[:space:]#\"'<>]{8,}"
  "SSH_PASSWORD[[:space:]]*=[[:space:]]*[^[:space:]#\"'<>]{8,}"
  "IAM_AGENT_SECRET[[:space:]]*=[[:space:]]*[^[:space:]#\"'<>]{16,}"
  "HIVE_ROUTER_SECRET[[:space:]]*=[[:space:]]*[^[:space:]#\"'<>]{24,}"
  "HIVEMEM_JWT_SECRET[[:space:]]*=[[:space:]]*[^[:space:]#\"'<>]{24,}"
  "sk-[A-Za-z0-9_-]{24,}"
  "-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----"
)

while IFS= read -r file; do
  [[ -f "$file" ]] || continue
  for pattern in "${PATTERNS[@]}"; do
    if matches=$(rg -n --no-heading --color=never -e "$pattern" -- "$file"); then
      while IFS= read -r match; do
        [[ -n "$match" ]] || continue
        if [[ "$match" =~ $PLACEHOLDER_PATTERN ]]; then
          continue
        fi
        printf '%s:%s\n' "$file" "$match" >> "$TMP_MATCHES"
      done <<< "$matches"
    else
      rc=$?
      if [[ "$rc" -ne 1 ]]; then
        echo "ERROR: rg failed while scanning $file" >&2
        exit "$rc"
      fi
    fi
  done
done < "$TMP_FILES"

if [[ -s "$TMP_MATCHES" ]]; then
  echo "Potential secrets detected:" >&2
  sed 's/^/  /' "$TMP_MATCHES" >&2
  echo "Redact the value, move it to an ignored env/secret store, or narrow the scanner if this is a false positive." >&2
  exit 1
fi

echo "Secret scan passed."
