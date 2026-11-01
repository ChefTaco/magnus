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

/** Boolean switch with an explicit default: only `true`/`false` (any case) override it. */
export function envSwitch(value: string | undefined, fallback: boolean): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

/**
 * Automatic upgrade behaviour. Every switch is independent so an operator who
 * runs their own release process can turn each automatic path off.
 */
export interface UpgradeSettings {
  /** Apply pending migrations at startup, before listening. */
  autoMigrate: boolean;
  /** Dump the database before an automatic migration (refuses to migrate if the dump fails). */
  autoMigrateBackup: boolean;
  /** Let auto-migrate apply migrations marked slow or one-way. */
  autoMigrateAllowSlow: boolean;
  /** Daily registry check for newer releases. */
  updateCheck: boolean;
  /** npm registry used by the update check. */
  updateRegistry: string;
  /** Server-driven agent upgrades (API, UI action and CLI). */
  agentUpgrades: boolean;
  /** Agents upgraded at once after the first (canary) agent confirms. */
  agentUpgradeConcurrency: number;
  /** The retired git-checkout self-update endpoints. */
  legacyGitSelfUpdate: boolean;
}

export function upgradeSettings(env: NodeJS.ProcessEnv = process.env): UpgradeSettings {
  const concurrency = Number.parseInt(env['MAGNUS_AGENT_UPGRADE_CONCURRENCY'] ?? '', 10);
  return {
    autoMigrate: envSwitch(env['MAGNUS_AUTO_MIGRATE'], false),
    autoMigrateBackup: envSwitch(env['MAGNUS_AUTO_MIGRATE_BACKUP'], true),
    autoMigrateAllowSlow: envSwitch(env['MAGNUS_AUTO_MIGRATE_ALLOW_SLOW'], false),
    updateCheck: envSwitch(env['MAGNUS_UPDATE_CHECK'], true),
    updateRegistry: (env['MAGNUS_UPDATE_REGISTRY']?.trim() || 'https://registry.npmjs.org').replace(/\/+$/, ''),
    agentUpgrades: envSwitch(env['MAGNUS_AGENT_UPGRADES'], true),
    agentUpgradeConcurrency: Number.isInteger(concurrency) && concurrency > 0 ? Math.min(concurrency, 50) : 5,
    legacyGitSelfUpdate: envSwitch(env['MAGNUS_LEGACY_GIT_SELF_UPDATE'], false),
  };
}
