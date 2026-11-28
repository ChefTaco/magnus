#!/usr/bin/env bash
# Regression test: scripts/check-private-data.sh and the pre-push hook fail closed.
#
# A large input (a new branch's whole history, or a long commit message) that contains a
# private term must fail. The check once piped `grep -v` into `grep -q`; under pipefail the
# early exit of `grep -q` turned a match on a large input into SIGPIPE (exit 141), which the
# check read as "no match". A clean large input must pass, and a commit that only removes a
# term that is already published must be pushable without bypassing the hooks.
#
# Uses only a fake term from a test-only terms file, in disposable repositories.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Hooks pass Git environment variables; never let fixtures touch the caller's repository.
for variable in $(git rev-parse --local-env-vars); do unset "$variable"; done

failures=0
problem() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}
# Runs a command, storing its combined output in $WORK/out and its exit status in $status.
run() {
  status=0
  "$@" > "$WORK/out" 2>&1 || status=$?
}
expect_status() {
  [[ "$status" -eq "$1" ]] || problem "$2: exit status $status, expected $1"
  if grep -qiF planted "$WORK/out"; then problem "$2: output contains the planted term"; fi
}

# The fake term is assembled at run time so this file never contains it literally.
TERM_VALUE="zq$(printf 'x%.0s' 1 2)planted$((40 + 2))"
FILLER='filler line of a long commit history that holds no private names at all'
# 50 MB of filler. Process substitution, not a pipe: `yes` ends on SIGPIPE by design.
filler() { head -c 50000000 < <(yes "$FILLER"); }

mkdir -p "$WORK/repo/scripts" "$WORK/repo/.githooks"
cp "$ROOT_DIR/scripts/check-private-data.sh" "$WORK/repo/scripts/"
cp "$ROOT_DIR/.githooks/pre-push" "$WORK/repo/.githooks/"
# The secret scanner is tested elsewhere; here it only has to consume the push input.
printf '#!/usr/bin/env bash\ncat > /dev/null\n' > "$WORK/repo/scripts/gitleaks.sh"
cd "$WORK/repo"
git init -q -b main
git config user.name 'Privacy Fixture'
git config user.email 'fixture@example.com'
git config core.hooksPath /dev/null
printf '%s\n' '.private-terms' > .gitignore
printf '%s\n' '# test-only denylist' 'zqx+planted[0-9]+' > .private-terms

# --- large commit-message input ----------------------------------------------------------
{ printf 'fix: name %s\n\n' "$TERM_VALUE"; filler; } > "$WORK/large-dirty"
run bash scripts/check-private-data.sh --message "$WORK/large-dirty"
expect_status 1 "50 MB message with a term on its first line"
{ filler; printf '\nfix: name %s\n' "$TERM_VALUE"; } > "$WORK/large-dirty-end"
run bash scripts/check-private-data.sh --message "$WORK/large-dirty-end"
expect_status 1 "50 MB message with a term on its last line"
filler > "$WORK/large-clean"
run bash scripts/check-private-data.sh --message "$WORK/large-clean"
expect_status 0 "clean 50 MB message"
run bash scripts/check-private-data.sh --message "$WORK/missing-message"
expect_status 2 "missing message file"

# --- pre-push over many commits ------------------------------------------------------------
# Builds $2 commits on branch $1 with fast-import; commit number $3 (0 for none) names the term.
many_commits() {
  local branch="$1" count="$2" dirty="$3" i message
  {
    for ((i = 1; i <= count; i++)); do
      message="chore: commit $i $FILLER"
      [[ "$i" -ne "$dirty" ]] || message="fix: name $TERM_VALUE"
      printf 'commit refs/heads/%s\ncommitter Privacy Fixture <fixture@example.com> %d +0000\n' "$branch" "$((1700000000 + i))"
      printf 'data %d\n%s\n' "$((${#message} + 1))" "$message"
      [[ "$i" -ne 1 ]] || printf 'M 644 inline clean.txt\ndata 6\nclean\n'
      printf '\n'
    done
  } | git fast-import --quiet
}
zero=0000000000000000000000000000000000000000
push() { # push <branch>: runs the pre-push hook for a new branch, as `git push` would
  printf 'refs/heads/%s %s refs/heads/%s %s\n' "$1" "$(git rev-parse "$1")" "$1" "$zero" > "$WORK/push"
  git checkout -q -f "$1"
  run bash .githooks/pre-push origin "file://$WORK/remote.git" < "$WORK/push"
}

many_commits dirty 3000 3000
push dirty
expect_status 1 "new branch of 3000 commits whose newest message names a term"
many_commits clean 3000 0
many_commits middle 3000 1500
push middle
expect_status 1 "new branch of 3000 commits with a term in the middle of its history"
push clean
expect_status 0 "new branch of 3000 clean commits"

# --- removing a published term -------------------------------------------------------------
# main already carries a term (in a file and a message) on the remote; a branch that only
# removes it must pass the staged check and the pre-push hook.
git checkout -q -f clean
git checkout -q -b main-leak
printf 'first line\nhost %s\n' "$TERM_VALUE" > notes.txt
git add notes.txt
git commit -qm "docs: name $TERM_VALUE"
git update-ref refs/remotes/origin/main HEAD
git checkout -q -b removal
printf 'first line\nhost example.com\n' > notes.txt
git add notes.txt
run bash scripts/check-private-data.sh --staged
expect_status 0 "staged check of a change that only removes a term"
git commit -qm 'docs: genericize a host name'
push removal
expect_status 0 "pre-push of a branch that only removes a published term"

# A hook that also reviews outgoing patches must still catch a term that a branch adds and
# later removes, because the term would stay in the pushed history.
if grep -qF -- '--patch' .githooks/pre-push; then
  git checkout -q -b add-then-remove removal
  printf 'first line\nhost %s\n' "$TERM_VALUE" > notes.txt
  git add notes.txt
  git commit -qm 'docs: add a host'
  printf 'first line\nhost example.com\n' > notes.txt
  git add notes.txt
  git commit -qm 'docs: genericize a host name again'
  push add-then-remove
  expect_status 1 "pre-push of a branch whose history adds a term"
fi

cd "$ROOT_DIR"
if [[ "$failures" -gt 0 ]]; then
  echo "privacy fail-closed test failed with $failures problem(s)." >&2
  exit 1
fi
echo "Privacy fail-closed test passed."
