import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { afterEach, describe, expect, it } from 'vitest';
import {
  dashboardCredentialDiagnostics,
  resolveDashboardLoginCredentials,
  resolveDashboardSshCredentials,
} from '../../runtime-dashboard-credentials.mjs';
import { upsertDotenvValues } from '../../runtime-dotenv.mjs';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('dashboard credential migration', () => {
  it('requires dedicated login credentials and dedicated SSH credentials', () => {
    expect(() => resolveDashboardLoginCredentials({})).toThrow(/Dedicated dashboard/);
    expect(() => resolveDashboardSshCredentials({ DASHBOARD_SSH_USERNAME: 'magnus-proxy' })).toThrow(/Dedicated dashboard SSH/);
  });

  it('treats SSH credentials as optional for startup diagnostics', () => {
    expect(dashboardCredentialDiagnostics({
      DASHBOARD_ADMIN_USERNAME: 'admin',
      DASHBOARD_ADMIN_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA',
    })).toMatchObject({ migrated: true, sshConfigured: false, warning: null });
  });

  it('authenticates with a dedicated plaintext admin password when configured', () => {
    expect(resolveDashboardLoginCredentials({
      DASHBOARD_ADMIN_USERNAME: 'admin',
      DASHBOARD_ADMIN_PASSWORD: 'plaintext-admin-secret',
    })).toMatchObject({
      username: 'admin',
      password: 'plaintext-admin-secret',
      source: 'dashboard-admin-password',
    });
  });

  it('prefers the plaintext admin password over a stale hash', () => {
    expect(resolveDashboardLoginCredentials({
      DASHBOARD_ADMIN_USERNAME: 'admin',
      DASHBOARD_ADMIN_PASSWORD: 'plaintext-admin-secret',
      DASHBOARD_ADMIN_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA',
    })).toMatchObject({ source: 'dashboard-admin-password' });
  });

  it('rejects a legacy dedicated password reused by fleet bootstrap', () => {
    expect(() => resolveDashboardLoginCredentials({
      DASHBOARD_LOGIN_USERNAME: 'admin',
      DASHBOARD_LOGIN_PASSWORD: 'same-secret',
      BOOTSTRAP_SSH_PASSWORD: 'same-secret',
    }, new Date('2026-08-06T00:00:00Z'))).toThrow(/must not equal BOOTSTRAP_SSH_PASSWORD/);
  });

  it('expires legacy login credentials at the exact migration deadline', () => {
    const env = { DASHBOARD_LOGIN_USERNAME: 'legacy-admin', DASHBOARD_LOGIN_PASSWORD: 'dedicated-legacy-password' };
    expect(resolveDashboardLoginCredentials(env, new Date('2026-09-30T23:59:59Z')))
      .toMatchObject({ source: 'legacy-dashboard-login' });
    expect(() => resolveDashboardLoginCredentials(env, new Date('2026-10-01T00:00:00Z'))).toThrow('have expired');
  });

  it('uses a dedicated proxy identity and key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magnus-dashboard-key-'));
    tempDirs.push(dir);
    const keyPath = join(dir, 'proxy-key');
    writeFileSync(keyPath, 'restricted-private-key');
    const result = resolveDashboardSshCredentials({
      DASHBOARD_SSH_USERNAME: 'magnus-proxy',
      DASHBOARD_SSH_PRIVATE_KEY_PATH: keyPath,
    });
    expect(result).toMatchObject({
      username: 'magnus-proxy',
      privateKey: 'restricted-private-key',
      source: 'dedicated',
    });
  });

  it('reports migration complete when supplied v2 separation metadata is valid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magnus-dashboard-key-'));
    tempDirs.push(dir);
    const keyPath = join(dir, 'proxy-key');
    writeFileSync(keyPath, 'restricted-private-key');
    const metadata = Buffer.from(JSON.stringify({
      purpose: 'dashboard-admin-login', version: 2, createdAt: '2026-08-06T00:00:00Z',
      rotatedAt: '2026-08-06T00:00:00Z', secretForm: 'argon2id-hash', reusableSecret: false,
      lastLegacyBootstrapUse: null, fleetPasswordAuthenticationDisabled: true, fingerprintsDiffer: true,
    })).toString('base64');
    expect(dashboardCredentialDiagnostics({
      DASHBOARD_ADMIN_USERNAME: 'admin',
      DASHBOARD_ADMIN_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA',
      DASHBOARD_ADMIN_CREDENTIAL_METADATA_B64: metadata,
      DASHBOARD_SSH_USERNAME: 'magnus-proxy',
      DASHBOARD_SSH_PRIVATE_KEY_PATH: keyPath,
    })).toMatchObject({ migrated: true, loginSource: 'dashboard-admin-hash', credentialVersion: 2, warning: null });
  });
});

describe('canonical dotenv serialization', () => {
  it.each([
    ' leading',
    'trailing ',
    'space in the middle',
    'hash#fragment',
    `single'quote`,
    'double"quote',
    String.raw`back\slash`,
    '$dollar `backtick` ! bang',
    ` both'"\\# `,
  ])('round-trips %j through dotenv', (value) => {
    const serialized = upsertDotenvValues('UNCHANGED=present\n', {
      DASHBOARD_LOGIN_USERNAME: value,
      DASHBOARD_LOGIN_PASSWORD: value,
    });
    const parsed = dotenv.parse(serialized);
    // This serialization fixture intentionally uses the former login names.
    const resolved = resolveDashboardLoginCredentials(parsed, new Date('2026-09-30T23:59:59Z'));
    expect(resolved.username).toBe(value);
    expect(resolved.password).toBe(value);
    expect(parsed.UNCHANGED).toBe('present');
  });

  it('rejects newline and NUL injection', () => {
    expect(() => upsertDotenvValues('', { DASHBOARD_LOGIN_PASSWORD: 'first\nSECOND=bad' })).toThrow();
    expect(() => upsertDotenvValues('', { DASHBOARD_LOGIN_PASSWORD: 'bad\0value' })).toThrow();
  });
});
