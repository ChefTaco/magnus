import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPinnedWebhookLookup,
  decryptWebhookCredential,
  encryptWebhookCredential,
  postWebhook,
  validateWebhookTarget,
} from './webhook-security.js';
import { createWebhookJobPayload, redactWebhookEndpoint, formatPayload } from './webhook-service.js';

const encryptionKey = 'webhook-test-encryption-key-with-more-than-32-bytes';
const publicLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }] as const);

beforeEach(() => {
  process.env['WEBHOOK_ENCRYPTION_KEY'] = encryptionKey;
  process.env['WEBHOOK_ALLOWED_ORIGINS'] = 'https://hooks.example';
  publicLookup.mockClear();
});

afterEach(() => {
  delete process.env['WEBHOOK_ENCRYPTION_KEY'];
  delete process.env['WEBHOOK_ALLOWED_ORIGINS'];
  delete process.env['WEBHOOK_TAILNET_TARGETS_JSON'];
  vi.restoreAllMocks();
});

describe('webhook credential envelopes', () => {
  it('encrypts with endpoint/field binding and rejects plaintext, wrong bindings, and wrong keys', () => {
    const plaintext = 'credential-that-must-not-appear-at-rest';
    const envelope = encryptWebhookCredential(plaintext, 'endpoint-a', 'secret');
    expect(envelope).toMatch(/^magnus-webhook:v1:/);
    expect(envelope).not.toContain(plaintext);
    expect(decryptWebhookCredential(envelope, 'endpoint-a', 'secret')).toBe(plaintext);
    expect(() => decryptWebhookCredential(envelope, 'endpoint-b', 'secret')).toThrow();
    expect(() => decryptWebhookCredential(envelope, 'endpoint-a', 'headers')).toThrow();
    expect(() => decryptWebhookCredential(envelope, 'endpoint-a', 'secret', 'different-key-that-is-also-at-least-32-bytes')).toThrow();
    expect(() => decryptWebhookCredential(plaintext, 'endpoint-a', 'secret')).toThrow(/migration/);
  });

  it('requires the dedicated encryption key and returns only redacted configuration metadata', () => {
    delete process.env['WEBHOOK_ENCRYPTION_KEY'];
    expect(() => encryptWebhookCredential('value', 'endpoint-a', 'secret')).toThrow(/WEBHOOK_ENCRYPTION_KEY/);
    process.env['WEBHOOK_ENCRYPTION_KEY'] = encryptionKey;
    const endpoint = redactWebhookEndpoint({
      id: 'endpoint-a',
      name: 'pager',
      secret: encryptWebhookCredential('signing-value', 'endpoint-a', 'secret'),
      headers: encryptWebhookCredential(JSON.stringify({ authorization: 'Bearer value' }), 'endpoint-a', 'headers'),
    });
    expect(endpoint).toEqual({
      id: 'endpoint-a',
      name: 'pager',
      secretConfigured: true,
      headersConfigured: true,
    });
    expect(endpoint).not.toHaveProperty('secret');
    expect(endpoint).not.toHaveProperty('headers');
  });
});

describe('webhook SSRF boundary', () => {
  it('accepts only exact allowlisted HTTPS DNS origins with exclusively public answers', async () => {
    await expect(validateWebhookTarget('https://hooks.example/path?token=x', { lookup: publicLookup }))
      .resolves.toMatchObject({ hostname: 'hooks.example' });
    expect(publicLookup).toHaveBeenCalledWith('hooks.example');

    for (const url of [
      'http://hooks.example/path',
      'https://user@hooks.example/path',
      'https://127.0.0.1/path',
      'https://metadata.google.internal/path',
      'https://unapproved.example/path',
    ]) {
      await expect(validateWebhookTarget(url, { lookup: publicLookup })).rejects.toThrow();
    }
  });

  it('rejects private, reserved, and mixed public/private DNS answers', async () => {
    for (const records of [
      [{ address: '127.0.0.1', family: 4 }],
      [{ address: '169.254.169.254', family: 4 }],
      [{ address: '10.0.0.2', family: 4 }],
      [{ address: '::1', family: 6 }],
      [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.2', family: 4 }],
    ]) {
      await expect(validateWebhookTarget('https://hooks.example/path', {
        lookup: async () => records,
      })).rejects.toThrow(/non-public/);
    }
  });

  it('allows only an explicitly pinned tailnet receiver and rejects rebinding or metadata pins', async () => {
    process.env['WEBHOOK_TAILNET_TARGETS_JSON'] = '{"https://hooks.example":["100.64.1.2"]}';
    await expect(validateWebhookTarget('https://hooks.example/path', {lookup:async () => [{address:'100.64.1.2',family:4}]})).resolves.toBeInstanceOf(URL);
    for (const address of ['100.64.1.3','127.0.0.1','169.254.169.254','93.184.216.34']) {
      await expect(validateWebhookTarget('https://hooks.example/path', {lookup:async () => [{address,family:4}]})).rejects.toThrow('non-public');
    }
    process.env['WEBHOOK_TAILNET_TARGETS_JSON'] = '{"https://hooks.example":["169.254.169.254"]}';
    await expect(validateWebhookTarget('https://hooks.example/path', {lookup:publicLookup})).rejects.toThrow('tailnet IPv4');
  });

  it('rejects redirects and bounds response capture', async () => {
    const redirectTransport = vi.fn(async () => ({ ok: false, status: 307, responseBody: '' }));
    await expect(postWebhook(
      'https://hooks.example/start',
      { headers: {}, body: '{}', timeoutMs: 1_000 },
      { lookup: publicLookup, transport: redirectTransport },
    )).rejects.toThrow(/redirects are rejected/);

    const response = await postWebhook(
      'https://hooks.example/start',
      { headers: {}, body: '{}', timeoutMs: 1_000 },
      {
        lookup: publicLookup,
        transport: async () => ({ ok: true, status: 200, responseBody: 'x'.repeat(3_000) }),
      },
    );
    expect(response.responseBody).toHaveLength(2_051);
    expect(response.responseBody.endsWith('...')).toBe(true);
  });

  it('pins the validated public answer and never performs a second rebindable lookup', async () => {
    const rebindingLookup = vi.fn()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const transport = vi.fn(async () => ({ ok: true, status: 204, responseBody: '' }));

    await postWebhook(
      'https://hooks.example/start',
      { headers: {}, body: '{}', timeoutMs: 1_000 },
      { lookup: rebindingLookup, transport },
    );

    expect(rebindingLookup).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ address: '93.184.216.34', family: 4 }),
      expect.any(Object),
    );

    const pinnedLookup = createPinnedWebhookLookup({
      url: new URL('https://hooks.example/start'),
      address: '93.184.216.34',
      family: 4,
    });
    const singleCallback = vi.fn();
    pinnedLookup('hooks.example', { all: false }, singleCallback);
    expect(singleCallback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    const allCallback = vi.fn();
    pinnedLookup('hooks.example', { all: true }, allCallback);
    expect(allCallback).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
  });
});

describe('webhook queue boundary', () => {
  it('places only the endpoint identifier in Redis job data', () => {
    expect(createWebhookJobPayload('endpoint-a')).toEqual({ endpointId: 'endpoint-a' });
    expect(Object.keys(createWebhookJobPayload('endpoint-a'))).toEqual(['endpointId']);
  });
});

describe('Mattermost payload and URL storage', () => {
  it('keeps webhook path credentials out of listings and formats incident/recovery text', () => {
    const endpoint=redactWebhookEndpoint({id:'chat',url:encryptWebhookCredential('https://hooks.example/hooks/private-secret','chat','url'),secret:null,headers:encryptWebhookCredential('{}','chat','headers')});
    expect(endpoint.url).toBe('https://hooks.example');expect(JSON.stringify(endpoint)).not.toContain('private-secret');
    for(const event of ['application.failed','application.recovered']) {
      const result=formatPayload('mattermost',event,JSON.stringify({severity:'warning',title:'Factory worker',message:'token=private-token @channel https://secret.invalid/path',createdAt:'2026-09-07T00:00:00Z'}));
      const payload=JSON.parse(result.body);expect(payload.text).toContain(event);expect(payload.text).toContain('Factory worker');
      expect(result.body).not.toContain('private-token');expect(result.body).not.toContain('@channel');expect(result.body).not.toContain('secret.invalid');
    }
  });
});
