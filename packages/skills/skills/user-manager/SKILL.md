---
name: user-manager
description: "User account lifecycle management — audits active accounts, detects dormant users, manages SSH keys, and enforces password policies."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["users", "accounts", "ssh-keys", "access-control"]
    requires_toolsets: ["terminal"]
---
# User Manager

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: User account lifecycle management — audits active accounts, detects dormant users, manages SSH keys, and enforces password policies.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `users.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `users.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `useradd`, `passwd`, `chage`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
