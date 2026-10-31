---
name: disk-cleaner
description: "Automated disk space management — cleans temp files, rotates logs, purges package caches, and identifies large/orphaned files. Configurable usage thresholds."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["disk", "cleanup", "maintenance", "storage"]
    requires_toolsets: ["terminal"]
---
# Disk Cleaner

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Automated disk space management — cleans temp files, rotates logs, purges package caches, and identifies large/orphaned files. Configurable usage thresholds.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `cleaner.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `cleaner.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `find`, `du`, `df`, `logrotate`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
