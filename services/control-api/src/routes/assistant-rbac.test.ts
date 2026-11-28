import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppVariables } from '../types/index.js';
import { HttpError, errorHandler } from '../middleware/error-handler.js';

const { approveToolCall, rejectToolCall, claimPendingApproval, getPendingApprovalConversation, getConversationAccess, executeAiTool, chat, loadToolGate, toolCallBlock } = vi.hoisted(() => ({
  approveToolCall: vi.fn(), rejectToolCall: vi.fn(), claimPendingApproval: vi.fn(), getPendingApprovalConversation: vi.fn(),
  getConversationAccess: vi.fn(), executeAiTool: vi.fn(), chat: vi.fn(), loadToolGate: vi.fn(), toolCallBlock: vi.fn(),
}));
const svc = vi.hoisted(() => ({
  chatStream: vi.fn(), markAiMessagesRead: vi.fn(), markConversationRead: vi.fn(), updateHeartbeatPrompt: vi.fn(), resetHeartbeatPrompt: vi.fn(),
  getAiSettings: vi.fn(), updateAiSettings: vi.fn(), getModelProfiles: vi.fn(), updateModelProfiles: vi.fn(), logAuditEvent: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({
  getUser: (c: { get(key: string): unknown }) => c.get('user'),
  authMiddleware: async (c: { req: { header(name: string): string | undefined }; set(key: string, value: unknown): void }, next: () => Promise<void>) => {
    c.set('user', {
      userId: 'test-user',
      email: 'test@example.test',
      role: c.req.header('x-test-role') ?? 'VIEWER',
      iat: 0,
      exp: 4_102_444_800,
    });
    await next();
  },
  requireRole: (...roles: string[]) => async (c: { get(key: string): { role: string } }, next: () => Promise<void>) => {
    if (!roles.includes(c.get('user').role)) {
      throw new HttpError(403, 'FORBIDDEN', 'Insufficient role');
    }
    await next();
  },
}));

vi.mock('../services/ai-assistant-service.js', () => ({
  chat,
  loadToolGate,
  toolCallBlock,
  chatStream: svc.chatStream,
  listConversations: vi.fn(),
  getConversationMessages: vi.fn(),
  getUnreadAiMessageCount: vi.fn(),
  markAiMessagesRead: svc.markAiMessagesRead,
  markConversationRead: svc.markConversationRead,
  archiveConversation: vi.fn(),
  deleteConversation: vi.fn(),
  getHeartbeatPrompt: vi.fn(),
  updateHeartbeatPrompt: svc.updateHeartbeatPrompt,
  resetHeartbeatPrompt: svc.resetHeartbeatPrompt,
  listOllamaModels: vi.fn(),
  getModelContextLength: vi.fn(),
  getAiSettings: svc.getAiSettings,
  updateAiSettings: svc.updateAiSettings,
  getModelProfiles: svc.getModelProfiles,
  updateModelProfiles: svc.updateModelProfiles,
  approveToolCall,
  rejectToolCall,
  claimPendingApproval,
  getPendingApprovalConversation,
  createConversationShare: vi.fn(),
  forkConversation: vi.fn(),
  getSharedConversation: vi.fn(),
  conversationOwners: vi.fn(() => ['test-user']),
  getConversationAccess,
}));
vi.mock('../services/audit-service.js', () => ({ logAuditEvent: svc.logAuditEvent }));
vi.mock('../services/ai-tools.js', () => ({ executeAiTool }));
vi.mock('../services/ai-insights-service.js', () => ({
  generateInsights: vi.fn(),
  listPinnedInsights: vi.fn(),
  pinInsight: vi.fn(),
  unpinInsight: vi.fn(),
}));
vi.mock('../services/ai-export-service.js', () => ({ exportConversation: vi.fn() }));
vi.mock('../services/ai-scratchpad-service.js', () => ({
  clearScratchpad: vi.fn(),
  listScratchpadEntries: vi.fn(() => []),
}));

const { assistantRouter } = await import('./assistant.js');

function createApp(): Hono<AppVariables> {
  const app = new Hono<AppVariables>();
  app.onError(errorHandler);
  app.route('/assistant', assistantRouter);
  return app;
}

describe('assistant route authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConversationAccess.mockResolvedValue('owner');
    getPendingApprovalConversation.mockResolvedValue(null);
  });

  it.each([
    ['POST', '/assistant/chat'],
    ['POST', '/assistant/chat/stream'],
    ['POST', '/assistant/conversations/conversation-1/fork'],
    ['POST', '/assistant/conversations/conversation-1/share'],
    ['DELETE', '/assistant/conversations/conversation-1/scratchpad'],
    ['POST', '/assistant/conversations/conversation-1/archive'],
    ['DELETE', '/assistant/conversations/conversation-1'],
    ['POST', '/assistant/messages/message-1/approve'],
    ['POST', '/assistant/messages/message-1/reject'],
    ['POST', '/assistant/messages/message-1/confirm'],
    ['POST', '/assistant/insights/pins'],
    ['DELETE', '/assistant/insights/pins/pin-1'],
  ])('denies VIEWER access to operational mutation %s %s', async (method, path) => {
    const response = await createApp().request(path, { method });
    expect(response.status).toBe(403);
  });

  it.each([
    ['PUT', '/assistant/heartbeat-prompt'],
    ['DELETE', '/assistant/heartbeat-prompt'],
    ['PATCH', '/assistant/settings'],
    ['PATCH', '/assistant/model-profiles'],
  ])('reserves global configuration mutation for ADMIN on %s %s', async (method, path) => {
    const response = await createApp().request(path, {
      method,
      headers: { 'x-test-role': 'OPERATOR' },
    });
    expect(response.status).toBe(403);
  });

  it('allows an OPERATOR through the approval boundary', async () => {
    approveToolCall.mockResolvedValue({ conversationId: 'conversation-1' });
    const response = await createApp().request('/assistant/messages/message-1/approve', {
      method: 'POST',
      headers: { 'x-test-role': 'OPERATOR' },
    });

    expect(response.status).toBe(200);
    expect(approveToolCall).toHaveBeenCalledWith('message-1', 'test@example.test');
  });

  it.each(['approve', 'reject', 'confirm'])('hides a pending tool call in someone else\'s conversation from %s', async (decision) => {
    getPendingApprovalConversation.mockResolvedValue('conversation-of-another-user');
    getConversationAccess.mockResolvedValue(null);
    const response = await createApp().request(`/assistant/messages/message-1/${decision}`, {
      method: 'POST',
      headers: { 'x-test-role': 'OPERATOR' },
    });

    expect(response.status).toBe(404);
    expect(getConversationAccess).toHaveBeenCalledWith('conversation-of-another-user', ['test-user']);
    expect(approveToolCall).not.toHaveBeenCalled();
    expect(rejectToolCall).not.toHaveBeenCalled();
    expect(claimPendingApproval).not.toHaveBeenCalled();
    expect(executeAiTool).not.toHaveBeenCalled();
  });

  it('lets any operator decide a pending tool call in the shared heartbeat conversation', async () => {
    getPendingApprovalConversation.mockResolvedValue('heartbeat-conversation');
    getConversationAccess.mockResolvedValue('shared');
    approveToolCall.mockResolvedValue({ conversationId: 'heartbeat-conversation' });
    const response = await createApp().request('/assistant/messages/message-1/approve', {
      method: 'POST',
      headers: { 'x-test-role': 'OPERATOR' },
    });

    expect(response.status).toBe(200);
    expect(approveToolCall).toHaveBeenCalledOnce();
  });

  it('answers 404 without running anything when a confirmation was already taken', async () => {
    getPendingApprovalConversation.mockResolvedValue('conversation-1');
    claimPendingApproval.mockResolvedValue(null);
    const response = await createApp().request('/assistant/messages/message-1/confirm', {
      method: 'POST',
      headers: { 'x-test-role': 'OPERATOR' },
    });

    expect(response.status).toBe(404);
    expect(executeAiTool).not.toHaveBeenCalled();
  });
});

describe('confirming a pending tool call', () => {
  const confirm = () => createApp().request('/assistant/messages/message-1/confirm', { method: 'POST', headers: { 'x-test-role': 'OPERATOR' } });
  const natural = { toolName: 'executeNaturalCommand', conversationId: 'conversation-1',
    toolArgs: { _preview: { command: 'systemctl', args: ['restart', 'nginx'], nodeId: 'node-1', nodeName: 'web1' } } };

  beforeEach(() => {
    vi.clearAllMocks();
    getConversationAccess.mockResolvedValue('owner');
    getPendingApprovalConversation.mockResolvedValue('conversation-1');
    loadToolGate.mockResolvedValue({});
    toolCallBlock.mockReturnValue(null);
    chat.mockResolvedValue({ conversationId: 'conversation-1' });
    executeAiTool.mockResolvedValue({ name: 'execCommand', success: true, result: {} });
  });

  it.each(['disabled', 'denied'])('does not run a natural command whose execCommand became %s', async (block) => {
    claimPendingApproval.mockResolvedValue(natural);
    toolCallBlock.mockImplementation((name: string) => (name === 'execCommand' ? block : null));
    expect((await confirm()).status).toBe(200);
    expect(executeAiTool).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('[Tool not run]') }));
  });

  it.each(['disabled', 'denied'])('does not run a standard tool that became %s', async (block) => {
    claimPendingApproval.mockResolvedValue({ toolName: 'writeFile', toolArgs: { path: 'x' }, conversationId: 'conversation-1' });
    toolCallBlock.mockImplementation((name: string) => (name === 'writeFile' ? block : null));
    expect((await confirm()).status).toBe(200);
    expect(executeAiTool).not.toHaveBeenCalled();
  });

  it('runs a confirmed natural command that is still allowed, as the confirming user', async () => {
    claimPendingApproval.mockResolvedValue(natural);
    expect((await confirm()).status).toBe(200);
    expect(executeAiTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'execCommand' }), expect.objectContaining({ actorId: 'test-user' }));
  });
});

const json = (role: string, method: string, body: unknown) => ({
  method, headers: { 'x-test-role': role, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});

describe('assistant request bodies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConversationAccess.mockResolvedValue('owner');
    chat.mockResolvedValue({ conversationId: 'c-1', messageId: 'm-1', content: 'ok', toolCalls: [], tokenCount: 1 });
    svc.getAiSettings.mockResolvedValue({ model: 'llama3' });
    svc.getModelProfiles.mockResolvedValue([]);
    svc.markAiMessagesRead.mockResolvedValue(1);
    svc.markConversationRead.mockResolvedValue(2);
  });

  it.each([
    ['ADMIN', 'POST', '/assistant/chat'],
    ['ADMIN', 'POST', '/assistant/chat/stream'],
    ['VIEWER', 'POST', '/assistant/messages/read'],
    ['ADMIN', 'PATCH', '/assistant/settings'],
    ['ADMIN', 'PATCH', '/assistant/model-profiles'],
    ['ADMIN', 'PUT', '/assistant/heartbeat-prompt'],
  ])('answers invalid JSON with 400 VALIDATION_ERROR (%s %s %s)', async (role, method, path) => {
    const response = await createApp().request(path, json(role, method, '{not json'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' } });
  });

  it('answers a heartbeat prompt that is not a string with 400, and stores nothing', async () => {
    for (const content of [42, null, ['a'], '   ']) {
      const response = await createApp().request('/assistant/heartbeat-prompt', json('ADMIN', 'PUT', { content }));
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    }
    expect(svc.updateHeartbeatPrompt).not.toHaveBeenCalled();
    expect(svc.logAuditEvent).not.toHaveBeenCalled();
  });

  it('validates chat fields before anything runs', async () => {
    for (const body of [{ message: '  ' }, { message: 'hi', thinkingMode: 'max' }, { message: 'hi', attachments: [{ type: 'pdf', data: 'x' }] }]) {
      expect((await createApp().request('/assistant/chat', json('OPERATOR', 'POST', body))).status).toBe(400);
    }
    expect(chat).not.toHaveBeenCalled();
    expect((await createApp().request('/assistant/chat', json('OPERATOR', 'POST', { message: 'hi', thinkingMode: 'deep' }))).status).toBe(200);
  });

  it('validates settings, drops the read-only fields the console echoes, and audits the change', async () => {
    for (const body of [{ maxToolRounds: 'ten' }, { thinkingMode: 'max' }, { maxContextTokens: -1 }, { showReasoning: 'yes' }, []]) {
      expect((await createApp().request('/assistant/settings', json('ADMIN', 'PATCH', body))).status).toBe(400);
    }
    expect(svc.updateAiSettings).not.toHaveBeenCalled();

    const response = await createApp().request('/assistant/settings', json('ADMIN', 'PATCH', {
      model: 'llama3', maxToolRounds: 8, systemPrompt: 'Be brief.', defaultModel: 'x', isCustomSystemPrompt: true, defaultSystemPrompt: 'y', injected: 1,
    }));
    expect(response.status).toBe(200);
    expect(svc.updateAiSettings).toHaveBeenCalledWith({ model: 'llama3', maxToolRounds: 8, systemPrompt: 'Be brief.' });
    expect(svc.logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'assistant.settings.update', actorId: 'test@example.test',
      details: { changedFields: ['maxToolRounds', 'model', 'systemPrompt'], model: 'llama3', maxToolRounds: 8, systemPromptCustom: true } }));
  });

  it('validates model routes as the console sends them and audits the change', async () => {
    for (const body of [{ chat: { provider: 'mystery', model: 'm' } }, { chat: { model: 7 } }, { chat: { model: 'm', temperature: 9 } }, ['chat']]) {
      expect((await createApp().request('/assistant/model-profiles', json('ADMIN', 'PATCH', body))).status).toBe(400);
    }
    expect(svc.updateModelProfiles).not.toHaveBeenCalled();

    // The console's updateModelProfiles() leaves out undefined fields.
    const response = await createApp().request('/assistant/model-profiles', json('ADMIN', 'PATCH', {
      chat: { provider: 'ollama', model: 'llama3', fallbacks: [{ provider: 'openai', model: 'gpt-x' }], temperature: 0.2, maxTokens: 2048, maxToolRounds: 5, thinkingMode: 'standard' },
      notes: { model: 'llama3' },
    }));
    expect(response.status).toBe(200);
    expect(svc.updateModelProfiles).toHaveBeenCalledWith([
      { taskType: 'chat', provider: 'ollama', model: 'llama3', fallbacks: [{ provider: 'openai', model: 'gpt-x' }], temperature: 0.2, maxTokens: 2048, maxToolRounds: 5, thinkingMode: 'standard' },
      { taskType: 'notes', model: 'llama3', temperature: 0.3, maxTokens: 4096 },
    ]);
    expect(svc.logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'assistant.model_profiles.update',
      details: { routes: [{ taskType: 'chat', provider: 'ollama', model: 'llama3' }, { taskType: 'notes', provider: 'ollama', model: 'llama3' }] } }));
  });

  it('audits heartbeat prompt changes without the prompt text', async () => {
    expect((await createApp().request('/assistant/heartbeat-prompt', json('ADMIN', 'PUT', { content: 'Watch the disks.' }))).status).toBe(200);
    expect(svc.updateHeartbeatPrompt).toHaveBeenCalledWith('Watch the disks.');
    expect(svc.logAuditEvent).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'assistant.heartbeat_prompt.update', details: { length: 16 } }));
    expect((await createApp().request('/assistant/heartbeat-prompt', { method: 'DELETE', headers: { 'x-test-role': 'ADMIN' } })).status).toBe(200);
    expect(svc.logAuditEvent).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'assistant.heartbeat_prompt.reset', targetId: 'heartbeat_prompt' }));
  });
});

describe('read state of the shared heartbeat conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.markAiMessagesRead.mockResolvedValue(1);
    svc.markConversationRead.mockResolvedValue(2);
  });

  it('lets a VIEWER read it but not mark it read for everyone', async () => {
    getConversationAccess.mockResolvedValue('shared');
    const response = await createApp().request('/assistant/conversations/heartbeat-1/read', { method: 'POST', headers: { 'x-test-role': 'VIEWER' } });
    expect(response.status).toBe(403);
    expect(svc.markConversationRead).not.toHaveBeenCalled();
  });

  it.each(['OPERATOR', 'ADMIN'])('lets an %s mark it read', async (role) => {
    getConversationAccess.mockResolvedValue('shared');
    const response = await createApp().request('/assistant/conversations/heartbeat-1/read', { method: 'POST', headers: { 'x-test-role': role } });
    expect(response.status).toBe(200);
    expect(svc.markConversationRead).toHaveBeenCalledWith('heartbeat-1');
  });

  it('keeps marking the caller\'s own conversation read open to every role', async () => {
    getConversationAccess.mockResolvedValue('owner');
    expect((await createApp().request('/assistant/conversations/mine-1/read', { method: 'POST' })).status).toBe(200);
  });

  it.each([['VIEWER', false], ['OPERATOR', true], ['ADMIN', true]] as const)('marks messages read with includeShared for %s: %s', async (role, includeShared) => {
    const response = await createApp().request('/assistant/messages/read', json(role, 'POST', { messageIds: ['m-1', 'm-2'] }));
    expect(response.status).toBe(200);
    expect(svc.markAiMessagesRead).toHaveBeenCalledWith(['m-1', 'm-2'], ['test-user'], { includeShared });
  });
});
