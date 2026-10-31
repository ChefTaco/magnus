#!/usr/bin/env bash
# prompt-filter — Input sanitization filter for prompt injection defense
# Usage: echo "$content" | ./prompt-filter.sh
#
# Strips known prompt-injection patterns from stdin so that web-scraped
# text can be safely passed to an LLM without hijacking the system prompt.
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: echo "content" | $(basename "$0") [OPTIONS]

Sanitize piped text by stripping prompt injection patterns,
HTML tags, and control characters. Designed as a pipeline filter.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (show stripped patterns)

Examples:
  echo "Hello world" | $(basename "$0")
  cat article.txt | $(basename "$0") -v
EOF
  exit 0
}

log_v1() { [[ $VERBOSE -ge 1 ]] && echo "[DEBUG] $*" >&2 || true; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage ;;
    -v) VERBOSE=$((VERBOSE + 1)); shift ;;
    --) shift; break ;;
    -*) echo "Unknown option: $1" >&2; usage ;;
    *) break ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

filter_input() {
  sed -E \
    -e 's/\[INST\]//gi' \
    -e 's/\[\/INST\]//gi' \
    -e 's/<<SYS>>//gi' \
    -e 's/<<\/SYS>>//gi' \
    -e 's/<\|system\|>//gi' \
    -e 's/<\|user\|>//gi' \
    -e 's/<\|assistant\|>//gi' \
    -e 's/<\|im_start\|>//gi' \
    -e 's/<\|im_end\|>//gi' \
    -e 's/<\|endoftext\|>//gi' \
    -e 's/### (System|Assistant|Human|User)://gi' \
    -e '/^[[:space:]]*(You are a|You are an|Act as a|Act as an|Pretend you are|Assume the role of)/Id' \
    -e '/^[[:space:]]*(Ignore (all )?previous|Disregard (all )?previous|Forget (all )?previous)/Id' \
    -e '/^[[:space:]]*(Ignore (all )?above|Disregard (all )?above|Forget (all )?above)/Id' \
    -e '/^[[:space:]]*(Do not follow|Override|New instructions|SYSTEM PROMPT)/Id' \
    -e '/^[[:space:]]*(Reveal your (instructions|prompt|system)|Show me your (prompt|system))/Id' \
    -e '/^[[:space:]]*(What are your instructions|What is your system prompt|Repeat your prompt)/Id' \
    -e '/^[[:space:]]*(Output your|Print your|Display your) (instructions|prompt|system)/Id' \
    -e 's/<script[^>]*>.*<\/script>//gi' \
    -e 's/<iframe[^>]*>.*<\/iframe>//gi' \
    -e 's/<object[^>]*>.*<\/object>//gi' \
    -e 's/<embed[^>]*>.*<\/embed>//gi' \
    -e 's/<style[^>]*>.*<\/style>//gi' \
    -e 's/<[^>]+>//g' \
    -e 's/[[:cntrl:]]/ /g' \
    -e 's/  +/ /g' \
    | grep -v '^\s*$' \
    || true
}

# Read stdin, apply filters, write to stdout
filter_input
