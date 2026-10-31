import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOllamaThinkingCapability } from './ollama.js';

describe('getOllamaThinkingCapability', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('detects explicit thinking capability from /api/show', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      capabilities: ['tools', 'thinking'],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const supported = await getOllamaThinkingCapability('http://ollama.test', 'plain-model');

    expect(fetchMock).toHaveBeenCalledWith('http://ollama.test/api/show', expect.objectContaining({ method: 'POST' }));
    expect(supported).toBe(true);
  });

  it('falls back to the heuristic when the capability probe fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const supported = await getOllamaThinkingCapability('http://ollama-fallback.test', 'gpt-oss:120b');

    expect(supported).toBe(true);
  });
});
