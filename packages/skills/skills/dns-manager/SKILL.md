---
name: dns-manager
description: "DNS resolution audit and management — checks resolv.conf, validates upstream resolvers, detects split-horizon mismatches, verifies DNSSEC, and alerts on resolution failures."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["dns", "networking", "resolution", "audit"]
    requires_toolsets: ["terminal"]
---
# Dns Manager

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: DNS resolution audit and management — checks resolv.conf, validates upstream resolvers, detects split-horizon mismatches, verifies DNSSEC, and alerts on resolution failures.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `dns.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `dns.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `dig`, `host`, `awk`, `grep`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
