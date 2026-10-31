import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

describe('Hive IAM environment contract', () => {
  it('keeps resource enrollment disabled unless explicitly enabled', () => {
    expect(loadEnv({}).MAGNUS_RESOURCE_LEASES_ENABLED).toBe(false);
    expect(loadEnv({ MAGNUS_RESOURCE_LEASES_ENABLED: 'true' }).MAGNUS_RESOURCE_LEASES_ENABLED).toBe(true);
    expect(() => loadEnv({ MAGNUS_RESOURCE_LEASES_ENABLED: '1' })).toThrow(/MAGNUS_RESOURCE_LEASES_ENABLED/);
  });
  it.each(['API_SECRET', 'SECURITY_APPROVAL_BRIDGE_TOKEN', 'COMMAND_RECONCILIATION_SECRET', 'RESOURCE_PARTICIPANT_RECONCILIATION_SECRET', 'SHARED_RESOURCE_RECONCILIATION_SECRET', 'RESULT_SIGNING_SECRET'])('separates dashboard participant credential from %s', field => {
    expect(() => loadEnv({ RESOURCE_ENROLLMENT_DASHBOARD_SECRET: 'x'.repeat(32), [field]: 'x'.repeat(32) })).toThrow(/must be distinct/);
  });
  it('separates participant reconciliation from the node-distributed command authority', () => {
    expect(() => loadEnv({
      COMMAND_RECONCILIATION_SECRET: 'x'.repeat(32),
      RESOURCE_PARTICIPANT_RECONCILIATION_SECRET: 'x'.repeat(32),
    })).toThrow(/RESOURCE_PARTICIPANT_RECONCILIATION_SECRET must be distinct from COMMAND_RECONCILIATION_SECRET/);
    expect(() => loadEnv({
      RESOURCE_PARTICIPANT_RECONCILIATION_SECRET: `${'x'.repeat(32)}\nAPI_SECRET=evil`,
    })).toThrow(/RESOURCE_PARTICIPANT_RECONCILIATION_SECRET/);
  });
  it('separates the shared-resource client digest and reviewed reconciliation authority', () => {
    const digest = 'a'.repeat(64);
    expect(() => loadEnv({ MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256: digest,
      MAGNUS_SHARED_RESOURCE_TOKEN_SHA256: digest })).toThrow(/shared resource credential/);
    expect(() => loadEnv({ COMMAND_RECONCILIATION_SECRET: 'x'.repeat(32),
      SHARED_RESOURCE_RECONCILIATION_SECRET: 'x'.repeat(32) })).toThrow(/must be distinct/);
    expect(() => loadEnv({ MAGNUS_SHARED_RESOURCE_TOKEN_SHA256: digest,
      MAGNUS_SHARED_RESOURCE_TOKEN_DIGESTS_JSON: JSON.stringify({ edge: digest }) }))
      .toThrow(/legacy and per-client/);
  });
  it('keeps every shared-resource bearer distinct from plugin, fleet and collector credentials', () => {
    const digest = 'a'.repeat(64);
    for (const field of ['MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256', 'MAGNUS_FLEET_CHECK_TOKEN_SHA256',
      'MAGNUS_COLLECTOR_TOKEN_SHA256'] as const) {
      expect(() => loadEnv({ MAGNUS_SHARED_RESOURCE_TOKEN_SHA256: digest, [field]: digest }))
        .toThrow(/must differ/);
      expect(() => loadEnv({ MAGNUS_SHARED_RESOURCE_TOKEN_DIGESTS_JSON: JSON.stringify({ edge: digest }), [field]: digest }))
        .toThrow(/must differ/);
    }
    expect(() => loadEnv({ MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON: JSON.stringify({ approvals: digest }),
      MAGNUS_SHARED_RESOURCE_TOKEN_DIGESTS_JSON: JSON.stringify({ edge: digest }) }))
      .toThrow(/must differ/);
    expect(() => loadEnv({ MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON: JSON.stringify({ approvals: digest }),
      MAGNUS_SHARED_RESOURCE_TOKEN_SHA256: digest })).toThrow(/must differ/);
  });
  it('rejects inverted retention windows', () => {
    expect(() => loadEnv({
      HEALTH_SNAPSHOT_RETENTION_DAYS: '2',
      HEALTH_SNAPSHOT_FULL_FIDELITY_HOURS: '49',
    })).toThrow(/FULL_FIDELITY_HOURS cannot exceed/);
    expect(() => loadEnv({
      NOTIFICATION_READ_RETENTION_DAYS: '91',
      NOTIFICATION_MAX_RETENTION_DAYS: '90',
    })).toThrow(/READ_RETENTION_DAYS cannot exceed/);
  });

  it.each(['IAM_TOKEN_ISSUER', 'IAM_TOKEN_AUDIENCE'] as const)(
    'requires %s whenever IAM mode is enabled',
    (missing) => {
      const values = {
        AUDIT_HMAC_SECRET: 'a'.repeat(32),
        IAM_CORE_URL: 'https://hive.example.test/api/iam',
        IAM_TOKEN_ISSUER: 'hive-iam',
        IAM_TOKEN_AUDIENCE: 'magnus',
        [missing]: undefined,
      };
      expect(() => loadEnv(values)).toThrow(new RegExp(missing));
    },
  );

  it('accepts an explicit issuer and audience contract', () => {
    const env = loadEnv({
      AUDIT_HMAC_SECRET: 'a'.repeat(32),
      IAM_CORE_URL: 'https://hive.example.test/api/iam',
      IAM_TOKEN_ISSUER: 'hive-iam',
      IAM_TOKEN_AUDIENCE: 'magnus',
    });
    expect(env.IAM_TOKEN_ISSUER).toBe('hive-iam');
    expect(env.IAM_TOKEN_AUDIENCE).toBe('magnus');
  });

  it('validates accepted approval-assertion signature domains', () => {
    expect(loadEnv({}).MAGNUS_APPROVAL_ASSERTION_DOMAINS).toBeUndefined();
    expect(loadEnv({ MAGNUS_APPROVAL_ASSERTION_DOMAINS: 'magnus.approval-assertion, legacy.approval' }).MAGNUS_APPROVAL_ASSERTION_DOMAINS)
      .toBe('magnus.approval-assertion, legacy.approval');
    for (const invalid of ['Legacy', 'a,,b', 'legacy_approval', 'x.'])
      expect(() => loadEnv({ MAGNUS_APPROVAL_ASSERTION_DOMAINS: invalid }), invalid).toThrow(/MAGNUS_APPROVAL_ASSERTION_DOMAINS/);
  });
  it('rejects a short dedicated audit-chain secret', () => {
    expect(() => loadEnv({ AUDIT_HMAC_SECRET: 'source-known-default' })).toThrow(
      /AUDIT_HMAC_SECRET/,
    );
  });

  it('accepts only a complete DNS suffix for verified agent endpoints', () => {
    expect(
      loadEnv({
        AUDIT_HMAC_SECRET: 'a'.repeat(32),
        AGENT_TLS_DOMAIN_SUFFIX: 'example.com',
      }).AGENT_TLS_DOMAIN_SUFFIX,
    ).toBe('example.com');
    expect(() =>
      loadEnv({
        AUDIT_HMAC_SECRET: 'a'.repeat(32),
        AGENT_TLS_DOMAIN_SUFFIX: 'bad..suffix',
      }),
    ).toThrow(/AGENT_TLS_DOMAIN_SUFFIX/);
  });

  it('rejects the retired master fallback and cross-protocol secret reuse in production', () => {
    const common = 'x'.repeat(32);
    expect(() => loadEnv({ NODE_ENV: 'production', MAGNUS_SECRET: common })).toThrow(/retired/);
    expect(() => loadEnv({ API_SECRET: common, NODE_MANAGER_SECRET: common })).toThrow(
      /NODE_MANAGER_SECRET must be distinct from API_SECRET/,
    );
  });

  it('accepts independent purpose-specific credentials', () => {
    const env = loadEnv({
      API_SECRET: 'a'.repeat(32),
      JWT_SECRET: 'b'.repeat(32),
      NODE_MANAGER_SECRET: 'c'.repeat(32),
      CREDENTIAL_ROTATION_KEY: 'd'.repeat(32),
      AUDIT_HMAC_SECRET: 'e'.repeat(32),
      RESULT_SIGNING_SECRET: 'f'.repeat(32),
      LOG_INGEST_SIGNING_SECRET: 'g'.repeat(32),
    });
    expect(env.API_SECRET).toBe('a'.repeat(32));
    expect(env.NODE_MANAGER_SECRET).toBe('c'.repeat(32));
  });

  it('rejects wildcard CORS and missing TLS in production', () => {
    expect(() => loadEnv({
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://dashboard.example.test,*',
      TLS_CERT_PATH: '/cert.pem',
      TLS_KEY_PATH: '/key.pem',
    })).toThrow(/CORS_ORIGIN cannot be wildcard/);
    expect(() => loadEnv({
      NODE_ENV: 'production',
      TLS_CERT_PATH: undefined,
      TLS_KEY_PATH: undefined,
    })).toThrow(/required in production/);
  });

  it('rejects production HTTP opt-in and partial TLS configuration', () => {
    expect(() => loadEnv({
      NODE_ENV: 'production',
      ALLOW_INSECURE_HTTP: 'true',
      TLS_CERT_PATH: '/cert.pem',
      TLS_KEY_PATH: '/key.pem',
    })).toThrow(/ALLOW_INSECURE_HTTP cannot be enabled/);
    expect(() => loadEnv({
      TLS_CERT_PATH: '/cert.pem',
      TLS_KEY_PATH: undefined,
    })).toThrow(/configured together/);
  });

  it('keeps authenticated UDP discovery disabled by default and purpose-separated when enabled', () => {
    expect(loadEnv({}).ENABLE_AGENT_DISCOVERY).toBe(false);
    expect(() => loadEnv({ ENABLE_AGENT_DISCOVERY: 'true' })).toThrow(/AGENT_DISCOVERY_SECRET/);
    expect(() => loadEnv({
      ENABLE_AGENT_DISCOVERY: 'true',
      AGENT_DISCOVERY_SECRET: 'a'.repeat(32),
      NODE_MANAGER_SECRET: 'a'.repeat(32),
    })).toThrow(/AGENT_DISCOVERY_SECRET must be distinct from NODE_MANAGER_SECRET/);
    expect(loadEnv({
      ENABLE_AGENT_DISCOVERY: 'true',
      AGENT_DISCOVERY_SECRET: 'z'.repeat(32),
    }).ENABLE_AGENT_DISCOVERY).toBe(true);
  });

  it('requires unique per-installation plugin read digests and a separate operator digest', () => {
    const readA = 'a'.repeat(64);
    const readB = 'b'.repeat(64);
    const operator = 'c'.repeat(64);
    expect(loadEnv({
      MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON: JSON.stringify({ magnus: readA, approvals: readB }),
      MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256: operator,
    }).MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256).toBe(operator);
    expect(() => loadEnv({
      MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON: JSON.stringify({ magnus: readA, approvals: readA }),
      MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256: operator,
    })).toThrow(/unique per consumer/);
    expect(() => loadEnv({
      MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON: JSON.stringify({ magnus: readA, approvals: readB }),
      MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256: readA,
    })).toThrow(/operator credential must differ/);
  });
});
