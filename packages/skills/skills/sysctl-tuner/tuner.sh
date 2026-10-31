#!/usr/bin/env bash
# sysctl-tuner — Inspect and audit kernel parameters
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Inspect current kernel sysctl parameters. Shows security-relevant
settings, network tuning, memory management, and identifies values
that differ from Ubuntu defaults.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Key security and network parameters
  -v             Include memory/VM settings and file descriptor limits
  -vv            Include all non-default sysctl values
  -vvv           Include full sysctl dump

Examples:
  $(basename "$0")             # Key parameters only
  $(basename "$0") -v          # Detailed parameter audit
  $(basename "$0") -vvv        # Full sysctl dump
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

echo "=== Sysctl Tuner ==="

# Helper to show a sysctl value with label
show_param() {
  local key="$1" label="${2:-}"
  local val
  val=$(sysctl -n "$key" 2>/dev/null || echo "N/A")
  if [[ -n "$label" ]]; then
    printf "  %-45s = %s  (%s)\n" "$key" "$val" "$label"
  else
    printf "  %-45s = %s\n" "$key" "$val"
  fi
}

# ── Kernel info ──
echo "--- Kernel ---"
echo "  Version: $(uname -r)"
echo "  Architecture: $(uname -m)"

# ── Security parameters ──
echo "--- Security Parameters ---"
show_param "kernel.randomize_va_space"        "ASLR: 2=full"
show_param "kernel.dmesg_restrict"            "1=restricted"
show_param "kernel.kptr_restrict"             "1+=hidden"
show_param "kernel.yama.ptrace_scope"         "1=restricted"
show_param "kernel.sysrq"                     "0=disabled"
show_param "kernel.core_uses_pid"             "1=recommended"
show_param "fs.protected_hardlinks"           "1=protected"
show_param "fs.protected_symlinks"            "1=protected"
show_param "fs.suid_dumpable"                 "0=secure"

# ── Network security ──
echo "--- Network Security ---"
show_param "net.ipv4.conf.all.rp_filter"          "1=strict, 2=loose"
show_param "net.ipv4.conf.default.rp_filter"
show_param "net.ipv4.icmp_echo_ignore_broadcasts"  "1=ignore"
show_param "net.ipv4.conf.all.accept_redirects"    "0=disabled"
show_param "net.ipv4.conf.all.send_redirects"      "0=disabled"
show_param "net.ipv4.conf.all.accept_source_route" "0=disabled"
show_param "net.ipv4.conf.all.log_martians"        "1=logged"
show_param "net.ipv4.tcp_syncookies"               "1=enabled"
show_param "net.ipv6.conf.all.accept_redirects"    "0=disabled"

# ── Network performance ──
echo "--- Network Performance ---"
show_param "net.core.somaxconn"                "server queue depth"
show_param "net.core.netdev_max_backlog"       "NIC backlog"
show_param "net.ipv4.tcp_max_syn_backlog"      "SYN backlog"
show_param "net.ipv4.tcp_fin_timeout"          "seconds"
show_param "net.ipv4.tcp_keepalive_time"       "seconds"
show_param "net.ipv4.tcp_tw_reuse"             "1=enabled"
show_param "net.ipv4.ip_local_port_range"      "ephemeral range"
show_param "net.core.rmem_max"                 "bytes"
show_param "net.core.wmem_max"                 "bytes"

# ── Memory/VM (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Memory / VM ---"
  show_param "vm.swappiness"                   "0-100, lower=less swap"
  show_param "vm.dirty_ratio"                  "% before sync"
  show_param "vm.dirty_background_ratio"       "% before bg sync"
  show_param "vm.vfs_cache_pressure"           "100=default"
  show_param "vm.overcommit_memory"            "0=heuristic"
  show_param "vm.overcommit_ratio"             "percent"
  show_param "vm.min_free_kbytes"              "reserved KB"
  show_param "vm.max_map_count"                "mmap limit"
  show_param "kernel.pid_max"                  "max PIDs"

  echo "--- File Descriptors ---"
  show_param "fs.file-max"                     "system-wide max"
  show_param "fs.nr_open"                      "per-process max"
  OPEN=$(cat /proc/sys/fs/file-nr 2>/dev/null | awk '{print $1}')
  MAX=$(cat /proc/sys/fs/file-nr 2>/dev/null | awk '{print $3}')
  echo "  fs.file-nr (current open)                   = ${OPEN:-?} / ${MAX:-?}"
fi

# ── Custom overrides (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- Custom Overrides ---"
  for f in /etc/sysctl.conf /etc/sysctl.d/*.conf; do
    [[ -f "$f" ]] || continue
    LINES=$(grep -cEv '^\s*#|^\s*$' "$f" 2>/dev/null || echo 0)
    if [[ $LINES -gt 0 ]]; then
      echo "  $f ($LINES settings):"
      grep -Ev '^\s*#|^\s*$' "$f" 2>/dev/null | sed 's/^/    /'
    fi
  done
fi

# ── Full dump (verbose 3) ──
if [[ $VERBOSE -ge 3 ]]; then
  echo "--- Full Sysctl Dump ---"
  sysctl -a 2>/dev/null | sort | head -200
  echo "  ... (truncated at 200 lines)"
fi
