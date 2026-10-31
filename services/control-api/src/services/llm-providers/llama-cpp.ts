import type { LlmChatRequest, LlmChatResult, LlmProvider, LlmProviderHealth, LlmStreamEvent, LlmToolCall, ProviderId } from './types.js';
import { createHttpProviderError, LlmProviderError, normalizeProviderError } from './provider-error.js';

function joinContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && 'text' in entry) {
          return String((entry as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .join('');
  }
  return '';
}

export class LlamaCppProvider implements LlmProvider {
  readonly id: ProviderId = 'llamacpp';
  readonly name = 'llama.cpp';
  readonly supportsStreaming = true;
  readonly supportsToolCalling = true;
  readonly supportsStructuredOutputs = true;

  constructor(public readonly baseUrl = process.env['LLAMACPP_URL'] ?? process.env['VLLM_URL'] ?? 'http://127.0.0.1:8080') {}

  isConfigured(): boolean {
    return Boolean(this.baseUrl);
  }

  private get apiBase(): string {
    return this.baseUrl.replace(/\/+$/, '');
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResult> {
    if (!this.isConfigured()) {
      throw new LlmProviderError(this.id, 'configuration', 'llama.cpp is not configured', false);
    }

    const payload: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((m) => {
        if (m.role === 'assistant' && m.tool_calls?.length) {
          return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.tool_calls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments ?? {}),
              },
            })),
          };
        }
        if (m.role === 'tool') {
          return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id };
        }
        return { role: m.role, content: m.content };
      }),
      temperature: request.temperature ?? 0.3,
      max_tokens: request.maxTokens ?? 4096,
      stream: false,
    };

    if (request.tools?.length) {
      payload.tools = request.tools.map((tool) => ({
        type: tool.type,
        function: {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        },
      }));
      payload.tool_choice = 'auto';
    }

    if (request.jsonSchema) {
      payload.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'structured_output',
          schema: request.jsonSchema,
          strict: true,
        },
      };
    }

    try {
      const response = await fetch(`${this.apiBase}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw createHttpProviderError(this.id, response.status, `llama.cpp API error: ${response.status} ${text.slice(0, 300)}`);
      }

      const data = (await response.json()) as {
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        choices?: Array<{
          message?: {
            content?: unknown;
            tool_calls?: Array<{
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };

      const message = data.choices?.[0]?.message;
      const nativeToolCalls: LlmToolCall[] = (message?.tool_calls ?? []).flatMap((tc) => {
        const name = tc.function?.name;
        if (!name) return [];
        let args: Record<string, unknown> = {};
        try {
          args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          args = {};
        }
        return [{ id: tc.id, name, arguments: args }];
      });

      return {
        providerId: this.id,
        providerName: this.name,
        model: data.model ?? request.model,
        content: joinContent(message?.content),
        thinking: '',
        evalCount: data.usage?.total_tokens ?? 0,
        nativeToolCalls,
        usedStructuredOutput: Boolean(request.jsonSchema),
      };
    } catch (error) {
      if (error instanceof LlmProviderError) throw error;
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new LlmProviderError(this.id, 'connectivity', 'llama.cpp request timed out', true);
      }
      throw normalizeProviderError(this.id, error);
    }
  }

  async *streamChat(request: LlmChatRequest): AsyncIterable<LlmStreamEvent> {
    if (!this.isConfigured()) {
      throw new LlmProviderError(this.id, 'configuration', 'llama.cpp is not configured', false);
    }

    const payload: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: request.temperature ?? 0.3,
      max_tokens: request.maxTokens ?? 4096,
      stream: true,
      stream_options: { include_usage: true },
    };

    const response = await fetch(`${this.apiBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw createHttpProviderError(this.id, response.status, `llama.cpp stream error: ${response.status} ${text.slice(0, 200)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const chunk = JSON.parse(trimmed.slice(6)) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            yield { type: 'content', text: delta };
          }
          if (chunk.usage?.total_tokens) {
            yield { type: 'usage', evalCount: chunk.usage.total_tokens };
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }

    yield { type: 'done' };
  }

  async healthCheck(): Promise<LlmProviderHealth> {
    const checkedAt = new Date().toISOString();
    if (!this.isConfigured()) {
      return {
        id: this.id,
        name: this.name,
        configured: false,
        healthy: false,
        baseUrl: this.baseUrl,
        error: 'LLAMACPP_URL is not configured',
        checkedAt,
        supportsStreaming: this.supportsStreaming,
        supportsToolCalling: this.supportsToolCalling,
        supportsStructuredOutputs: this.supportsStructuredOutputs,
      };
    }

    try {
      const response = await fetch(`${this.apiBase}/v1/models`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) {
        throw createHttpProviderError(this.id, response.status, `llama.cpp health check failed: ${response.status}`);
      }
      return {
        id: this.id,
        name: this.name,
        configured: true,
        healthy: true,
        baseUrl: this.baseUrl,
        checkedAt,
        supportsStreaming: this.supportsStreaming,
        supportsToolCalling: this.supportsToolCalling,
        supportsStructuredOutputs: this.supportsStructuredOutputs,
      };
    } catch (error) {
      const normalized = normalizeProviderError(this.id, error);
      return {
        id: this.id,
        name: this.name,
        configured: true,
        healthy: false,
        baseUrl: this.baseUrl,
        error: normalized.message,
        checkedAt,
        supportsStreaming: this.supportsStreaming,
        supportsToolCalling: this.supportsToolCalling,
        supportsStructuredOutputs: this.supportsStructuredOutputs,
      };
    }
  }
}
