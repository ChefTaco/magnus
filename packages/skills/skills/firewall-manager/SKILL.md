---
name: firewall-manager
description: "Firewall rule management and auditing — inspects iptables/nftables/ufw rules, detects overly permissive configurations, and applies security policies."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["firewall", "iptables", "ufw", "security", "network"]
    requires_toolsets: ["terminal"]
---
# Firewall Manager

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Firewall rule management and auditing — inspects iptables/nftables/ufw rules, detects overly permissive configurations, and applies security policies.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `firewall.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `firewall.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `iptables`, `ufw`, `nft`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
