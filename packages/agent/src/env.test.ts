/**
 * Tests for env.ts — feature flag parsing and secret validation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('env', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, NODE_ENV: 'test' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('ENABLE_NODE_MANAGEMENT defaults to true', async () => {
    delete process.env['ENABLE_NODE_MANAGEMENT'];
    const mod = await import('./env.js');
    expect(mod.ENABLE_NODE_MANAGEMENT).toBe(true);
  });

  it('ENABLE_NODE_MANAGEMENT can be disabled', async () => {
    process.env['ENABLE_NODE_MANAGEMENT'] = 'false';
    const mod = await import('./env.js');
    expect(mod.ENABLE_NODE_MANAGEMENT).toBe(false);
  });

  it('authenticated UDP discovery defaults off', async () => {
    delete process.env['ENABLE_AGENT_DISCOVERY'];
    const mod = await import('./env.js');
    expect(mod.ENABLE_AGENT_DISCOVERY).toBe(false);
  });

  it('HOST_FQDN can be overridden', async () => {
    process.env['HOST_FQDN'] = 'myhost.example.com';
    const mod = await import('./env.js');
    expect(mod.HOST_FQDN).toBe('myhost.example.com');
  });

  it('validateSecrets does nothing in test mode', async () => {
    process.env['NODE_ENV'] = 'test';
    const mod = await import('./env.js');
    // Should not throw or exit
    mod.validateSecrets();
  });

  it('requires production TLS even when insecure HTTP is requested', async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      ENABLE_NODE_MANAGEMENT: 'true',
      NODE_MANAGER_SECRET: 'n'.repeat(32),
      RESULT_SIGNING_SECRET: 'r'.repeat(32),
      CONTROL_API_URL: 'https://control.example.test:4000',
      ALLOW_INSECURE_HTTP: 'true',
    };
    delete process.env['TLS_CERT_PATH'];
    delete process.env['TLS_KEY_PATH'];
    const mod = await import('./env.js');
    expect(() => mod.validateSecrets()).toThrow(/TLS_CERT_PATH and TLS_KEY_PATH are required/);
    expect(() => mod.validateSecrets()).toThrow(/ALLOW_INSECURE_HTTP cannot be enabled/);
  });

  it('requires a dedicated discovery secret and explicit interface when enabled', async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      ENABLE_NODE_MANAGEMENT: 'true',
      ENABLE_AGENT_DISCOVERY: 'true',
      NODE_MANAGER_SECRET: 'n'.repeat(32),
      RESULT_SIGNING_SECRET: 'r'.repeat(32),
      CONTROL_API_URL: 'https://control.example.test:4000',
      TLS_CERT_PATH: '/cert.pem',
      TLS_KEY_PATH: '/key.pem',
      AGENT_DISCOVERY_SECRET: 'n'.repeat(32),
      AGENT_DISCOVERY_BIND_ADDRESS: '0.0.0.0',
    };
    const mod = await import('./env.js');
    expect(() => mod.validateSecrets()).toThrow(/explicit IPv4 interface/);
    expect(() => mod.validateSecrets()).toThrow(/must be distinct from NODE_MANAGER_SECRET/);
  });

  it('requires an independent command reconciliation authority when configured', async () => {
    process.env = { ...originalEnv, NODE_ENV: 'production', ENABLE_NODE_MANAGEMENT: 'true',
      NODE_MANAGER_SECRET: 'n'.repeat(32), RESULT_SIGNING_SECRET: 'r'.repeat(32),
      COMMAND_RECONCILIATION_SECRET: 'n'.repeat(32), CONTROL_API_URL: 'https://control.example.test:4000',
      TLS_CERT_PATH: '/cert.pem', TLS_KEY_PATH: '/key.pem' };
    const mod = await import('./env.js');
    expect(() => mod.validateSecrets()).toThrow(/COMMAND_RECONCILIATION_SECRET must be an independent secret/);
  });
});
