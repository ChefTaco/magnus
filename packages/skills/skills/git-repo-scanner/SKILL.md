---
name: git-repo-scanner
description: "Git repository auditor — finds repos on nodes, detects uncommitted changes, large repos, dangling remotes, and scans for potential secrets in commit history using entropy analysis."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["git", "security", "audit", "repos", "secrets"]
    requires_toolsets: ["terminal"]
---
# Git Repo Scanner

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Git repository auditor — finds repos on nodes, detects uncommitted changes, large repos, dangling remotes, and scans for potential secrets in commit history using entropy analysis.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `git-scan.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `git-scan.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `git`, `find`, `awk`, `du`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
