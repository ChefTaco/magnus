---
name: news-reporter
description: "Search the web for news via NewsAPI.org, filter for prompt injection, and write structured Markdown reports to an NFS output directory"
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["news", "web-search", "reporting", "prompt-injection-filter"]
    requires_toolsets: ["terminal"]
---
# News Reporter

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Search the web for news via NewsAPI.org, filter for prompt injection, and write structured Markdown reports to an NFS output directory

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `reporter.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `reporter.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `curl`, `jq`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
