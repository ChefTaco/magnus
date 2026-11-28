#!/usr/bin/env bash
# Blocks private data from entering git history.
#
#   check-private-data.sh --staged        check files staged for commit (pre-commit hook)
#   check-private-data.sh --message FILE  check a commit message (commit-msg hook)
#   check-private-data.sh                 check every tracked file (CI and manual use)
#
# Two layers:
#   1. Forbidden paths: env files, keys, certificates, databases, backups, and
#      private agent notes (*.local.md) may never be committed.
#   2. Private terms: an optional, gitignored `.private-terms` file at the repo
#      root lists one extended regex per line (case-insensitive) for names that
#      must never appear in the repo or in commit messages, such as personal
#      hostnames, private network domains, usernames, or private project names.
#      Lines starting with # and blank lines are ignored. The file is local so
#      the denylist itself never becomes public.
set -euo pipefail
shopt -s nocasematch

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

MODE="tracked"
MESSAGE_FILE=""
case "${1:-}" in
  --staged) MODE="staged" ;;
  --message) MODE="message"; MESSAGE_FILE="${2:?--message requires a file}" ;;
  "") ;;
  *) echo "usage: $0 [--staged | --message FILE]" >&2; exit 2 ;;
esac

TERMS_FILE="$ROOT_DIR/.private-terms"
TERMS_PATTERN=""
if [[ -f "$TERMS_FILE" ]]; then
  terms_status=0
  terms="$(grep -vE '^[[:space:]]*(#|$)' -- "$TERMS_FILE")" || terms_status=$?
  if [[ "$terms_status" -gt 1 ]]; then
    echo 'private-data check: cannot read .private-terms' >&2
    exit 2
  fi
  TERMS_PATTERN="$(paste -sd '|' - <<< "$terms")"
fi

if [[ -n "$TERMS_PATTERN" ]]; then
  if grep -qiE -- "$TERMS_PATTERN" </dev/null; then :
  elif [[ "$?" -gt 1 ]]; then
    echo 'private-data check: invalid regular expression in .private-terms' >&2
    exit 2
  fi
fi

FORBIDDEN_PATHS='(^|/)\.env($|\.)|(^|/)\.npmrc$|\.(pem|key|crt|p12|pfx|db|sqlite|sqlite3|bundle)(-(wal|shm|journal))?$|(^|/)(certs|backups|state|artifacts|\.magnus|\.hive-dev|\.ssh|audit-logs|terminal-audit)/|(^|/)[^/]+\.local\.md$|(^|/)\.private-terms$|(^|/)\.vscode/mcp\.json$'
ALLOWED_PATHS='\.env\.example$'

failures=0
fail() {
  printf 'private-data check: %s\n' "$1" >&2
  failures=$((failures + 1))
}
# A path that itself contains a private term is never printed.
shown() {
  if [[ -n "$TERMS_PATTERN" ]] && grep -qiE -- "$TERMS_PATTERN" <<< "$1"; then printf '(path redacted)'; else printf '%s' "$1"; fi
}

# Scratch space for staged blobs, filtered messages and search results; removed on exit.
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

# Prints the numbers of the lines in file $1 that contain a private term. grep reads the whole
# file into a file of its own (no -q early exit and no pipe, where under pipefail an early exit
# can surface as SIGPIPE, exit 141, and pass as "no match"), and any grep error stops the check.
term_lines() {
  local status=0
  grep -naiE -- "$TERMS_PATTERN" "$1" > "$scratch/hits" || status=$?
  case "$status" in
    0) cut -d: -f1 -- "$scratch/hits" ;;
    1) ;;
    *) echo 'private-data check: could not search for private terms' >&2; exit 2 ;;
  esac
}

if [[ "$MODE" == "message" ]]; then
  if [[ -n "$TERMS_PATTERN" ]]; then
    filter_status=0
    grep -vE '^#' -- "$MESSAGE_FILE" > "$scratch/message" || filter_status=$?
    if [[ "$filter_status" -gt 1 ]]; then
      echo 'private-data check: could not read the commit message file' >&2
      exit 2
    fi
    message_lines="$(term_lines "$scratch/message")"
    if [[ -n "$message_lines" ]]; then
      fail "commit message contains a term listed in .private-terms"
    fi
  fi
  [[ "$failures" -eq 0 ]] || exit 1
  exit 0
fi

if [[ "$MODE" == "staged" ]]; then
  mapfile -d '' -t files < <(git diff --cached --name-only --diff-filter=ACMR -z)
else
  mapfile -d '' -t files < <(git ls-files -z)
fi

for file in "${files[@]}"; do
  [[ -n "$file" ]] || continue
  if [[ "$file" =~ $FORBIDDEN_PATHS && ! "$file" =~ $ALLOWED_PATHS ]]; then
    fail "forbidden file: $(shown "$file")"
  fi
done

if [[ -n "$TERMS_PATTERN" && "${#files[@]}" -gt 0 ]]; then
  index_file="$scratch/index"
  for file in "${files[@]}"; do
    [[ -n "$file" ]] || continue
    if [[ "$MODE" == "staged" ]]; then
      git show ":$file" > "$index_file"
      content_file="$index_file"
    else
      [[ -f "$file" ]] || continue
      content_file="$file"
    fi
    display="$(shown "$file")"
    # A plain assignment, so a search error (exit 2 from term_lines) stops the check.
    content_lines="$(term_lines "$content_file")"
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      fail "private term in $display:$line [redacted]"
    done <<< "$content_lines"
    if [[ "$display" != "$file" ]]; then
      fail "private term in file name: $display"
    fi
  done
fi

if [[ "$failures" -gt 0 ]]; then
  echo "private-data check failed with $failures finding(s). Remove the data, or genericize it (example.com hosts, env vars)." >&2
  exit 1
fi
echo "Private data check passed."
