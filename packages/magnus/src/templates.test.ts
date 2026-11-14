import { describe, expect, it } from 'vitest';
import { serverEnv, serverSecretNames } from './templates.js';

const settings = { databaseUrl: 'postgresql://magnus@127.0.0.1:5432/magnus', redisUrl: 'redis://127.0.0.1:6379', port: 4000,
  publicUrl: 'https://magnus.example.com:4000', uiOrigin: 'https://magnus.example.com:3000', tlsCert: '/opt/magnus/tls.crt', tlsKey: '/opt/magnus/tls.key',
  home: '/opt/magnus/data', backupDir: '/opt/magnus/backups', autoMigrate: true, projectDir: '/opt/magnus', runtimeFile: '/opt/magnus/run/server-runtime.json' };

describe('generated server environment', () => {
  it('leaves the shared node credentials out of a 3.0.0 project (enforce needs neither) and keeps them for an older release', () => {
    expect(serverSecretNames('3.0.0')).not.toContain('NODE_MANAGER_SECRET');
    expect(serverSecretNames('3.1.0-rc.1')).not.toContain('RESULT_SIGNING_SECRET');
    expect(serverSecretNames('2.10.2')).toEqual(expect.arrayContaining(['NODE_MANAGER_SECRET', 'RESULT_SIGNING_SECRET']));
    expect(serverSecretNames(undefined)).toContain('NODE_MANAGER_SECRET');
    const current = serverEnv({ ...settings, version: '3.0.0' }, {});
    expect(current).not.toMatch(/^NODE_MANAGER_SECRET=/m);
    expect(current).not.toMatch(/^RESULT_SIGNING_SECRET=/m);
    expect(current).toMatch(/^API_SECRET=/m);
    expect(current).not.toMatch(/^NODE_AUTH_MODE=/m);
    const older = serverEnv({ ...settings, version: '1.0.3' }, {});
    expect(older).toMatch(/^NODE_MANAGER_SECRET=/m);
    expect(older).toMatch(/^RESULT_SIGNING_SECRET=/m);
  });
});
