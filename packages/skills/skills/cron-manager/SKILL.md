---
name: cron-manager
description: "Cron job auditing and management — lists all user and system cron jobs, detects orphaned entries, shows at/systemd timers, and validates crontab syntax."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["cron", "scheduling", "timers", "maintenance", "ubuntu"]
    requires_toolsets: ["terminal"]
---
# Cron Manager

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Cron job auditing and management — lists all user and system cron jobs, detects orphaned entries, shows at/systemd timers, and validates crontab syntax.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `crontabs.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `crontabs.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `crontab`, `systemctl`, `awk`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
