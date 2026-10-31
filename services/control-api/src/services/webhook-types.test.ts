import { afterEach, describe, expect, it, vi } from 'vitest';
import { webhookFormat, webhookTypeAliases } from './webhook-types.js';
import { formatPayload } from './webhook-service.js';
import { loadEnv } from '../config/env.js';

afterEach(() => vi.unstubAllEnvs());

describe('legacy webhook type aliases', () => {
  it('maps nothing by default', () => {
    expect(webhookTypeAliases(undefined)).toEqual({});
    expect(webhookFormat('legacy-chat')).toBe('legacy-chat');
    expect(webhookFormat('slack')).toBe('slack');
  });
  it('maps configured legacy names to current formats', () => {
    vi.stubEnv('MAGNUS_WEBHOOK_TYPE_ALIASES', 'legacy-chat=mattermost, old_hook = generic');
    expect(webhookFormat('legacy-chat')).toBe('mattermost');
    expect(webhookFormat('old_hook')).toBe('generic');
    expect(webhookFormat('discord')).toBe('discord');
    expect(webhookFormat('toString')).toBe('toString');
    const formatted = formatPayload(webhookFormat('legacy-chat'), 'node.offline', JSON.stringify({ message: 'node down @alice' }));
    expect(formatted.contentType).toBe('application/json');
    expect(formatted.body).toContain('[mention]');
  });
  it('rejects malformed alias lists', () => {
    for (const raw of ['legacy', 'legacy=teams', 'slack=generic', 'Legacy=slack', 'a=b=c', '=slack'])
      expect(() => webhookTypeAliases(raw), raw).toThrow(/MAGNUS_WEBHOOK_TYPE_ALIASES/);
    expect(() => loadEnv({ MAGNUS_WEBHOOK_TYPE_ALIASES: 'slack=generic' })).toThrow(/MAGNUS_WEBHOOK_TYPE_ALIASES/);
    expect(() => loadEnv({ MAGNUS_WEBHOOK_TYPE_ALIASES: 'legacy=teams' })).toThrow(/MAGNUS_WEBHOOK_TYPE_ALIASES/);
    expect(loadEnv({ MAGNUS_WEBHOOK_TYPE_ALIASES: 'legacy-chat=mattermost' }).MAGNUS_WEBHOOK_TYPE_ALIASES).toBe('legacy-chat=mattermost');
  });
});
