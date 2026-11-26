import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppVariables } from '../types/index.js';
import { HttpError, errorHandler } from '../middleware/error-handler.js';

const { approveToolCall, rejectToolCall, claimPendingApproval, getPendingApprovalConversation, getConversationAccess, executeAiTool, chat, loadToolGate, toolCallBlock } = vi.hoisted(() => ({
  approveToolCall: vi.fn(), rejectToolCall: vi.fn(), claimPendingApproval: vi.fn(), getPendingApprovalConversation: vi.fn(),
  getConversationAccess: vi.fn(), executeAiTool: vi.fn(), chat: vi.fn(), loadToolGate: vi.fn(), toolCallBlock: vi.fn(),
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
  chatStream: vi.fn(),
  listConversations: vi.fn(),
  getConversationMessages: vi.fn(),
  getUnreadAiMessageCount: vi.fn(),
  markAiMessagesRead: vi.fn(),
  markConversationRead: vi.fn(),
  archiveConversation: vi.fn(),
  deleteConversation: vi.fn(),
  getHeartbeatPrompt: vi.fn(),
  updateHeartbeatPrompt: vi.fn(),
  resetHeartbeatPrompt: vi.fn(),
  listOllamaModels: vi.fn(),
  getModelContextLength: vi.fn(),
  getAiSettings: vi.fn(),
  updateAiSettings: vi.fn(),
  getModelProfiles: vi.fn(),
  updateModelProfiles: vi.fn(),
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
vi.mock('../services/audit-service.js', () => ({ logAuditEvent: vi.fn() }));
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
