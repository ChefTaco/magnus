import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  memory: new Map<string, string>(),
  aiMessageCreate: vi.fn(),
  aiConversationUpdate: vi.fn(),
  aiMessageFindUnique: vi.fn(),
  aiMessageUpdateMany: vi.fn(),
  executeAiTool: vi.fn(),
  providerChat: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getDb: () => ({
    aiMemory: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const content = mocks.memory.get(where.key);
        return content === undefined ? null : { key: where.key, content };
      },
      findMany: async () => [],
    },
    aiMessage: {
      findMany: async () => [],
      create: mocks.aiMessageCreate,
      count: async () => 2,
      findUnique: mocks.aiMessageFindUnique,
      updateMany: mocks.aiMessageUpdateMany,
    },
    aiConversation: { update: mocks.aiConversationUpdate },
    node: { findMany: async () => [] },
    anomalyEvent: { count: async () => 0, findMany: async () => [] },
  }),
}));

vi.mock('./ai-tools.js', () => ({
  executeAiTool: mocks.executeAiTool,
  listAvailableTools: () => ['execCommand', 'getFleetStatus', 'readFile'],
}));

vi.mock('./hivemem-client.js', () => ({ getHiveMemClient: () => ({ configured: false }) }));
vi.mock('./audit-service.js', () => ({ logAuditEvent: vi.fn() }));

vi.mock('./llm-providers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./llm-providers/index.js')>();
  return {
    ...actual,
    getLlmProvider: () => ({
      id: 'ollama',
      name: 'Ollama',
      isConfigured: () => true,
      supportsToolCalling: true,
      supportsStructuredOutputs: false,
      supportsStreaming: false,
      chat: mocks.providerChat,
    }),
  };
});

import { approveToolCall, chat, executeToolCalls, resolveToolApprovalPolicy, type ToolGate } from './ai-assistant-service.js';

function llmReply(content: string, nativeToolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = []) {
  return { providerId: 'ollama', providerName: 'Ollama', model: 'test', content, thinking: '', evalCount: 10, nativeToolCalls, usedStructuredOutput: false };
}

beforeEach(() => {
  mocks.memory.clear();
  mocks.aiMessageCreate.mockReset();
  mocks.aiConversationUpdate.mockReset();
  mocks.executeAiTool.mockReset();
  mocks.executeAiTool.mockImplementation(async (call: { name: string }) => ({ name: call.name, success: true, result: { ok: true } }));
  mocks.providerChat.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in tests'); }));
});

describe('resolveToolApprovalPolicy', () => {
  it('keeps dangerous tools behind approval when a stored policy leaves them out or allows them', () => {
    const policy = resolveToolApprovalPolicy({ alwaysAllow: ['execCommand', 'getFleetStatus'], requireApproval: [], alwaysDeny: [] });
    expect(policy.requireApproval).toEqual(expect.arrayContaining(['execCommand', 'writeFile', 'runSkill', 'createSkillDraft', 'generateRunbook']));
    expect(policy.alwaysAllow).toEqual(['getFleetStatus']);
  });

  it('uses the defaults for lists the stored policy omits and for values that do not parse', () => {
    expect(resolveToolApprovalPolicy({ alwaysDeny: ['readFile'] })).toMatchObject({ alwaysDeny: ['readFile'] });
    expect(resolveToolApprovalPolicy({ alwaysDeny: ['readFile'] }).requireApproval).toContain('forgetMemory');
    expect(resolveToolApprovalPolicy({ alwaysDeny: ['readFile'] }).alwaysAllow).not.toContain('readFile');
    expect(resolveToolApprovalPolicy({ requireApproval: 'execCommand' }).requireApproval).toContain('forgetMemory');
    expect(resolveToolApprovalPolicy(null).requireApproval).toContain('execCommand');
  });

  it('lets a stored policy deny a dangerous tool', () => {
    const policy = resolveToolApprovalPolicy({ alwaysDeny: ['execCommand'] });
    expect(policy.alwaysDeny).toEqual(['execCommand']);
    expect(policy.requireApproval).not.toContain('execCommand');
  });
});

describe('executeToolCalls', () => {
  const gate: ToolGate = {
    policy: resolveToolApprovalPolicy({ alwaysDeny: ['readFile'] }),
    disabled: new Set(['getFleetStatus']),
  };

  it('refuses disabled and denied tools and stops before a tool that needs approval', async () => {
    const outcome = await executeToolCalls([
      { name: 'getFleetStatus', arguments: {} },
      { name: 'readFile', arguments: {} },
      { name: 'getNodeHealth', arguments: {} },
      { name: 'execCommand', arguments: { command: 'id' } },
      { name: 'getNodeLogs', arguments: {} },
    ], gate);

    expect(outcome.results.map((r) => [r.name, r.success, r.error])).toEqual([
      ['getFleetStatus', false, 'Tool is disabled'],
      ['readFile', false, 'Tool is denied by policy'],
      ['getNodeHealth', true, undefined],
    ]);
    expect(outcome.pendingApproval).toEqual({ name: 'execCommand', arguments: { command: 'id' } });
    expect(mocks.executeAiTool.mock.calls.map(([call]) => (call as { name: string }).name)).toEqual(['getNodeHealth']);
  });
});

describe('chat() tool gating', () => {
  it('saves a native execCommand call as a pending approval instead of running it', async () => {
    mocks.providerChat.mockResolvedValueOnce(llmReply('', [{ name: 'execCommand', arguments: { nodeId: 'node-1', command: 'id' } }]));

    const response = await chat({ conversationId: 'conversation-1', message: 'check the node', createdBy: 'alice@example.com' });

    expect(mocks.executeAiTool).not.toHaveBeenCalled();
    expect(response.pendingApproval).toEqual({ toolName: 'execCommand' });
    const saved = mocks.aiMessageCreate.mock.calls.map(([arg]) => (arg as { data: { role: string; pendingApproval?: string } }).data)
      .find((data) => data.role === 'assistant');
    expect(saved?.pendingApproval).toBeDefined();
    expect(JSON.parse(saved!.pendingApproval!)).toMatchObject({ toolName: 'execCommand', toolArgs: { nodeId: 'node-1', command: 'id' }, conversationId: 'conversation-1' });
    expect(JSON.parse(saved!.pendingApproval!).toolArgs).not.toHaveProperty('_conversationId');
    expect(response.messageId).toBe((mocks.aiMessageCreate.mock.calls.at(-1)?.[0] as { data: { id: string } }).data.id);
  });

  it('keeps execCommand behind approval even when the stored policy allows it', async () => {
    mocks.memory.set('tool_approval_policy', JSON.stringify({ alwaysAllow: ['execCommand'], requireApproval: [], alwaysDeny: [] }));
    mocks.providerChat.mockResolvedValueOnce(llmReply('', [{ name: 'execCommand', arguments: { command: 'id' } }]));

    const response = await chat({ conversationId: 'conversation-1', message: 'run id' });

    expect(mocks.executeAiTool).not.toHaveBeenCalled();
    expect(response.pendingApproval).toEqual({ toolName: 'execCommand' });
  });

  it('does not run a disabled tool written as text', async () => {
    mocks.memory.set('tool_config', JSON.stringify([{ name: 'execCommand', enabled: false }]));
    mocks.memory.set('tool_approval_policy', JSON.stringify({ alwaysDeny: [] }));
    mocks.providerChat
      .mockResolvedValueOnce(llmReply('```json\n{"name": "execCommand", "arguments": {"command": "id"}}\n```'))
      .mockResolvedValueOnce(llmReply('That tool is not available.'));

    const response = await chat({ conversationId: 'conversation-1', message: 'run id' });

    expect(mocks.executeAiTool).not.toHaveBeenCalled();
    expect(response.pendingApproval).toBeUndefined();
    expect(response.toolCalls).toEqual([{ name: 'execCommand', success: false, result: null, error: 'Tool is disabled' }]);
    expect(response.content).toBe('That tool is not available.');
  });

  it('still runs allowed read-only tools', async () => {
    mocks.providerChat
      .mockResolvedValueOnce(llmReply('', [{ name: 'getFleetStatus', arguments: {} }]))
      .mockResolvedValueOnce(llmReply('All nodes are online.'));

    const response = await chat({ conversationId: 'conversation-1', message: 'fleet status?' });

    expect(mocks.executeAiTool).toHaveBeenCalledTimes(1);
    expect(response.pendingApproval).toBeUndefined();
    expect(response.content).toBe('All nodes are online.');
  });
});

describe('AI request bounds', () => {
  it('keeps tool rounds and share lifetimes in range', async () => {
    const { clampToolRounds, clampShareTtlHours } = await import('./ai-assistant-service.js');
    expect(clampToolRounds(0)).toBe(1);
    expect(clampToolRounds(5)).toBe(5);
    expect(clampToolRounds(1e9)).toBe(100);
    expect(clampToolRounds(Number.NaN)).toBe(100);
    expect(clampShareTtlHours(undefined)).toBe(72);
    expect(clampShareTtlHours(1e9)).toBe(720);
    expect(clampShareTtlHours(-5)).toBe(1);
  });
});

describe('approving a tool that changed state while it waited', () => {
  beforeEach(() => {
    mocks.aiMessageFindUnique.mockResolvedValue({ conversationId: 'conversation-1',
      pendingApproval: JSON.stringify({ toolName: 'execCommand', toolArgs: { nodeId: 'node-1', command: 'id' }, conversationId: 'conversation-1' }) });
    mocks.aiMessageUpdateMany.mockResolvedValue({ count: 1 });
    mocks.aiMessageCreate.mockResolvedValue({ id: 'message-2' });
    mocks.providerChat.mockResolvedValue(llmReply('noted'));
  });

  it('does not run a tool disabled after it went pending', async () => {
    mocks.memory.set('tool_config', JSON.stringify([{ name: 'execCommand', enabled: false }]));
    await approveToolCall('message-1', 'alice@example.com');
    expect(mocks.executeAiTool).not.toHaveBeenCalled();
  });

  it('does not run a tool denied after it went pending', async () => {
    mocks.memory.set('tool_approval_policy', JSON.stringify({ alwaysDeny: ['execCommand'] }));
    await approveToolCall('message-1', 'alice@example.com');
    expect(mocks.executeAiTool).not.toHaveBeenCalled();
  });

  it('runs a tool that is still allowed, as the approving user', async () => {
    await approveToolCall('message-1', 'alice@example.com');
    expect(mocks.executeAiTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'execCommand' }), expect.objectContaining({ actorId: 'alice@example.com' }));
  });
});
