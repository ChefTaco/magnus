---
name: system-monitor
description: "Real-time system monitoring and alerting"
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["monitoring", "health", "alerting", "core"]
    requires_toolsets: ["terminal"]
---
# System Monitor

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Real-time system monitoring and alerting

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `monitor.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `monitor.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `procfs`, `sysstat`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
