/**
 * Optional integrations and features, derived from the environment.
 *
 * Every integration is off unless configured. Consumers read these flags at
 * startup (`magnus-server check`, background services) so an unconfigured
 * integration never blocks the server from starting.
 */
export interface FeatureFlags {
  /** External Hive IAM verifies RS256 access tokens (`IAM_CORE_URL`). */
  iam: boolean;
  /** Hive Router (or any OpenAI-compatible router) for managed Hermes Agents. */
  router: boolean;
  /** HiveMem shared agent memory. */
  hivemem: boolean;
  /** Security Fusion mode: off, local or remote (external security console). */
  securityFusion: 'off' | 'local' | 'remote';
  /** URL of the external security console shown to operators in remote mode. */
  securityConsoleUrl: string | null;
  /** Hermes Agent plugin API (plugin-scoped bearer credentials). */
  pluginApi: boolean;
  /** Hermes registry background sync: packaged skill import and plugin source monitor. */
  hermesRegistry: boolean;
  /** Node and shared-resource lease coordination. */
  resourceLeases: boolean;
  /** Agent self-registration through the discovery endpoint. */
  agentDiscovery: boolean;
}

const truthy = (value: string | undefined) => (value ?? '').trim().toLowerCase() === 'true';

export function featureFlags(env: NodeJS.ProcessEnv = process.env): FeatureFlags {
  const mode = env['SECURITY_FUSION_MODE'];
  return {
    iam: Boolean(env['IAM_CORE_URL']),
    router: Boolean(env['MAGNUS_ROUTER_URL'] || env['HIVE_ROUTER_URL']),
    hivemem: Boolean(env['HIVEMEM_URL']),
    securityFusion: mode === 'local' || mode === 'remote' ? mode : 'off',
    securityConsoleUrl: env['MAGNUS_SECURITY_CONSOLE_URL'] || null,
    pluginApi: truthy(env['MAGNUS_PLUGIN_API_ENABLED']),
    hermesRegistry: truthy(env['MAGNUS_HERMES_REGISTRY_ENABLED']),
    resourceLeases: truthy(env['MAGNUS_RESOURCE_LEASES_ENABLED']),
    agentDiscovery: truthy(env['ENABLE_AGENT_DISCOVERY']),
  };
}
