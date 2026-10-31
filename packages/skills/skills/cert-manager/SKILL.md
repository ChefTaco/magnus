---
name: cert-manager
description: "TLS/SSL certificate monitoring — tracks certificate expiration dates, validates chains, and alerts before certs expire. Supports Let's Encrypt auto-renewal."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["certificates", "tls", "ssl", "expiry", "security"]
    requires_toolsets: ["terminal"]
---
# Cert Manager

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: TLS/SSL certificate monitoring — tracks certificate expiration dates, validates chains, and alerts before certs expire. Supports Let's Encrypt auto-renewal.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `certs.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `certs.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `openssl`, `certbot`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
