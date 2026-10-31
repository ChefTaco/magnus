import type { LlmChatRequest, LlmChatResult, LlmMessage, LlmMessageImagePart, LlmProvider, LlmProviderHealth, LlmStreamEvent, LlmToolCall, ProviderId, ThinkingMode } from './types.js';
import { createHttpProviderError, LlmProviderError, normalizeProviderError } from './provider-error.js';

interface OllamaShowResponse {
  capabilities?: unknown;
  details?: Record<string, unknown>;
  model_info?: Record<string, unknown>;
  template?: string;
  modelfile?: string;
}

interface OllamaResponse {
  model: string;
  message: {
    role: string;
    content: string;
    thinking?: string | null;
    tool_calls?: Array<{
      function: {
        name: string;
        arguments: Record<string, unknown>;
      };
    }>;
  };
  done: boolean;
  eval_count?: number;
}

const THINKING_CAPABILITY_TTL_MS = 5 * 60 * 1000;
const thinkingCapabilityCache = new Map<string, { checkedAt: number; supportsThinking: boolean }>();

function supportsThinkingHeuristic(model: string): boolean {
  return model.includes('qwen3') || model.includes('gpt-oss') || model.includes('deepseek-r1');
}

function containsThinkingSignal(value: unknown): boolean {
  if (typeof value === 'string') {
    return /thinking|reasoning|<think>/i.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsThinkingSignal(entry));
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some((entry) => containsThinkingSignal(entry));
  }
  return false;
}

export async function getOllamaThinkingCapability(baseUrl: string, model: string): Promise<boolean> {
  const cacheKey = `${baseUrl}::${model}`;
  const cached = thinkingCapabilityCache.get(cacheKey);
  if (cached && (Date.now() - cached.checkedAt) < THINKING_CAPABILITY_TTL_MS) {
    return cached.supportsThinking;
  }

  let supportsThinking = supportsThinkingHeuristic(model);

  try {
    const response = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      const data = (await response.json()) as OllamaShowResponse;
      supportsThinking = containsThinkingSignal(data.capabilities)
        || containsThinkingSignal(data.details)
        || containsThinkingSignal(data.model_info)
        || containsThinkingSignal(data.template)
        || containsThinkingSignal(data.modelfile)
        || supportsThinkingHeuristic(model);
    }
  } catch {
    supportsThinking = supportsThinkingHeuristic(model);
  }

  thinkingCapabilityCache.set(cacheKey, { checkedAt: Date.now(), supportsThinking });
  return supportsThinking;
}

function supportsStructuredOutputs(model: string): boolean {
  return !model.includes('legacy');
}

function getThinkingInstruction(mode: ThinkingMode): string | null {
  switch (mode) {
    case 'deep':
      return 'Reasoning: high';
    case 'standard':
      return 'Reasoning: medium';
    default:
      return null;
  }
}

export class OllamaProvider implements LlmProvider {
  readonly id: ProviderId = 'ollama';
  readonly name = 'Ollama';
  readonly supportsStreaming = true;
  readonly supportsToolCalling = true;
  readonly supportsStructuredOutputs = true;

  constructor(public readonly baseUrl = process.env['OLLAMA_URL'] ?? 'http://127.0.0.1:11434') {}

  isConfigured(): boolean {
    return Boolean(this.baseUrl);
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResult> {
    const usedModel = request.model;
    const thinkingCapable = await getOllamaThinkingCapability(this.baseUrl, usedModel);
    const thinkingMode = thinkingCapable ? (request.thinkingMode ?? 'standard') : 'off';
    const reasoningInstruction = getThinkingInstruction(thinkingMode);
    const messages: LlmMessage[] = reasoningInstruction
      ? [{ role: 'system' as const, content: reasoningInstruction }, ...request.messages]
      : request.messages;

    // Map images for multi-modal models
    const ollamaMessages = messages.map((m) => {
      const out: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.images?.length) {
        out.images = m.images.map((img: LlmMessageImagePart) => img.data);
      }
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      return out;
    });

    const body: Record<string, unknown> = {
      model: usedModel,
      messages: ollamaMessages,
      stream: false,
      options: {
        temperature: request.temperature ?? 0.3,
        num_predict: request.maxTokens ?? 4096,
      },
    };

    if (request.tools?.length) {
      body.tools = request.tools;
    }
    if (request.jsonSchema && supportsStructuredOutputs(usedModel)) {
      body.format = request.jsonSchema;
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw createHttpProviderError(this.id, response.status, `Ollama API error: ${response.status} ${text.slice(0, 200)}`);
      }

      const data = (await response.json()) as OllamaResponse;
      const nativeToolCalls: LlmToolCall[] = (data.message?.tool_calls ?? []).map((toolCall) => ({
        name: toolCall.function.name,
        arguments: toolCall.function.arguments ?? {},
      }));

      return {
        providerId: this.id,
        providerName: this.name,
        model: data.model ?? usedModel,
        content: data.message?.content ?? '',
        thinking: data.message?.thinking ?? '',
        evalCount: data.eval_count ?? 0,
        nativeToolCalls,
        usedStructuredOutput: Boolean(request.jsonSchema) && supportsStructuredOutputs(usedModel),
      };
    } catch (error) {
      if (error instanceof LlmProviderError) throw error;
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new LlmProviderError(this.id, 'connectivity', 'Ollama request timed out', true);
      }
      throw normalizeProviderError(this.id, error);
    }
  }

  async *streamChat(request: LlmChatRequest): AsyncIterable<LlmStreamEvent> {
    const usedModel = request.model;
    const thinkingCapable = await getOllamaThinkingCapability(this.baseUrl, usedModel);
    const thinkingMode = thinkingCapable ? (request.thinkingMode ?? 'standard') : 'off';
    const reasoningInstruction = getThinkingInstruction(thinkingMode);
    const messages: LlmMessage[] = reasoningInstruction
      ? [{ role: 'system' as const, content: reasoningInstruction }, ...request.messages]
      : request.messages;

    // Map images for multi-modal models
    const ollamaMessages = messages.map((m) => {
      const out: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.images?.length) {
        out.images = m.images.map((img: LlmMessageImagePart) => img.data);
      }
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      return out;
    });

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: usedModel,
        messages: ollamaMessages,
        tools: request.tools?.length ? request.tools : undefined,
        stream: true,
        options: {
          temperature: request.temperature ?? 0.3,
          num_predict: request.maxTokens ?? 4096,
        },
      }),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw createHttpProviderError(this.id, response.status, `Ollama stream error: ${response.status} ${text.slice(0, 200)}`);
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
        if (!line.trim()) continue;
        const chunk = JSON.parse(line) as {
          message?: {
            content?: string;
            thinking?: string;
            tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
          };
          eval_count?: number;
        };
        if (chunk.message?.thinking) {
          yield { type: 'thinking', text: chunk.message.thinking };
        }
        if (chunk.message?.content) {
          yield { type: 'content', text: chunk.message.content };
        }
        if (chunk.message?.tool_calls?.length) {
          yield {
            type: 'tool_calls',
            toolCalls: chunk.message.tool_calls.map((toolCall) => ({
              name: toolCall.function.name,
              arguments: toolCall.function.arguments ?? {},
            })),
          };
        }
        if (chunk.eval_count) {
          yield { type: 'usage', evalCount: chunk.eval_count };
        }
      }
    }

    if (buffer.trim()) {
      const chunk = JSON.parse(buffer) as {
        message?: {
          content?: string;
          thinking?: string;
          tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
        };
        eval_count?: number;
      };
      if (chunk.message?.thinking) {
        yield { type: 'thinking', text: chunk.message.thinking };
      }
      if (chunk.message?.content) {
        yield { type: 'content', text: chunk.message.content };
      }
      if (chunk.message?.tool_calls?.length) {
        yield {
          type: 'tool_calls',
          toolCalls: chunk.message.tool_calls.map((toolCall) => ({
            name: toolCall.function.name,
            arguments: toolCall.function.arguments ?? {},
          })),
        };
      }
      if (chunk.eval_count) {
        yield { type: 'usage', evalCount: chunk.eval_count };
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
        error: 'OLLAMA_URL is not configured',
        checkedAt,
        supportsStreaming: this.supportsStreaming,
        supportsToolCalling: this.supportsToolCalling,
        supportsStructuredOutputs: this.supportsStructuredOutputs,
      };
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) {
        throw createHttpProviderError(this.id, response.status, `Ollama health check failed: ${response.status}`);
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
