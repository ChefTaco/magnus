import { describe, expect, it } from 'vitest';
import { describeIntegrations, hermesEnabled, hiveLoginConfigured, hiveRouterAdminUrl, readIntegrations, securityConsoleUrl } from '../../runtime-integrations.mjs';
import { securityConsoleDeepLink } from './security-console-route';
import { NAV_GROUPS, NO_INTEGRATIONS, activeNavHref, visibleNavGroups } from './routes';

const hiveLogin = {
  HIVE_OAUTH_DISCOVERY_URL: 'https://iam.example.com/.well-known/openid-configuration',
  HIVE_OAUTH_CLIENT_ID: 'magnus-ui',
  HIVE_OAUTH_ISSUER: 'https://iam.example.com',
  HIVE_OAUTH_API_AUDIENCE: 'magnus-api',
  DASHBOARD_PUBLIC_ORIGIN: 'https://magnus.example.com',
};

describe('optional integrations', () => {
  it('are all disabled in an empty environment', () => {
    expect(readIntegrations({})).toEqual(NO_INTEGRATIONS);
    expect(describeIntegrations({}).every((row) => !row.enabled)).toBe(true);
  });

  it('normalize configured URLs and reject unusable values', () => {
    expect(securityConsoleUrl({ MAGNUS_SECURITY_CONSOLE_URL: 'https://security.example.com:3444/' })).toBe('https://security.example.com:3444');
    expect(securityConsoleUrl({ MAGNUS_SECURITY_CONSOLE_URL: '   ' })).toBeNull();
    expect(securityConsoleUrl({ MAGNUS_SECURITY_CONSOLE_URL: 'not a url' })).toBeNull();
    expect(securityConsoleUrl({ MAGNUS_SECURITY_CONSOLE_URL: 'javascript:alert(1)' })).toBeNull();
    expect(securityConsoleUrl({ MAGNUS_SECURITY_CONSOLE_URL: 'https://user:pw@security.example.com' })).toBeNull();
    expect(hiveRouterAdminUrl({ HIVE_ROUTER_ADMIN_URL: 'https://router.example.com//' })).toBe('https://router.example.com');
    expect(hiveRouterAdminUrl({})).toBeNull();
  });

  it('require every Hive login variable', () => {
    expect(hiveLoginConfigured(hiveLogin)).toBe(true);
    expect(hiveLoginConfigured({ ...hiveLogin, HIVE_OAUTH_ISSUER: '' })).toBe(false);
  });

  it('enable Hermes only on an explicit true', () => {
    expect(hermesEnabled({ MAGNUS_HERMES_ENABLED: 'true' })).toBe(true);
    expect(hermesEnabled({ MAGNUS_HERMES_ENABLED: 'TRUE ' })).toBe(true);
    expect(hermesEnabled({ MAGNUS_HERMES_ENABLED: '1' })).toBe(false);
    expect(hermesEnabled({})).toBe(false);
  });
});

describe('integration-aware navigation', () => {
  const ids = (flags = NO_INTEGRATIONS) => visibleNavGroups(flags).map((group) => group.id);

  it('hides optional groups when nothing is configured', () => {
    expect(ids()).toEqual(['fleet', 'ardent', 'codex']);
  });

  it('shows the security group with an external console link when configured', () => {
    const groups = visibleNavGroups({ ...NO_INTEGRATIONS, securityConsoleUrl: 'https://security.example.com' });
    const security = groups.find((group) => group.id === 'security');
    expect(security?.items.map((item) => [item.href, Boolean(item.external)])).toEqual([
      ['https://security.example.com', true],
      ['/security-fusion', false],
    ]);
  });

  it('shows the Hermes group only when enabled', () => {
    expect(ids({ ...NO_INTEGRATIONS, hermes: true })).toContain('hermes');
  });

  it('never ships a hard-coded external link', () => {
    for (const group of NAV_GROUPS)
      for (const item of group.items) {
        expect(item.external).not.toBe(true);
        expect(item.href.startsWith('/')).toBe(true);
      }
  });

  it('keeps one active item per path', () => {
    expect(activeNavHref('/anomalies/remediation')).toBe('/anomalies/remediation');
    expect(activeNavHref('/nodes/node-1')).toBe('/nodes');
  });
});

describe('security console deep links', () => {
  const url = (path: string) => new URL(`https://magnus.example.com${path}`);

  it('return a real 404 without a configured console', () => {
    expect(securityConsoleDeepLink(url('/security-fusion/cases/case-1'), {})?.status).toBe(404);
  });

  it('redirect to the configured console', () => {
    const response = securityConsoleDeepLink(url('/security-fusion/events?severity=high'), { MAGNUS_SECURITY_CONSOLE_URL: 'https://security.example.com/' });
    expect(response?.status).toBe(307);
    expect(response?.headers.get('location')).toBe('https://security.example.com/security-fusion/events?severity=high');
  });

  it('leave the summary page and other routes alone', () => {
    expect(securityConsoleDeepLink(url('/security-fusion'), {})).toBeNull();
    expect(securityConsoleDeepLink(url('/nodes'), {})).toBeNull();
  });
});
