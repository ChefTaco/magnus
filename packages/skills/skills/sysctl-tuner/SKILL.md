---
name: sysctl-tuner
description: "Kernel parameter inspection and tuning — displays current sysctl values, checks against Ubuntu best practices, and identifies non-default settings."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["kernel", "sysctl", "tuning", "performance", "security", "ubuntu"]
    requires_toolsets: ["terminal"]
---
# Sysctl Tuner

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Kernel parameter inspection and tuning — displays current sysctl values, checks against Ubuntu best practices, and identifies non-default settings.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `tuner.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `tuner.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `sysctl`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
