import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppVariables } from '../types/index.js';
import { HttpError, errorHandler } from '../middleware/error-handler.js';

const { approveToolCall } = vi.hoisted(() => ({ approveToolCall: vi.fn() }));

vi.mock('../middleware/auth.js', () => ({
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
  chat: vi.fn(),
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
  rejectToolCall: vi.fn(),
  createConversationShare: vi.fn(),
  forkConversation: vi.fn(),
  getSharedConversation: vi.fn(),
}));
vi.mock('../services/ai-tools.js', () => ({ executeAiTool: vi.fn() }));
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
  beforeEach(() => vi.clearAllMocks());

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
});
