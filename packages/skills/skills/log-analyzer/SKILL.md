---
name: log-analyzer
description: "Intelligent log parsing and pattern detection for syslog, journald, and application logs. Detects anomalies, recurring errors, and security-relevant events."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["logs", "analysis", "anomaly-detection", "security"]
    requires_toolsets: ["terminal"]
---
# Log Analyzer

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Intelligent log parsing and pattern detection for syslog, journald, and application logs. Detects anomalies, recurring errors, and security-relevant events.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `analyze.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `analyze.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `journalctl`, `grep`, `awk`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
