import { AnthropicProvider } from './anthropic.js';
import { OllamaProvider } from './ollama.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import { LlamaCppProvider } from './llama-cpp.js';
import type { LlmProvider, LlmProviderHealth, ProviderId } from './types.js';

const providers: Record<ProviderId, LlmProvider> = {
  ollama: new OllamaProvider(),
  llamacpp: new LlamaCppProvider(),
  openai: new OpenAiCompatibleProvider({
    id: 'openai',
    name: 'OpenAI-compatible',
    baseUrl: process.env['OPENAI_API_URL'] ?? 'https://api.openai.com/v1',
    apiKey: process.env['OPENAI_API_KEY'],
  }),
  anthropic: new AnthropicProvider(),
  openrouter: new OpenAiCompatibleProvider({
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: process.env['OPENROUTER_API_URL'] ?? 'https://openrouter.ai/api/v1',
    apiKey: process.env['OPENROUTER_API_KEY'],
    defaultHeaders: {
      'HTTP-Referer': process.env['OPENROUTER_HTTP_REFERER'] ?? 'https://magnus.local',
      'X-Title': process.env['OPENROUTER_APP_NAME'] ?? 'Magnus AI',
    },
  }),
};

let providerHealthCache: { fetchedAt: number; statuses: LlmProviderHealth[] } | null = null;
const PROVIDER_HEALTH_TTL_MS = 5 * 60 * 1000;

export function getLlmProvider(id: ProviderId): LlmProvider {
  return providers[id];
}

export function listLlmProviders(): LlmProvider[] {
  return Object.values(providers);
}

export async function getLlmProviderStatuses(force = false): Promise<LlmProviderHealth[]> {
  if (!force && providerHealthCache && (Date.now() - providerHealthCache.fetchedAt) < PROVIDER_HEALTH_TTL_MS) {
    return providerHealthCache.statuses;
  }

  const statuses = await Promise.all(listLlmProviders().map((provider) => provider.healthCheck()));
  providerHealthCache = {
    fetchedAt: Date.now(),
    statuses,
  };
  return statuses;
}
