#!/usr/bin/env bash
# energy-profiler — Monitor power and energy consumption on Ubuntu
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Power and energy consumption profiler. Reads Intel RAPL energy counters,
CPU frequency scaling, C-state residency, thermal zones, and IPMI
power data when available.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      CPU freq, thermal zones, power supply, basic RAPL
  -v             Include C-states, frequency policy, thermal trips
  -vv            Include IPMI power, per-core frequencies, governor analysis
  -vvv           Full power diagnostic dump

Examples:
  $(basename "$0")             # Quick power overview
  $(basename "$0") -v          # Include C-states and policy info
  $(basename "$0") -vv         # Full energy profiling
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

echo "=== Energy Profiler ==="

echo "--- CPU Frequency Summary ---"
if [[ -d /sys/devices/system/cpu/cpu0/cpufreq ]]; then
  GOVERNOR=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null || echo "unknown")
  MIN_FREQ=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_min_freq 2>/dev/null || echo 0)
  MAX_FREQ=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq 2>/dev/null || echo 0)
  CUR_FREQ=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2>/dev/null || echo 0)
  echo "  Governor: $GOVERNOR"
  echo "  Range: $((MIN_FREQ / 1000)) MHz – $((MAX_FREQ / 1000)) MHz"
  echo "  Current (cpu0): $((CUR_FREQ / 1000)) MHz"

  # Average across all cores
  TOTAL=0
  COUNT=0
  for freq_file in /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq; do
    [[ -f "$freq_file" ]] || continue
    F=$(cat "$freq_file" 2>/dev/null || echo 0)
    TOTAL=$((TOTAL + F))
    COUNT=$((COUNT + 1))
  done
  if [[ $COUNT -gt 0 ]]; then
    AVG=$((TOTAL / COUNT / 1000))
    echo "  Average across $COUNT cores: ${AVG} MHz"
  fi
else
  echo "  cpufreq not available (VM or unsupported platform)"
  # Try lscpu fallback
  lscpu 2>/dev/null | grep -i "mhz\|frequency" | sed 's/^/  /' || true
fi

echo "--- Thermal Zones ---"
if ls /sys/class/thermal/thermal_zone*/temp &>/dev/null; then
  for tz in /sys/class/thermal/thermal_zone*/; do
    [[ -d "$tz" ]] || continue
    ZONE=$(basename "$tz")
    TYPE=$(cat "${tz}type" 2>/dev/null || echo "unknown")
    TEMP=$(cat "${tz}temp" 2>/dev/null || echo 0)
    TEMP_C=$((TEMP / 1000))
    STATUS="✓"
    [[ $TEMP_C -ge 80 ]] && STATUS="⚠ HOT"
    [[ $TEMP_C -ge 95 ]] && STATUS="✗ CRITICAL"
    echo "  $ZONE ($TYPE): ${TEMP_C}°C $STATUS"
  done
else
  echo "  No thermal zones found"
fi

echo "--- Power Supply ---"
if [[ -d /sys/class/power_supply ]]; then
  for ps in /sys/class/power_supply/*/; do
    [[ -d "$ps" ]] || continue
    NAME=$(basename "$ps")
    TYPE=$(cat "${ps}type" 2>/dev/null || echo "unknown")
    STATUS=$(cat "${ps}status" 2>/dev/null || echo "unknown")
    if [[ "$TYPE" == "Battery" ]]; then
      CAPACITY=$(cat "${ps}capacity" 2>/dev/null || echo "?")
      echo "  $NAME: $TYPE, $STATUS, ${CAPACITY}%"
    else
      echo "  $NAME: $TYPE, $STATUS"
    fi
  done
else
  echo "  No power supply info (likely a server)"
fi

echo "--- RAPL Energy ---"
if [[ -d /sys/class/powercap/intel-rapl:0 ]]; then
  for rapl_dir in /sys/class/powercap/intel-rapl:*/; do
    [[ -d "$rapl_dir" ]] || continue
    DOMAIN=$(basename "$rapl_dir")
    NAME=$(cat "${rapl_dir}name" 2>/dev/null || echo "$DOMAIN")
    ENERGY1=$(cat "${rapl_dir}energy_uj" 2>/dev/null || echo 0)
    sleep 1
    ENERGY2=$(cat "${rapl_dir}energy_uj" 2>/dev/null || echo 0)
    POWER_UW=$((ENERGY2 - ENERGY1))
    POWER_W=$(awk "BEGIN {printf \"%.2f\", $POWER_UW / 1000000}")
    CONSTRAINT=$(cat "${rapl_dir}constraint_0_power_limit_uw" 2>/dev/null || echo 0)
    TDP_W=$(awk "BEGIN {printf \"%.0f\", $CONSTRAINT / 1000000}")
    echo "  $NAME: ${POWER_W}W current (TDP limit: ${TDP_W}W)"
  done
else
  echo "  Intel RAPL not available"
fi

# ── C-states and policy (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- CPU C-States ---"
  if [[ -d /sys/devices/system/cpu/cpu0/cpuidle ]]; then
    for state in /sys/devices/system/cpu/cpu0/cpuidle/state*/; do
      [[ -d "$state" ]] || continue
      SNAME=$(cat "${state}name" 2>/dev/null || echo "?")
      USAGE=$(cat "${state}usage" 2>/dev/null || echo 0)
      TIME=$(cat "${state}time" 2>/dev/null || echo 0)
      DISABLED=$(cat "${state}disable" 2>/dev/null || echo 0)
      TIME_MS=$((TIME / 1000))
      FLAG=""
      [[ "$DISABLED" == "1" ]] && FLAG=" [DISABLED]"
      echo "  $SNAME: count=$USAGE time=${TIME_MS}ms$FLAG"
    done
  else
    echo "  cpuidle not available"
  fi

  echo "--- Frequency Policy ---"
  if [[ -d /sys/devices/system/cpu/cpu0/cpufreq ]]; then
    echo "  Available governors: $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors 2>/dev/null || echo 'unknown')"
    echo "  Driver: $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_driver 2>/dev/null || echo 'unknown')"
    if [[ -f /sys/devices/system/cpu/intel_pstate/status ]]; then
      echo "  Intel P-State: $(cat /sys/devices/system/cpu/intel_pstate/status 2>/dev/null)"
      echo "  Turbo disabled: $(cat /sys/devices/system/cpu/intel_pstate/no_turbo 2>/dev/null || echo 'unknown')"
    fi
  fi

  echo "--- Thermal Trip Points ---"
  for tz in /sys/class/thermal/thermal_zone*/; do
    [[ -d "$tz" ]] || continue
    ZONE=$(basename "$tz")
    for trip in "${tz}"trip_point_*_temp; do
      [[ -f "$trip" ]] || continue
      TRIP_NUM=$(echo "$trip" | grep -oP 'trip_point_\K\d+')
      TRIP_TEMP=$(($(cat "$trip" 2>/dev/null || echo 0) / 1000))
      TRIP_TYPE=$(cat "${tz}trip_point_${TRIP_NUM}_type" 2>/dev/null || echo "?")
      echo "  $ZONE trip $TRIP_NUM: ${TRIP_TEMP}°C ($TRIP_TYPE)"
    done
  done
fi

# ── IPMI and per-core (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  echo "--- IPMI Power (if available) ---"
  if command -v ipmitool &>/dev/null; then
    ipmitool dcmi power reading 2>/dev/null | grep -i "power\|watts" | sed 's/^/  /' || echo "  IPMI power reading unavailable"
  else
    echo "  ipmitool not installed"
  fi

  echo "--- Per-Core Frequency ---"
  for freq_file in /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq; do
    [[ -f "$freq_file" ]] || continue
    CPU=$(echo "$freq_file" | grep -oP 'cpu\K\d+')
    FREQ=$(($(cat "$freq_file") / 1000))
    echo "  cpu$CPU: ${FREQ} MHz"
  done | head -32
fi

# ── Full dump (verbose 3) ──
if [[ $VERBOSE -ge 3 ]]; then
  echo "--- /proc/cpuinfo (freq fields) ---"
  grep -i "model name\|cpu mhz\|bogomips" /proc/cpuinfo 2>/dev/null | sort -u | sed 's/^/  /'

  echo "--- Runtime PM Stats ---"
  for dev in /sys/bus/pci/devices/*/power/runtime_status; do
    [[ -f "$dev" ]] || continue
    DEVID=$(echo "$dev" | grep -oP '/\K[^/]+(?=/power)')
    STATUS=$(cat "$dev" 2>/dev/null)
    echo "  $DEVID: $STATUS"
  done 2>/dev/null | head -20

  echo "--- Kernel Power Parameters ---"
  cat /sys/module/*/parameters/*power* 2>/dev/null | head -10 | sed 's/^/  /' || echo "  none"
fi
