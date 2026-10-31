import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  aiMemoryFindUnique: vi.fn(),
  aiMemoryUpdate: vi.fn(),
  aiMemoryCreate: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getDb: () => ({
    aiMemory: {
      findUnique: dbMocks.aiMemoryFindUnique,
      update: dbMocks.aiMemoryUpdate,
      create: dbMocks.aiMemoryCreate,
    },
  }),
}));

import { getModelProfiles, getToolCallSignature, getTextSimilarity, hasStalledForwardProgress, selectModel, updateModelProfiles } from './ai-assistant-service.js';

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
