---
name: login-auditor
description: "Authentication event auditor — tracks successful/failed logins, sudo usage, session durations, concurrent sessions, and unusual login times or source IPs."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["auth", "login", "audit", "security", "sudo"]
    requires_toolsets: ["terminal"]
---
# Login Auditor

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Authentication event auditor — tracks successful/failed logins, sudo usage, session durations, concurrent sessions, and unusual login times or source IPs.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `logins.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `logins.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `last`, `lastlog`, `journalctl`, `awk`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
