---
name: package-manager
description: "Automated package management — checks for available updates, identifies vulnerable packages, and can perform controlled upgrades with rollback support."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["packages", "updates", "vulnerabilities", "maintenance"]
    requires_toolsets: ["terminal"]
---
# Package Manager

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Automated package management — checks for available updates, identifies vulnerable packages, and can perform controlled upgrades with rollback support.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `packages.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `packages.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `apt`, `dnf`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
