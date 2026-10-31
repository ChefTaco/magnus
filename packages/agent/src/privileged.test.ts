import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentPrivileged, privilegedFeatureStatus, requirePrivileged } from './privileged.js';

describe('privileged mode', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules(); });

  it('defaults to privileged and only false disables it', () => {
    expect(agentPrivileged({})).toBe(true);
    expect(agentPrivileged({ MAGNUS_AGENT_PRIVILEGED: 'true' })).toBe(true);
    expect(agentPrivileged({ MAGNUS_AGENT_PRIVILEGED: 'FALSE' })).toBe(false);
  });

  it('reports every root-only feature as disabled when unprivileged', () => {
    const features = privilegedFeatureStatus({ MAGNUS_AGENT_PRIVILEGED: 'false' });
    expect(features.map(item => item.feature)).toEqual(expect.arrayContaining(['cron', 'users', 'system-updates',
      'docker-group-remediation', 'ardent-management', 'credential-renewal', 'execution-supervisor']));
    expect(features.every(item => !item.enabled)).toBe(true);
    expect(privilegedFeatureStatus({}).every(item => item.enabled)).toBe(true);
  });

  it('guards routes with a stable 403 only when unprivileged', async () => {
    const app = new Hono();
    app.use('/users/*', requirePrivileged('users'));
    app.get('/users/list', c => c.json({ success: true }));
    expect((await app.request('/users/list')).status).toBe(200);
    vi.stubEnv('MAGNUS_AGENT_PRIVILEGED', 'false');
    const res = await app.request('/users/list');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, error: { code: 'AGENT_NOT_PRIVILEGED', feature: 'users',
      message: 'users is disabled: agent is not privileged (MAGNUS_AGENT_PRIVILEGED=false)' } });
  });
});

describe('privileged mode configuration', () => {
  const base = { NODE_ENV: 'production', CONTROL_API_URL: 'https://magnus.example.com:4000',
    NODE_MANAGER_SECRET: 'n'.repeat(64), RESULT_SIGNING_SECRET: 'r'.repeat(64),
    TLS_CERT_PATH: '/opt/magnus-agent/certs/agent.crt', TLS_KEY_PATH: '/opt/magnus-agent/certs/agent.key' };
  beforeEach(() => { for (const [key, value] of Object.entries(base)) vi.stubEnv(key, value); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules(); });

  it('fails fast when privileged mode is requested without root', async () => {
    vi.spyOn(process, 'geteuid').mockReturnValue(1000);
    const { configurationErrors } = await import('./env.js');
    expect(configurationErrors()).toContain('MAGNUS_AGENT_PRIVILEGED=true requires running as root; run as root or set MAGNUS_AGENT_PRIVILEGED=false');
  });

  it('accepts privileged mode as root and unprivileged mode as any user', async () => {
    vi.spyOn(process, 'geteuid').mockReturnValue(0);
    expect((await import('./env.js')).configurationErrors()).toEqual([]);
    vi.resetModules();
    vi.spyOn(process, 'geteuid').mockReturnValue(1000);
    vi.stubEnv('MAGNUS_AGENT_PRIVILEGED', 'false');
    expect((await import('./env.js')).configurationErrors()).toEqual([]);
  });

  it('rejects the execution supervisor and invalid values when unprivileged', async () => {
    vi.stubEnv('MAGNUS_AGENT_PRIVILEGED', 'false');
    vi.stubEnv('MAGNUS_EXECUTION_SUPERVISOR_ENABLED', 'true');
    expect((await import('./env.js')).configurationErrors()).toContain('MAGNUS_EXECUTION_SUPERVISOR_ENABLED=true requires MAGNUS_AGENT_PRIVILEGED=true');
    vi.resetModules();
    vi.stubEnv('MAGNUS_EXECUTION_SUPERVISOR_ENABLED', 'false');
    vi.stubEnv('MAGNUS_AGENT_PRIVILEGED', 'nope');
    expect((await import('./env.js')).configurationErrors()).toContain('MAGNUS_AGENT_PRIVILEGED must be true or false');
  });
});
