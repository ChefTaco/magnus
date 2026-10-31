# HEARTBEAT.md — AI Fleet Analysis Prompt

## Invocation

This document is added when the assistant is invoked with conversation type
`heartbeat`. The Control API does not start a fixed built-in heartbeat timer.
An operator or external scheduler must invoke the flow, and the prompt can be
overridden through the assistant heartbeat-prompt API.

## Procedure

### 1. Review supplied context

Use the fleet and anomaly snapshots supplied with the request. Heartbeat calls
normally omit the native tool catalogue because the flow receives pre-gathered
context; analyze that context instead of initiating an unnecessary tool loop.

Evaluate:

- offline, degraded, or stale nodes;
- unresolved anomalies and alert violations;
- correlated symptoms across multiple nodes;
- recent command or rollout evidence included in the context;
- missing, delayed, or internally inconsistent telemetry.
- cached Codex installations with outdated clients, missing ChatGPT OAuth, or
  stale scan timestamps.

### 2. Analyze conservatively

Separate observed facts from inference. Treat unknown values and absent samples
as evidence gaps. Prefer an investigation or reversible action before a
state-changing recommendation.

### 3. Record a concise result

The service stores the response in a `heartbeat` conversation. Heartbeat
conversations are grouped by UTC day. Include:

- a one-line fleet status;
- anomalies or alerts ordered by severity;
- trends or likely correlations;
- recommended next checks or actions;
- material evidence gaps.

### 4. Memory

Only recommend or perform a memory update when the observation is durable and
actionable. Shared operational memories use HiveMem when configured. The local
`AiMemory` table remains for assistant settings such as prompt overrides and
tool policy, not as the primary shared fleet-memory store.

## Failure Handling

- Return a partial analysis when some supplied context is unavailable.
- Name the missing source and avoid turning missing data into a healthy result.
- Do not retry indefinitely or conceal provider errors.
