---
name: energy-profiler
description: "Node power consumption profiler — reads RAPL energy counters, IPMI sensors, CPU frequency scaling, and C-state residency. Reports per-package energy cost and recommends power-saving configurations."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["energy", "power", "rapl", "efficiency", "green"]
    requires_toolsets: ["terminal"]
---
# Energy Profiler

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Node power consumption profiler — reads RAPL energy counters, IPMI sensors, CPU frequency scaling, and C-state residency. Reports per-package energy cost and recommends power-saving configurations.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `energy.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `energy.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `awk`, `grep`, `cat`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
