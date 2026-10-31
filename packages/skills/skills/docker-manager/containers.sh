#!/usr/bin/env bash
# docker-manager — Docker container and image management
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Inspect Docker containers, images, volumes, and networks.
Reports resource usage and identifies cleanup opportunities
(dangling images, stopped containers, unused volumes).

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Container status, image count, disk usage summary
  -v             Include per-container resource stats and image details
  -vv            Include volume mount details and network inspection
  -vvv           Include full docker inspect output for each container

Examples:
  $(basename "$0")             # Quick Docker overview
  $(basename "$0") -v          # Detailed container stats
  $(basename "$0") -vv         # Full audit with volumes/networks
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

echo "=== Docker Manager ==="

if ! command -v docker &>/dev/null; then
  echo "Docker is not installed"
  exit 0
fi

if ! docker info &>/dev/null 2>&1; then
  echo "Docker daemon is not running or current user lacks permissions"
  exit 0
fi

# ── Docker version ──
echo "--- Docker Info ---"
docker version --format 'Server: {{.Server.Version}} | Client: {{.Client.Version}}' 2>/dev/null || true
log_v1 "Storage driver: $(docker info --format '{{.Driver}}' 2>/dev/null)"
log_v1 "Docker root: $(docker info --format '{{.DockerRootDir}}' 2>/dev/null)"

# ── Containers ──
echo "--- Containers ---"
RUNNING=$(docker ps -q 2>/dev/null | wc -l)
TOTAL=$(docker ps -aq 2>/dev/null | wc -l)
STOPPED=$((TOTAL - RUNNING))
echo "  Running: $RUNNING | Stopped: $STOPPED | Total: $TOTAL"

if [[ $RUNNING -gt 0 ]]; then
  docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}" 2>/dev/null | head -20
fi

if [[ $STOPPED -gt 0 ]]; then
  echo "  Stopped containers:"
  docker ps -a --filter "status=exited" --format "  {{.Names}} ({{.Status}})" 2>/dev/null | head -10
fi

# ── Container stats (verbose 1+) ──
if [[ $VERBOSE -ge 1 && $RUNNING -gt 0 ]]; then
  echo "--- Container Resource Usage ---"
  docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}" 2>/dev/null || true
fi

# ── Images ──
echo "--- Images ---"
IMAGE_COUNT=$(docker images -q 2>/dev/null | wc -l)
DANGLING=$(docker images -f "dangling=true" -q 2>/dev/null | wc -l)
echo "  Total: $IMAGE_COUNT | Dangling: $DANGLING"

if [[ $VERBOSE -ge 1 ]]; then
  docker images --format "  {{.Repository}}:{{.Tag}} ({{.Size}}, {{.CreatedSince}})" 2>/dev/null | head -15
fi

if [[ $DANGLING -gt 0 ]]; then
  DANGLING_SIZE=$(docker images -f "dangling=true" --format '{{.Size}}' 2>/dev/null | head -5)
  echo "  ⚠ $DANGLING dangling image(s) can be cleaned with: docker image prune"
fi

# ── Volumes ──
echo "--- Volumes ---"
VOL_COUNT=$(docker volume ls -q 2>/dev/null | wc -l)
DANGLING_VOLS=$(docker volume ls -f "dangling=true" -q 2>/dev/null | wc -l)
echo "  Total: $VOL_COUNT | Unused: $DANGLING_VOLS"

if [[ $VERBOSE -ge 2 ]]; then
  docker volume ls --format "  {{.Name}} ({{.Driver}})" 2>/dev/null | head -15
fi

if [[ $DANGLING_VOLS -gt 0 ]]; then
  echo "  ⚠ $DANGLING_VOLS unused volume(s) can be cleaned with: docker volume prune"
fi

# ── Networks (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Networks ---"
  docker network ls --format "  {{.Name}} ({{.Driver}}, {{.Scope}})" 2>/dev/null || true
fi

# ── Disk usage ──
echo "--- Docker Disk Usage ---"
docker system df 2>/dev/null || true

if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Reclaimable Space ---"
  docker system df -v 2>/dev/null | grep -E "RECLAIMABLE|reclaimable" | head -5 || true
fi

# ── Compose projects (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Compose Projects ---"
  if docker compose version &>/dev/null 2>&1; then
    docker compose ls 2>/dev/null || echo "  No compose projects"
  else
    echo "  docker compose not available"
  fi
fi
