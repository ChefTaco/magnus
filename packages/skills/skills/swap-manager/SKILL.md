---
name: swap-manager
description: "Swap configuration inspector — analyzes swap usage, swappiness tuning, zram/zswap status, OOM-killer history, and memory pressure indicators."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["swap", "memory", "performance", "tuning"]
    requires_toolsets: ["terminal"]
---
# Swap Manager

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Swap configuration inspector — analyzes swap usage, swappiness tuning, zram/zswap status, OOM-killer history, and memory pressure indicators.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `swap.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `swap.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `swapon`, `free`, `awk`, `grep`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
