---
name: network-diagnostics
description: "Network health toolkit — connectivity tests, DNS resolution checks, port scanning, bandwidth measurement, and route tracing. Identifies network bottlenecks."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["network", "diagnostics", "connectivity", "dns"]
    requires_toolsets: ["terminal"]
---
# Network Diagnostics

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Network health toolkit — connectivity tests, DNS resolution checks, port scanning, bandwidth measurement, and route tracing. Identifies network bottlenecks.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `netdiag.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `netdiag.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `ip`, `ss`, `dig`, `ping`, `traceroute`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
