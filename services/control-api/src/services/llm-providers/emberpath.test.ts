import { afterEach, describe, expect, it, vi } from 'vitest';
import { emberpathSettings } from './emberpath.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';

const configured = {
  MAGNUS_EMBERPATH_URL: 'https://models.example.com/v1/',
  MAGNUS_EMBERPATH_API_KEY: 'ep-test-key',
  MAGNUS_EMBERPATH_MODEL: ' fleet-assistant ',
};

describe('emberpathSettings', () => {
  it('is null unless the URL, key and model are all set', () => {
    expect(emberpathSettings({})).toBeNull();
    expect(emberpathSettings({ ...configured, MAGNUS_EMBERPATH_MODEL: undefined })).toBeNull();
    expect(emberpathSettings({ ...configured, MAGNUS_EMBERPATH_API_KEY: undefined })).toBeNull();
  });

  it('is null for an invalid URL', () => {
    expect(emberpathSettings({ ...configured, MAGNUS_EMBERPATH_URL: 'https://user:pass@models.example.com/v1' })).toBeNull();
  });

  it('normalizes the base URL and model', () => {
    expect(emberpathSettings(configured)).toEqual({ baseUrl: 'https://models.example.com/v1', apiKey: 'ep-test-key', model: 'fleet-assistant' });
  });
});

describe('emberpath provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls chat completions under the base URL with the client key as a Bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'fleet-assistant',
      usage: { total_tokens: 7 },
      choices: [{ message: { content: 'ok' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const settings = emberpathSettings(configured)!;
    const provider = new OpenAiCompatibleProvider({ id: 'emberpath', name: 'Emberpath', baseUrl: settings.baseUrl, apiKey: settings.apiKey });

    const result = await provider.chat({ model: settings.model, messages: [{ role: 'user', content: 'hi' }] });

    expect(result).toMatchObject({ providerId: 'emberpath', providerName: 'Emberpath', content: 'ok' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://models.example.com/v1/chat/completions');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer ep-test-key' });
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ model: 'fleet-assistant' });
  });

  it('is not configured without a base URL and key', () => {
    expect(new OpenAiCompatibleProvider({ id: 'emberpath', name: 'Emberpath', baseUrl: '' }).isConfigured()).toBe(false);
  });
});
