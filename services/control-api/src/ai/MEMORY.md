# MEMORY.md — Magnus Assistant Memory

## Storage Boundaries

Durable operational memories are stored in HiveMem when `HIVEMEM_URL` and
`HIVEMEM_TOKEN` configure the integration. The `storeMemory`, `recallMemories`,
and `forgetMemory` tools use that service and return a configuration error or an
empty result when it is unavailable.

The Control API's local `AiMemory` table stores assistant configuration such as
model settings, tool policy, disabled tools, and heartbeat-prompt overrides. Do
not describe it as the primary cross-conversation fleet knowledge store.

## Memory Categories

- `general`: durable fleet-wide operational knowledge.
- `node`: stable node-specific behavior or ownership context.
- `pattern`: recurring symptoms and verified correlations.
- `preference`: durable operator workflow preferences.

## Key Guidance

Use short descriptive keys such as `fleet:{topic}`, `node:{name}:{topic}`,
`pattern:{name}`, or `pref:{name}`. The storage tool records the category and
key as tags alongside the content.

## What to Store

- Store only actionable, reusable knowledge.
- Include dates when a fact can become stale.
- Update or delete superseded knowledge rather than accumulating conflicts.
- Never store passwords, tokens, private keys, raw environment maps, or other
  secrets.
- Do not store a transient metric that can be fetched from the fleet API.

## Retrieval and Deletion

`recallMemories` performs semantic search and can bias the query by category.
`forgetMemory` deletes by HiveMem memory ID and is normally approval-gated.
Treat an unavailable HiveMem integration as an evidence gap.
