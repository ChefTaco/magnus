---
name: process-inspector
description: "Process analysis toolkit — identifies resource-hungry processes, detects zombie/orphan processes, monitors process trees, and tracks resource trends."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["processes", "resources", "debugging", "performance"]
    requires_toolsets: ["terminal"]
---
# Process Inspector

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Process analysis toolkit — identifies resource-hungry processes, detects zombie/orphan processes, monitors process trees, and tracks resource trends.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `procs.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `procs.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `ps`, `top`, `lsof`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
