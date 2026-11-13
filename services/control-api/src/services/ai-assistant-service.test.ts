import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  aiMemoryFindUnique: vi.fn(),
  aiMemoryUpdate: vi.fn(),
  aiMemoryCreate: vi.fn(),
  aiMessageFindUnique: vi.fn(),
  aiMessageUpdateMany: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getDb: () => ({
    aiMemory: {
      findUnique: dbMocks.aiMemoryFindUnique,
      update: dbMocks.aiMemoryUpdate,
      create: dbMocks.aiMemoryCreate,
    },
    aiMessage: {
      findUnique: dbMocks.aiMessageFindUnique,
      updateMany: dbMocks.aiMessageUpdateMany,
    },
  }),
}));

import { claimPendingApproval, getPendingApprovalConversation, getModelProfiles, getToolCallSignature, getTextSimilarity, hasStalledForwardProgress, resolveRouteModel, selectModel, updateModelProfiles } from './ai-assistant-service.js';

beforeEach(() => {
  dbMocks.aiMemoryFindUnique.mockReset();
  dbMocks.aiMemoryUpdate.mockReset();
  dbMocks.aiMemoryCreate.mockReset();
  dbMocks.aiMemoryFindUnique.mockResolvedValue(null);
});

describe('ai-assistant-service model routing', () => {
  it('merges saved routes with built-in routes so heartbeat and legacy traits cannot disappear', async () => {
    dbMocks.aiMemoryFindUnique.mockResolvedValue({
      content: JSON.stringify([
        { taskType: 'chat', provider: 'openai', model: 'gpt-4.1-mini', fallbacks: [], temperature: 0.4, maxTokens: 1234 },
      ]),
    });

    const profiles = await getModelProfiles();

    expect(profiles.find((profile) => profile.taskType === 'chat')).toMatchObject({ provider: 'openai', model: 'gpt-4.1-mini', routeSource: 'saved' });
    expect(profiles.find((profile) => profile.taskType === 'heartbeat')).toMatchObject({ taskType: 'heartbeat', routeSource: 'built-in' });
    expect(profiles.find((profile) => profile.taskType === 'dangerous')).toMatchObject({ taskType: 'dangerous', provider: 'openai', routeSource: 'built-in' });
    expect(profiles.find((profile) => profile.taskType === 'hard')).toMatchObject({ taskType: 'hard', routePurpose: expect.stringContaining('Maximum-reasoning') });
  });

  it('selects exact built-in routes before falling back to chat', async () => {
    dbMocks.aiMemoryFindUnique.mockResolvedValue({
      content: JSON.stringify([
        { taskType: 'chat', provider: 'openai', model: 'gpt-4.1-mini', fallbacks: [], temperature: 0.4, maxTokens: 1234 },
      ]),
    });

    await expect(selectModel('heartbeat')).resolves.toMatchObject({ taskType: 'heartbeat', routeSource: 'built-in' });
    await expect(selectModel('not_a_route')).resolves.toMatchObject({ taskType: 'chat', provider: 'openai', routeSource: 'saved' });
  });

  it('does not persist explanatory route metadata back into stored route config', async () => {
    await updateModelProfiles([
      { taskType: 'heartbeat', provider: 'llamacpp', model: '', fallbacks: [], temperature: 0.2, maxTokens: 2048, routePurpose: 'temporary UI text', routeReason: 'temporary UI text', routeSource: 'built-in' },
    ]);

    expect(dbMocks.aiMemoryCreate).toHaveBeenCalledTimes(1);
    const createArg = dbMocks.aiMemoryCreate.mock.calls[0]?.[0] as { data: { content: string } };
    const persisted = JSON.parse(createArg.data.content) as Array<Record<string, unknown>>;
    expect(persisted[0]).toMatchObject({ taskType: 'heartbeat', provider: 'llamacpp', model: '' });
    expect(persisted[0]).not.toHaveProperty('routePurpose');
    expect(persisted[0]).not.toHaveProperty('routeReason');
    expect(persisted[0]).not.toHaveProperty('routeSource');
  });
});

describe('ai-assistant-service Emberpath routing', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps OpenRouter as the hosted default when Emberpath is not configured', async () => {
    vi.stubEnv('MAGNUS_EMBERPATH_URL', '');
    const profiles = await getModelProfiles();

    expect(profiles.find((profile) => profile.taskType === 'internet_data')).toMatchObject({ provider: 'openrouter' });
    for (const profile of profiles) {
      expect(profile.provider).not.toBe('emberpath');
      expect(profile.fallbacks?.some((fallback) => fallback.provider === 'emberpath')).toBe(false);
    }
  });

  it('routes the hosted defaults through Emberpath first, then OpenRouter, when it is configured', async () => {
    vi.stubEnv('MAGNUS_EMBERPATH_URL', 'https://models.example.com/v1');
    vi.stubEnv('MAGNUS_EMBERPATH_API_KEY', 'ep-test-key');
    vi.stubEnv('MAGNUS_EMBERPATH_MODEL', 'fleet-assistant');
    const profiles = await getModelProfiles();

    const internet = profiles.find((profile) => profile.taskType === 'internet_data')!;
    expect(internet).toMatchObject({ provider: 'emberpath', model: 'fleet-assistant' });
    expect(internet.fallbacks?.[0]?.provider).toBe('openrouter');
    const chat = profiles.find((profile) => profile.taskType === 'chat')!;
    expect(chat.provider).toBe('ollama');
    expect(chat.fallbacks?.slice(0, 2).map((fallback) => fallback.provider)).toEqual(['emberpath', 'openrouter']);
    expect(profiles.find((profile) => profile.taskType === 'summarization')!.fallbacks).toEqual([]);
  });

  it('leaves saved routes as they were saved', async () => {
    vi.stubEnv('MAGNUS_EMBERPATH_URL', 'https://models.example.com/v1');
    vi.stubEnv('MAGNUS_EMBERPATH_API_KEY', 'ep-test-key');
    vi.stubEnv('MAGNUS_EMBERPATH_MODEL', 'fleet-assistant');
    dbMocks.aiMemoryFindUnique.mockResolvedValue({
      content: JSON.stringify([
        { taskType: 'internet_data', provider: 'openrouter', model: 'openai/gpt-4.1-mini', fallbacks: [{ provider: 'openai', model: 'gpt-4.1-mini' }], temperature: 0.2, maxTokens: 4096 },
      ]),
    });

    await expect(selectModel('internet_data')).resolves.toMatchObject({
      provider: 'openrouter',
      fallbacks: [{ provider: 'openai', model: 'gpt-4.1-mini' }],
    });
  });
});

describe('resolveRouteModel', () => {
  it('lets the global settings model override Ollama routes', () => {
    expect(resolveRouteModel({ provider: 'ollama', model: 'gemma4:31b-it-q8_0' }, 'qwen3:32b')).toBe('qwen3:32b');
    expect(resolveRouteModel({ model: 'gemma4:31b-it-q8_0' }, 'qwen3:32b')).toBe('qwen3:32b');
    expect(resolveRouteModel({ provider: 'ollama', model: 'gemma4:31b-it-q8_0' }, '')).toBe('gemma4:31b-it-q8_0');
  });

  it('keeps the route model for providers other than Ollama', () => {
    expect(resolveRouteModel({ provider: 'emberpath', model: 'standard' }, 'qwen3:32b')).toBe('standard');
    expect(resolveRouteModel({ provider: 'openai', model: 'gpt-4.1-mini' }, 'qwen3:32b')).toBe('gpt-4.1-mini');
    expect(resolveRouteModel({ provider: 'llamacpp', model: 'local-gguf' }, 'qwen3:32b')).toBe('local-gguf');
  });

  it('falls back to the settings model only when a non-Ollama route has no model', () => {
    expect(resolveRouteModel({ provider: 'emberpath', model: '' }, 'qwen3:32b')).toBe('qwen3:32b');
  });

  it('resolves a saved emberpath route to its own model', async () => {
    dbMocks.aiMemoryFindUnique.mockResolvedValue({
      content: JSON.stringify([
        { taskType: 'chat', provider: 'emberpath', model: 'standard', fallbacks: [], temperature: 0.3, maxTokens: 2048 },
      ]),
    });

    const profile = await selectModel('chat');
    expect(resolveRouteModel(profile, 'qwen3:32b')).toBe('standard');
    const heartbeat = await selectModel('heartbeat');
    expect(heartbeat.provider).toBe('ollama');
    expect(resolveRouteModel(heartbeat, 'qwen3:32b')).toBe('qwen3:32b');
  });
});

describe('ai-assistant-service loop helpers', () => {
  it('builds stable tool signatures regardless of argument key order', () => {
    const left = getToolCallSignature({
      name: 'getNodeHealth',
      arguments: {
        nodeId: 'node-1',
        filters: {
          includeServices: true,
          includeDisks: false,
        },
      },
    });

    const right = getToolCallSignature({
      name: 'getNodeHealth',
      arguments: {
        filters: {
          includeDisks: false,
          includeServices: true,
        },
        nodeId: 'node-1',
      },
    });

    expect(left).toBe(right);
  });

  it('scores highly similar investigative text as stalled progress', () => {
    const previous = 'Investigating CPU saturation on web-01 after repeated nginx restarts and checking the same process list.';
    const current = 'Investigating CPU saturation on web-01 after repeated nginx restarts and checking the same process list again.';

    expect(getTextSimilarity(previous, current)).toBeGreaterThan(0.9);
    expect(hasStalledForwardProgress(previous, current)).toBe(true);
  });

  it('does not flag clearly different analysis as stalled progress', () => {
    const previous = 'CPU usage points to nginx worker churn on web-01 and likely bad config reload behavior.';
    const current = 'Disk pressure is isolated to db-02 due to log retention and package cache growth.';

    expect(getTextSimilarity(previous, current)).toBeLessThan(0.5);
    expect(hasStalledForwardProgress(previous, current)).toBe(false);
  });
});

describe('pending tool approvals', () => {
  const pending = JSON.stringify({ toolName: 'execCommand', toolArgs: { nodeId: 'node-1', command: 'uptime' }, conversationId: 'stale-copy' });

  beforeEach(() => {
    dbMocks.aiMessageFindUnique.mockReset();
    dbMocks.aiMessageUpdateMany.mockReset();
  });

  it('hands one approval to exactly one of two concurrent decisions', async () => {
    // Both callers read the approval before either clears it; the database lets one clear win.
    dbMocks.aiMessageFindUnique.mockResolvedValue({ conversationId: 'conversation-1', pendingApproval: pending });
    dbMocks.aiMessageUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const [first, second] = await Promise.all([claimPendingApproval('message-1'), claimPendingApproval('message-1')]);

    expect(first).toEqual({ toolName: 'execCommand', toolArgs: { nodeId: 'node-1', command: 'uptime' }, conversationId: 'conversation-1' });
    expect(second).toBeNull();
    expect(dbMocks.aiMessageUpdateMany).toHaveBeenCalledWith({ where: { id: 'message-1', pendingApproval: pending }, data: { pendingApproval: null } });
  });

  it('claims nothing from a message without a readable approval', async () => {
    dbMocks.aiMessageFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ conversationId: 'c', pendingApproval: null })
      .mockResolvedValueOnce({ conversationId: 'c', pendingApproval: '{broken' });
    await expect(claimPendingApproval('missing')).resolves.toBeNull();
    await expect(claimPendingApproval('decided')).resolves.toBeNull();
    await expect(claimPendingApproval('corrupt')).resolves.toBeNull();
    expect(dbMocks.aiMessageUpdateMany).not.toHaveBeenCalled();
  });

  it('names the conversation only while an approval is pending', async () => {
    dbMocks.aiMessageFindUnique.mockResolvedValueOnce({ conversationId: 'conversation-1', pendingApproval: pending })
      .mockResolvedValueOnce({ conversationId: 'conversation-1', pendingApproval: null });
    await expect(getPendingApprovalConversation('message-1')).resolves.toBe('conversation-1');
    await expect(getPendingApprovalConversation('message-1')).resolves.toBeNull();
  });
});
