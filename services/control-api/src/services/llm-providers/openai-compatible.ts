import type { LlmChatRequest, LlmChatResult, LlmProvider, LlmProviderHealth, LlmToolCall, ProviderId } from './types.js';
import { createHttpProviderError, LlmProviderError, normalizeProviderError } from './provider-error.js';

interface OpenAiCompatibleConfig {
  id: Extract<ProviderId, 'openai' | 'openrouter'>;
  name: string;
  baseUrl: string;
  apiKey?: string;
  defaultHeaders?: Record<string, string>;
}

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

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly supportsStreaming = false;
  readonly supportsToolCalling = true;
  readonly supportsStructuredOutputs = true;

  readonly id: Extract<ProviderId, 'openai' | 'openrouter'>;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  private readonly defaultHeaders: Record<string, string>;

  constructor(config: OpenAiCompatibleConfig) {
    this.id = config.id;
    this.name = config.name;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.defaultHeaders = config.defaultHeaders ?? {};
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.apiKey);
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...this.defaultHeaders,
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResult> {
    if (!this.isConfigured()) {
      throw new LlmProviderError(this.id, 'configuration', `${this.name} is not configured`, false);
    }

    const payload: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((message) => {
        if (message.role === 'assistant' && message.tool_calls?.length) {
          return {
            role: 'assistant',
            content: message.content || null,
            tool_calls: message.tool_calls.map((toolCall) => ({
              id: toolCall.id,
              type: 'function',
              function: {
                name: toolCall.name,
                arguments: JSON.stringify(toolCall.arguments ?? {}),
              },
            })),
          };
        }

        if (message.role === 'tool') {
          return {
            role: 'tool',
            content: message.content,
            tool_call_id: message.tool_call_id,
          };
        }

        return {
          role: message.role,
          content: message.content,
        };
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
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw createHttpProviderError(this.id, response.status, `${this.name} API error: ${response.status} ${text.slice(0, 300)}`);
      }

      const data = (await response.json()) as {
        id?: string;
        model?: string;
        usage?: { total_tokens?: number };
        choices?: Array<{
          message?: {
            content?: unknown;
            tool_calls?: Array<{
              id?: string;
              function?: {
                name?: string;
                arguments?: string;
              };
            }>;
          };
        }>;
      };

      const message = data.choices?.[0]?.message;
      const nativeToolCalls: LlmToolCall[] = (message?.tool_calls ?? []).flatMap((toolCall) => {
        const name = toolCall.function?.name;
        if (!name) return [];
        let argumentsObject: Record<string, unknown> = {};
        try {
          argumentsObject = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
        } catch {
          argumentsObject = {};
        }
        return [{ id: toolCall.id, name, arguments: argumentsObject }];
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
      throw normalizeProviderError(this.id, error);
    }
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
        error: `${this.name} API URL or key is not configured`,
        checkedAt,
        supportsStreaming: this.supportsStreaming,
        supportsToolCalling: this.supportsToolCalling,
        supportsStructuredOutputs: this.supportsStructuredOutputs,
      };
    }

    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw createHttpProviderError(this.id, response.status, `${this.name} health check failed: ${text.slice(0, 200)}`);
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
