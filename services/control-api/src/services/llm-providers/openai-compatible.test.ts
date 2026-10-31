import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import type { LlmToolDefinition } from './types.js';

describe('OpenAiCompatibleProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parses content, usage, and native tool calls from chat completions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'gpt-4.1-mini',
      usage: { total_tokens: 42 },
      choices: [{
        message: {
          content: '{"ok":true}',
          tool_calls: [{
            id: 'call_123',
            function: {
              name: 'getFleetStatus',
              arguments: '{}',
            },
          }],
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAiCompatibleProvider({
      id: 'openai',
      name: 'OpenAI-compatible',
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
    });

    const tools: LlmToolDefinition[] = [{
      type: 'function',
      function: {
        name: 'getFleetStatus',
        description: 'Get fleet status',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    }];

    const result = await provider.chat({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'gpt-4.1-mini',
      tools,
      jsonSchema: { type: 'object' },
    });

    expect(fetchMock).toHaveBeenCalledWith('https://example.test/v1/chat/completions', expect.objectContaining({ method: 'POST' }));
    expect(result.content).toBe('{"ok":true}');
    expect(result.evalCount).toBe(42);
    expect(result.nativeToolCalls).toEqual([{ id: 'call_123', name: 'getFleetStatus', arguments: {} }]);
    expect(result.usedStructuredOutput).toBe(true);
  });

  it('reports unconfigured health when API key is missing', async () => {
    const provider = new OpenAiCompatibleProvider({
      id: 'openai',
      name: 'OpenAI-compatible',
      baseUrl: 'https://example.test/v1',
    });

    const health = await provider.healthCheck();

    expect(health.configured).toBe(false);
    expect(health.healthy).toBe(false);
    expect(health.error).toMatch(/not configured/i);
  });
});
