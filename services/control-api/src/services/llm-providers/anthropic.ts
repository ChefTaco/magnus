import type { LlmChatRequest, LlmChatResult, LlmProvider, LlmProviderHealth, ProviderId } from './types.js';
import { createHttpProviderError, LlmProviderError, normalizeProviderError } from './provider-error.js';

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return '';
        if ('text' in entry) return String((entry as { text?: unknown }).text ?? '');
        return '';
      })
      .join('');
  }
  return '';
}

export class AnthropicProvider implements LlmProvider {
  readonly id: ProviderId = 'anthropic';
  readonly name = 'Anthropic';
  readonly supportsStreaming = false;
  readonly supportsToolCalling = false;
  readonly supportsStructuredOutputs = false;

  constructor(
    public readonly baseUrl = process.env['ANTHROPIC_API_URL'] ?? 'https://api.anthropic.com/v1',
    private readonly apiKey = process.env['ANTHROPIC_API_KEY'],
  ) {}

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.apiKey);
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey ?? '',
      'anthropic-version': '2023-06-01',
    };
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResult> {
    if (!this.isConfigured()) {
      throw new LlmProviderError(this.id, 'configuration', 'Anthropic is not configured', false);
    }

    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');

    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
      }));

    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/messages`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          model: request.model,
          system,
          max_tokens: request.maxTokens ?? 4096,
          temperature: request.temperature ?? 0.3,
          messages,
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw createHttpProviderError(this.id, response.status, `Anthropic API error: ${response.status} ${text.slice(0, 300)}`);
      }

      const data = (await response.json()) as {
        model?: string;
        content?: unknown;
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      return {
        providerId: this.id,
        providerName: this.name,
        model: data.model ?? request.model,
        content: contentToString(data.content),
        thinking: '',
        evalCount: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
        nativeToolCalls: [],
        usedStructuredOutput: false,
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
        error: 'Anthropic API URL or key is not configured',
        checkedAt,
        supportsStreaming: this.supportsStreaming,
        supportsToolCalling: this.supportsToolCalling,
        supportsStructuredOutputs: this.supportsStructuredOutputs,
      };
    }

    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/models`, {
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw createHttpProviderError(this.id, response.status, `Anthropic health check failed: ${text.slice(0, 200)}`);
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
