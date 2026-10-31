#!/usr/bin/env bash
# git-repo-scanner — Audit git repositories on a host
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Git repository auditor. Discovers git repos on the filesystem,
checks for uncommitted changes, unpushed commits, large repos,
stale branches, and potential secrets in history.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Discover repos, show status and branches
  -v             Include size analysis, remote status, stale branches
  -vv            Include secrets scan hints, large file detection
  -vvv           Full audit dump per repo

Examples:
  $(basename "$0")             # Quick repo discovery
  $(basename "$0") -v          # Include size and remote info
  $(basename "$0") -vv         # Full git audit
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

# Search paths for git repos (skip system/virtual dirs)
SEARCH_PATHS=(/home /opt /srv /var/www /root)
MAX_DEPTH=4

echo "=== Git Repo Scanner ==="

echo "--- Discovering Repositories ---"
REPOS=()
for search_path in "${SEARCH_PATHS[@]}"; do
  [[ -d "$search_path" ]] || continue
  log_v1 "Scanning $search_path (depth $MAX_DEPTH)"
  while IFS= read -r gitdir; do
    REPO_DIR=$(dirname "$gitdir")
    REPOS+=("$REPO_DIR")
  done < <(find "$search_path" -maxdepth "$MAX_DEPTH" -name ".git" -type d 2>/dev/null)
done

echo "  Found: ${#REPOS[@]} repositories"
if [[ ${#REPOS[@]} -eq 0 ]]; then
  echo "  No git repos found in: ${SEARCH_PATHS[*]}"
  exit 0
fi

echo "--- Repository Status ---"
DIRTY_COUNT=0
CLEAN_COUNT=0
for repo in "${REPOS[@]}"; do
  cd "$repo" 2>/dev/null || continue
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "detached")
  DIRTY=$(git status --porcelain 2>/dev/null | wc -l)
  LAST_COMMIT=$(git log -1 --format='%cr' 2>/dev/null || echo "unknown")

  if [[ $DIRTY -gt 0 ]]; then
    echo "  ⚠ $repo"
    echo "    Branch: $BRANCH | Uncommitted: $DIRTY files | Last commit: $LAST_COMMIT"
    DIRTY_COUNT=$((DIRTY_COUNT + 1))
  else
    echo "  ✓ $repo"
    echo "    Branch: $BRANCH | Clean | Last commit: $LAST_COMMIT"
    CLEAN_COUNT=$((CLEAN_COUNT + 1))
  fi
done

echo "--- Summary ---"
echo "  Clean: $CLEAN_COUNT | Dirty: $DIRTY_COUNT | Total: ${#REPOS[@]}"

# ── Size and remotes (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Repository Sizes ---"
  for repo in "${REPOS[@]}"; do
    [[ -d "$repo/.git" ]] || continue
    GIT_SIZE=$(du -sh "$repo/.git" 2>/dev/null | awk '{print $1}')
    WORK_SIZE=$(du -sh "$repo" 2>/dev/null | awk '{print $1}')
    echo "  $repo — working: $WORK_SIZE, .git: $GIT_SIZE"
  done | sort -t':' -k2 -rh | head -20

  echo "--- Remote Origins ---"
  for repo in "${REPOS[@]}"; do
    cd "$repo" 2>/dev/null || continue
    ORIGIN=$(git remote get-url origin 2>/dev/null || echo "(no remote)")
    echo "  $repo → $ORIGIN"
  done

  echo "--- Unpushed Commits ---"
  for repo in "${REPOS[@]}"; do
    cd "$repo" 2>/dev/null || continue
    BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    [[ -z "$BRANCH" ]] && continue
    UPSTREAM=$(git rev-parse --abbrev-ref "@{upstream}" 2>/dev/null || echo "")
    if [[ -n "$UPSTREAM" ]]; then
      AHEAD=$(git rev-list --count "$UPSTREAM..HEAD" 2>/dev/null || echo 0)
      BEHIND=$(git rev-list --count "HEAD..$UPSTREAM" 2>/dev/null || echo 0)
      if [[ $AHEAD -gt 0 || $BEHIND -gt 0 ]]; then
        echo "  ⚠ $repo — ahead: $AHEAD, behind: $BEHIND"
      fi
    else
      echo "  ℹ $repo ($BRANCH) — no upstream tracking"
    fi
  done

  echo "--- Stale Branches (>90 days) ---"
  for repo in "${REPOS[@]}"; do
    cd "$repo" 2>/dev/null || continue
    CUTOFF=$(date -d "90 days ago" +%s 2>/dev/null || date -v-90d +%s 2>/dev/null || echo 0)
    [[ $CUTOFF -eq 0 ]] && continue
    git for-each-ref --format='%(refname:short) %(committerdate:unix)' refs/heads/ 2>/dev/null | while read -r branch epoch; do
      if [[ $epoch -lt $CUTOFF ]]; then
        AGE=$(( ($(date +%s) - epoch) / 86400 ))
        echo "  $repo ← $branch (${AGE}d old)"
      fi
    done
  done | head -20
fi

# ── Secrets and large files (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Potential Secrets in Working Tree ---"
  SECRET_PATTERNS='(password|secret|api.key|token|private.key|AWS_SECRET|PRIVATE_KEY).*='
  for repo in "${REPOS[@]}"; do
    HITS=$(grep -rl --include='*.env' --include='*.yml' --include='*.yaml' --include='*.json' --include='*.conf' -E "$SECRET_PATTERNS" "$repo" 2>/dev/null | head -5)
    if [[ -n "$HITS" ]]; then
      echo "  ⚠ $repo:"
      echo "$HITS" | sed 's/^/    /'
    fi
  done

  echo "--- Large Files (>10MB in working tree) ---"
  for repo in "${REPOS[@]}"; do
    LARGE=$(find "$repo" -not -path '*/.git/*' -type f -size +10M 2>/dev/null | head -5)
    if [[ -n "$LARGE" ]]; then
      echo "  $repo:"
      echo "$LARGE" | while read -r f; do
        SIZE=$(du -h "$f" 2>/dev/null | awk '{print $1}')
        echo "    $f ($SIZE)"
      done
    fi
  done

  echo "--- Git LFS Status ---"
  for repo in "${REPOS[@]}"; do
    cd "$repo" 2>/dev/null || continue
    if git lfs ls-files &>/dev/null; then
      LFS_COUNT=$(git lfs ls-files 2>/dev/null | wc -l)
      if [[ $LFS_COUNT -gt 0 ]]; then
        echo "  $repo: $LFS_COUNT LFS-tracked files"
      fi
    fi
  done
fi

# ── Full dump (verbose 3) ──
if [[ $VERBOSE -ge 3 ]]; then
  echo "--- Full Status Per Repo ---"
  for repo in "${REPOS[@]}"; do
    cd "$repo" 2>/dev/null || continue
    echo "  ── $repo ──"
    git status --short 2>/dev/null | head -20 | sed 's/^/    /'
    echo "    Recent commits:"
    git log --oneline -5 2>/dev/null | sed 's/^/      /'
    echo "    Branches:"
    git branch -a 2>/dev/null | sed 's/^/      /'
  done

  echo "--- .gitignore Coverage ---"
  for repo in "${REPOS[@]}"; do
    if [[ -f "$repo/.gitignore" ]]; then
      LINES=$(wc -l < "$repo/.gitignore")
      echo "  $repo: $LINES rules"
    else
      echo "  $repo: ⚠ no .gitignore"
    fi
  done
fi
