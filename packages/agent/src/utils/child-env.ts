/**
 * Agent credentials that child processes never need. Commands, Hermes/Codex
 * CLIs, and package managers inherit the agent environment otherwise, which
 * would expose the node token and signing keys through /proc/<pid>/environ to
 * every process of the (often lower-privileged) target account.
 */
export const AGENT_SECRET_ENV_KEYS = [
  'NODE_MANAGER_SECRET',
  'NODE_MANAGER_SECRET_PREVIOUS',
  'RESULT_SIGNING_SECRET',
  'RESULT_SIGNING_PREVIOUS_SECRET',
  'COMMAND_RECONCILIATION_SECRET',
  'COMMAND_RECONCILIATION_SECRET_PREVIOUS',
  'LOG_INGEST_TOKEN',
  'AGENT_DISCOVERY_SECRET',
  'HERMES_REGISTRY_TOKEN',
] as const;

/** Copy of `base` (default: process.env) with agent credentials removed, then `overrides` applied. */
export function childEnvironment(overrides: NodeJS.ProcessEnv = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of AGENT_SECRET_ENV_KEYS) delete env[key];
  return { ...env, ...overrides };
}
