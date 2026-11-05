import { afterEach, describe, expect, it, vi } from 'vitest';
import { consolePagePath, isConsoleBasePath } from './console-path.js';
import { loadEnv } from './env.js';
import { formatPayload } from '../services/webhook-service.js';

afterEach(() => vi.unstubAllEnvs());

const event = JSON.stringify({ severity: 'warning', title: 'Fixture', message: 'Fixture', createdAt: '2026-01-01T00:00:00Z' });
const text = () => (JSON.parse(formatPayload('mattermost', 'node.offline', event).body) as { text: string }).text;

describe('console base path', () => {
  it('defaults to the origin root', () => {
    expect(consolePagePath('/incidents', {})).toBe('/incidents');
  });

  it('prefixes a configured base', () => {
    expect(consolePagePath('/incidents', { MAGNUS_CONSOLE_BASE_PATH: '/fleet' })).toBe('/fleet/incidents');
    expect(consolePagePath('/incidents', { MAGNUS_CONSOLE_BASE_PATH: '/apps/fleet' })).toBe('/apps/fleet/incidents');
  });

  it.each(['fleet', '/', '/fleet/', '//evil.example.com', '/../fleet', '/fleet/..', '/a/./b', '/fleet?x=1', '/fleet#x', 'https://evil.example.com', '/fl eet'])(
    'rejects %s',
    (value) => {
      expect(isConsoleBasePath(value)).toBe(false);
      expect(consolePagePath('/incidents', { MAGNUS_CONSOLE_BASE_PATH: value })).toBeNull();
      expect(() => loadEnv({ MAGNUS_CONSOLE_BASE_PATH: value })).toThrow(/MAGNUS_CONSOLE_BASE_PATH/);
    },
  );

  it('keeps the webhook link unchanged by default', () => {
    vi.stubEnv('DASHBOARD_PUBLIC_ORIGIN', 'https://magnus.example.com');
    expect(text()).toContain('Review: https://magnus.example.com/incidents');
  });

  it('points the webhook link at the configured console', () => {
    vi.stubEnv('DASHBOARD_PUBLIC_ORIGIN', 'https://console.example.com');
    vi.stubEnv('MAGNUS_CONSOLE_BASE_PATH', '/fleet');
    expect(text()).toContain('Review: https://console.example.com/fleet/incidents');
  });

  it('omits the webhook link rather than emit an invalid path', () => {
    vi.stubEnv('DASHBOARD_PUBLIC_ORIGIN', 'https://console.example.com');
    vi.stubEnv('MAGNUS_CONSOLE_BASE_PATH', '//evil.example.com');
    expect(text()).not.toContain('Review:');
  });
});
