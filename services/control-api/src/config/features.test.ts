import { afterEach, describe, expect, it, vi } from 'vitest';
import { featureFlags } from './features.js';
import { loadEnv, RETIRED_ENV_VARIABLES } from './env.js';
import { registryRolloutStages, isDeployHost, isSubmitOnlyHost } from '../services/hermes-registry-service.js';
import { securityConsoleUrl, securityFusionMode } from '../services/security-export.js';
import { magnusHome } from '../utils/magnus-home.js';
import { resolveDatabaseUrl } from '../db/client.js';
import { dashboardEnrollmentSecret } from '../services/resource-enrollment.js';

afterEach(() => vi.unstubAllEnvs());

describe('optional integrations default to off', () => {
  it('reports nothing enabled for an empty environment', () => {
    expect(featureFlags({})).toEqual({ iam: false, oathweave: false, hermes: false, router: false, hivemem: false, securityFusion: 'off',
      securityConsoleUrl: null, pluginApi: false, hermesRegistry: false, resourceLeases: false, agentDiscovery: false, fleetGateway: false });
  });

  it('turns each integration on from its own variables', () => {
    expect(featureFlags({ IAM_CORE_URL: 'https://iam.example.com', HIVE_ROUTER_URL: 'https://router.example.com',
      HIVEMEM_URL: 'https://mem.example.com', SECURITY_FUSION_MODE: 'remote',
      MAGNUS_SECURITY_CONSOLE_URL: 'https://security.example.com', MAGNUS_PLUGIN_API_ENABLED: 'true' }))
      .toMatchObject({ iam: true, router: true, hivemem: true, securityFusion: 'remote',
        securityConsoleUrl: 'https://security.example.com', pluginApi: true });
  });

  it('treats unknown Security Fusion modes as off and reads the console URL from the environment', () => {
    vi.stubEnv('SECURITY_FUSION_MODE', 'bogus');
    expect(securityFusionMode()).toBe('off');
    vi.stubEnv('SECURITY_FUSION_MODE', 'local');
    expect(() => securityFusionMode()).toThrow(/retired/);
    vi.stubEnv('MAGNUS_SECURITY_CONSOLE_URL', 'https://security.example.com/');
    expect(securityConsoleUrl()).toBe('https://security.example.com');
    vi.stubEnv('MAGNUS_SECURITY_CONSOLE_URL', 'javascript:alert(1)');
    expect(securityConsoleUrl()).toBeUndefined();
  });
});

describe('environment validation of optional features', () => {
  const secrets = { NODE_ENV: 'development' as const };

  it('requires the receipt key only in local Security Fusion mode', () => {
    expect(() => loadEnv({ ...secrets, SECURITY_FUSION_MODE: 'off' })).not.toThrow();
    expect(() => loadEnv({ ...secrets, SECURITY_FUSION_MODE: 'remote' })).not.toThrow();
    expect(() => loadEnv({ ...secrets, SECURITY_FUSION_MODE: 'local' })).toThrow(/retired/);
  });

  it('ignores leftover retired Security Fusion local-mode settings instead of rejecting them', () => {
    const shared = 'shared-value-that-is-at-least-32-characters-long';
    const leftovers = Object.fromEntries(RETIRED_ENV_VARIABLES.map(name => [name, 'short']));
    // A short value, and a value equal to a live secret, used to fail validation for the receipt key.
    for (const receiptKey of ['short', shared]) {
      const env = loadEnv({ ...secrets, ...leftovers, SECURITY_FUSION_RECEIPT_SIGNING_KEY: receiptKey, METRICS_TOKEN: shared });
      for (const name of RETIRED_ENV_VARIABLES) expect(env).not.toHaveProperty(name);
    }
    for (const name of RETIRED_ENV_VARIABLES) vi.stubEnv(name, shared);
    vi.stubEnv('RESOURCE_ENROLLMENT_DASHBOARD_SECRET', shared);
    expect(dashboardEnrollmentSecret()).toBe(shared);
  });

  it('requires plugin digests only when the plugin API is enabled', () => {
    expect(() => loadEnv({ ...secrets })).not.toThrow();
    expect(() => loadEnv({ ...secrets, MAGNUS_PLUGIN_API_ENABLED: 'true' })).toThrow(/MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON/);
  });

  it('requires DATABASE_URL in production and offers a password-free development default', () => {
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL/);
    expect(resolveDatabaseUrl({ NODE_ENV: 'development' })).toBe('postgresql://magnus@127.0.0.1:5432/magnus');
    expect(resolveDatabaseUrl({ DATABASE_URL: 'postgresql://db.example.com/magnus' })).toBe('postgresql://db.example.com/magnus');
  });
});

describe('registry hosts and data paths come from the environment', () => {
  it('parses host:stage lists and defaults to no deploy hosts', () => {
    expect([...registryRolloutStages('')]).toEqual([]);
    expect([...registryRolloutStages('Canary-1:0, web-1:2,web-2,bad host:1,x:-1')])
      .toEqual([['canary-1', 0], ['web-1', 2], ['web-2', 0]]);
    vi.stubEnv('MAGNUS_REGISTRY_DEPLOY_HOSTS', 'node-1:1');
    vi.stubEnv('MAGNUS_REGISTRY_SUBMIT_ONLY_HOSTS', 'author');
    expect(isDeployHost('NODE-1')).toBe(true);
    expect(isDeployHost('author')).toBe(false);
    expect(isSubmitOnlyHost('author')).toBe(true);
  });

  it('defaults MAGNUS_HOME to ~/.magnus', () => {
    expect(magnusHome({ MAGNUS_HOME: '/srv/magnus' })).toBe('/srv/magnus');
    expect(magnusHome({})).toMatch(/\.magnus$/);
  });
});
