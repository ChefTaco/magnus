---
name: mount-inspector
description: "Filesystem mount auditor — inspects NFS, CIFS, tmpfs, overlayfs mounts. Detects stale mounts, checks security options, verifies fstab consistency, and reports mount latency."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["mounts", "filesystem", "nfs", "audit"]
    requires_toolsets: ["terminal"]
---
# Mount Inspector

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Filesystem mount auditor — inspects NFS, CIFS, tmpfs, overlayfs mounts. Detects stale mounts, checks security options, verifies fstab consistency, and reports mount latency.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `mounts.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `mounts.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `mount`, `findmnt`, `df`, `awk`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
