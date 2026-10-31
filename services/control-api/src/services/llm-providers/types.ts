export type ProviderId = 'ollama' | 'llamacpp' | 'openai' | 'anthropic' | 'openrouter';
export type ThinkingMode = 'off' | 'standard' | 'deep';

export interface LlmToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmMessageImagePart {
  type: 'image';
  /** Base64-encoded image data (no data: prefix) */
  data: string;
  /** MIME type e.g. image/png, image/jpeg */
  mimeType?: string;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Optional images for multi-modal models */
  images?: LlmMessageImagePart[];
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
}

export interface LlmToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

export interface LlmChatRequest {
  messages: LlmMessage[];
  model: string;
  tools?: LlmToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  thinkingMode?: ThinkingMode;
  jsonSchema?: Record<string, unknown> | null;
}

export interface LlmChatResult {
  providerId: ProviderId;
  providerName: string;
  model: string;
  content: string;
  thinking: string;
  evalCount: number;
  nativeToolCalls: LlmToolCall[];
  usedStructuredOutput: boolean;
}

export type LlmStreamEvent =
  | { type: 'content'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_calls'; toolCalls: LlmToolCall[] }
  | { type: 'usage'; evalCount: number }
  | { type: 'done' };

export interface LlmProviderHealth {
  id: ProviderId;
  name: string;
  configured: boolean;
  healthy: boolean;
  baseUrl?: string;
  error?: string;
  checkedAt: string;
  supportsStreaming: boolean;
  supportsToolCalling: boolean;
  supportsStructuredOutputs: boolean;
}

export interface LlmProvider {
  readonly id: ProviderId;
  readonly name: string;
  readonly baseUrl?: string;
  readonly supportsStreaming: boolean;
  readonly supportsToolCalling: boolean;
  readonly supportsStructuredOutputs: boolean;
  isConfigured(): boolean;
  chat(request: LlmChatRequest): Promise<LlmChatResult>;
  streamChat?(request: LlmChatRequest): AsyncIterable<LlmStreamEvent>;
  healthCheck(): Promise<LlmProviderHealth>;
}

export interface ProviderFallback {
  provider: ProviderId;
  model: string;
}
