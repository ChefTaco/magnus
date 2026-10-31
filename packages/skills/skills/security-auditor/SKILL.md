---
name: security-auditor
description: "Security posture assessment — audits user accounts, SSH config, open ports, file permissions, SUID binaries, and firewall rules. Generates compliance reports."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["security", "audit", "compliance", "hardening"]
    requires_toolsets: ["terminal"]
---
# Security Auditor

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Security posture assessment — audits user accounts, SSH config, open ports, file permissions, SUID binaries, and firewall rules. Generates compliance reports.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `audit.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `audit.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `ss`, `find`, `awk`, `grep`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
