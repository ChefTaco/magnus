---
name: service-watcher
description: "Systemd service monitoring and auto-recovery — watches critical services, detects failures, performs automatic restarts, and escalates persistent issues."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["services", "systemd", "auto-restart", "availability"]
    requires_toolsets: ["terminal"]
---
# Service Watcher

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Systemd service monitoring and auto-recovery — watches critical services, detects failures, performs automatic restarts, and escalates persistent issues.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `watcher.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `watcher.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `systemctl`, `journalctl`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
