---
name: wazuh-agent-monitor
description: "Wazuh endpoint-security agent posture — reports installation, service health, startup state, version, and configured managers without exposing credentials."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["wazuh", "security", "endpoint", "monitoring", "compliance", "ubuntu"]
    requires_toolsets: ["terminal"]
---
# Wazuh Agent Monitor

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Wazuh endpoint-security agent posture — reports installation, service health, startup state, version, and configured managers without exposing credentials.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `wazuh-agent.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `wazuh-agent.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `systemctl`, `dpkg-query`, `awk`, `grep`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
