---
name: ntp-manager
description: "Time synchronization management — checks timedatectl status, NTP peer connectivity, chrony/systemd-timesyncd health, and clock drift."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["ntp", "time", "chrony", "timesyncd", "ubuntu"]
    requires_toolsets: ["terminal"]
---
# Ntp Manager

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Time synchronization management — checks timedatectl status, NTP peer connectivity, chrony/systemd-timesyncd health, and clock drift.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `timesync.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `timesync.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `timedatectl`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
