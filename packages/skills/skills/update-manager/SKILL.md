---
name: update-manager
description: "Ubuntu update management — checks for pending updates, unattended-upgrades status, reboot-required flag, and release upgrade availability."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["updates", "apt", "unattended-upgrades", "ubuntu", "maintenance"]
    requires_toolsets: ["terminal"]
---
# Update Manager

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Ubuntu update management — checks for pending updates, unattended-upgrades status, reboot-required flag, and release upgrade availability.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `updates.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `updates.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `apt`, `unattended-upgrades`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
