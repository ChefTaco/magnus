import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildEnvironment, checkEnvironment, parseArgs } from '../../bin/magnus-ui.mjs';

const valid = {
  CONTROL_API_URL: 'https://magnus-api.example.com:4000',
  API_SECRET: 'fixture-api-secret-0123456789abcdef',
  SESSION_SECRET: 'fixture-session-secret-0123456789abcdef',
  CONTROL_NODE_CREDENTIAL_KEY: 'fixture-credential-key-0123456789abcdef',
  REDIS_URL: 'redis://127.0.0.1:6379',
  DASHBOARD_PUBLIC_ORIGIN: 'https://magnus.example.com',
  DASHBOARD_ADMIN_USERNAME: 'admin',
  DASHBOARD_ADMIN_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=1$fixture',
  MAGNUS_UI_ALLOW_HTTP: 'true',
};

describe('magnus-ui CLI', () => {
  it('defaults to start and parses global options', () => {
    expect(parseArgs([]).command).toBe('start');
    const parsed = parseArgs(['check', '--env-file', 'a.env', '--port=8443']);
    expect(parsed).toMatchObject({ command: 'check', options: { 'env-file': 'a.env', port: '8443' } });
    expect(() => parseArgs(['--env-file'])).toThrow('requires a value');
  });

  it('loads an env file without overriding the process environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magnus-ui-cli-'));
    const file = join(dir, 'ui.env');
    writeFileSync(file, 'API_SECRET=from-file\nREDIS_URL=redis://127.0.0.1:6380\n');
    const env = buildEnvironment({ 'env-file': file, host: '127.0.0.1' }, { API_SECRET: 'from-process' });
    expect(env).toMatchObject({ API_SECRET: 'from-process', REDIS_URL: 'redis://127.0.0.1:6380', HOST: '127.0.0.1' });
    expect(() => buildEnvironment({ 'env-file': join(dir, 'missing.env') }, {})).toThrow('not found');
  });

  it('accepts a complete configuration and reports what is missing', async () => {
    await expect(checkEnvironment(valid)).resolves.toMatchObject({ errors: [] });
    const { errors } = await checkEnvironment({ ...valid, REDIS_URL: '', MAGNUS_UI_ALLOW_HTTP: 'false' });
    expect(errors).toContain('REDIS_URL is required');
    expect(errors.some((error: string) => error.includes('TLS_CERT_PATH'))).toBe(true);
  });
});
