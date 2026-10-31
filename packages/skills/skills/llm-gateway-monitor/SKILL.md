---
name: llm-gateway-monitor
description: "Local LLM instance monitor — checks Ollama, llama.cpp, and vLLM services. Reports GPU utilization, VRAM usage, loaded models, inference latency, and token throughput."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ["llm", "ai", "gpu", "ollama", "monitoring"]
    requires_toolsets: ["terminal"]
---
# Llm Gateway Monitor

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: Local LLM instance monitor — checks Ollama, llama.cpp, and vLLM services. Reports GPU utilization, VRAM usage, loaded models, inference latency, and token throughput.

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run `llm-monitor.sh` from this skill directory with `--help` first when the expected arguments are unclear.
3. Execute `llm-monitor.sh` with the requested options. Add `-v`, `-vv`, or `-vvv` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: `curl`, `awk`, `grep`.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
