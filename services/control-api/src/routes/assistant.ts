/**
 * assistant.ts — Routes for the AI Fleet Operations Assistant.
 *
 * POST /assistant/chat                  — Send a message, get AI response
 * POST /assistant/chat/stream           — SSE streaming chat
 * GET  /assistant/conversations         — List conversations (supports status=all)
 * GET  /assistant/conversations/:id     — Get conversation messages
 * GET  /assistant/conversations/:id/export — Export conversation (markdown/json/csv)
 * POST /assistant/conversations/:id/read — Mark conversation as read
 * POST /assistant/conversations/:id/archive — Archive a conversation
 * DELETE /assistant/conversations/:id   — Delete a conversation permanently
 * GET  /assistant/unread                — Get unread message count
 * POST /assistant/messages/read         — Mark specific messages as read
 * POST /assistant/messages/:id/approve  — Approve a pending tool call
 * POST /assistant/messages/:id/reject   — Reject a pending tool call
 * GET  /assistant/heartbeat-prompt      — Get current heartbeat prompt
 * PUT  /assistant/heartbeat-prompt      — Update heartbeat prompt
 * DELETE /assistant/heartbeat-prompt    — Reset heartbeat prompt to default
 * GET  /assistant/insights              — Get AI-generated fleet insights
 * GET  /assistant/model-profiles        — Get model routing profiles
 * PATCH /assistant/model-profiles       — Update model routing profiles
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import {
  chat,
  chatStream,
  listConversations,
  getConversationMessages,
  getUnreadAiMessageCount,
  markAiMessagesRead,
  markConversationRead,
  archiveConversation,
  deleteConversation,
  getHeartbeatPrompt,
  updateHeartbeatPrompt,
  resetHeartbeatPrompt,
  listOllamaModels,
  getModelContextLength,
  getAiSettings,
  updateAiSettings,
  getModelProfiles,
  updateModelProfiles,
  approveToolCall,
  rejectToolCall,
  createConversationShare,
  forkConversation,
  getSharedConversation,
} from '../services/ai-assistant-service.js';
import { executeAiTool } from '../services/ai-tools.js';
import { generateInsights, listPinnedInsights, pinInsight, unpinInsight } from '../services/ai-insights-service.js';
import { exportConversation } from '../services/ai-export-service.js';
import { clearScratchpad, listScratchpadEntries } from '../services/ai-scratchpad-service.js';

export const assistantRouter = new Hono<AppVariables>();

assistantRouter.use('*', authMiddleware);

// ── Send a chat message ──
assistantRouter.post('/chat', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const body = await c.req.json<{
    message: string;
    conversationId?: string;
    nodeId?: string;
    controlNodeName?: string;
    controlNodeId?: string;
    replMode?: boolean;
    thinkingMode?: 'off' | 'standard' | 'deep';
    maxToolRounds?: number;
    attachments?: Array<{ type: 'image'; data: string; mimeType?: string }>;
  }>();

  if (!body.message?.trim()) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'message is required');
  }

  // Build controller context from frontend-provided info
  let controllerContext: string | undefined;
  if (body.controlNodeName) {
    const ctxParts: string[] = [];
    ctxParts.push(`You are the AI assistant for the "${body.controlNodeName}" Control Node (ID: ${body.controlNodeId ?? 'unknown'}). All fleet data you access is from this control node's database. When the user asks about "the fleet" or "nodes", they mean the nodes managed by this control node. Your tools (like getFleetStatus, getNodeHealth, etc.) query this control node's data directly — they do NOT require a fleet ID parameter.`);
    controllerContext = ctxParts.join('\n');
  }

  const user = c.get('user');
  const result = await chat({
    message: body.message,
    conversationId: body.conversationId,
    nodeId: body.nodeId,
    controllerContext,
    type: 'chat',
    createdBy: user?.email ?? user?.userId ?? 'unknown',
    userInfo: user ? { email: user.email, role: user.role, username: user.userId } : undefined,
    replMode: body.replMode,
    thinkingMode: body.thinkingMode,
    maxToolRounds: body.maxToolRounds,
    attachments: body.attachments,
  });

  return c.json({ success: true, data: result });
});

// ── List conversations ──
assistantRouter.get('/conversations', async (c) => {
  const result = await listConversations({
    type: c.req.query('type'),
    status: c.req.query('status') ?? 'active',
    page: parseInt(c.req.query('page') ?? '1', 10),
    pageSize: parseInt(c.req.query('pageSize') ?? '20', 10),
  });
  return c.json({ success: true, data: result });
});

// ── Get conversation messages ──
assistantRouter.get('/conversations/:id', async (c) => {
  const id = c.req.param('id')!;

  const result = await getConversationMessages(id, {
    page: parseInt(c.req.query('page') ?? '1', 10),
    pageSize: parseInt(c.req.query('pageSize') ?? '50', 10),
  });

  if (result.total === 0) {
    // Check if conversation exists
    const { getDb } = await import('../db/index.js');
    const db = getDb();
    const conv = await db.aiConversation.findUnique({ where: { id } });
    if (!conv) throw new HttpError(404, 'NOT_FOUND', 'Conversation not found');
  }

  return c.json({ success: true, data: result });
});

assistantRouter.post('/conversations/:id/fork', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const id = c.req.param('id')!;
  const body = (await c.req.json().catch(() => ({}))) as { fromMessageId?: string };
  const user = c.get('user');

  try {
    const fork = await forkConversation(id, {
      fromMessageId: body.fromMessageId,
      createdBy: user?.email ?? user?.userId ?? 'unknown',
    });
    return c.json({ success: true, data: fork });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      throw new HttpError(404, 'NOT_FOUND', err.message);
    }
    throw err;
  }
});

assistantRouter.post('/conversations/:id/share', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const id = c.req.param('id')!;
  const body = (await c.req.json().catch(() => ({}))) as { ttlHours?: number };
  const user = c.get('user');

  try {
    const share = await createConversationShare(id, user?.email ?? user?.userId ?? 'unknown', {
      ttlHours: body.ttlHours,
    });
    return c.json({ success: true, data: share });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      throw new HttpError(404, 'NOT_FOUND', err.message);
    }
    throw err;
  }
});

assistantRouter.get('/conversations/:id/scratchpad', async (c) => {
  const entries = listScratchpadEntries(c.req.param('id')).map((entry) => ({
    name: entry.name,
    source: entry.source,
    summary: entry.summary,
    value: entry.value,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }));
  return c.json({ success: true, data: { entries } });
});

assistantRouter.delete('/conversations/:id/scratchpad', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  clearScratchpad(c.req.param('id')!);
  return c.json({ success: true });
});

assistantRouter.get('/shares/:token', async (c) => {
  const shared = await getSharedConversation(c.req.param('token'));
  if (!shared) {
    throw new HttpError(404, 'NOT_FOUND', 'Shared conversation not found or expired');
  }
  return c.json({ success: true, data: shared });
});

// ── Mark conversation as read ──
assistantRouter.post('/conversations/:id/read', async (c) => {
  const id = c.req.param('id')!;
  const count = await markConversationRead(id);
  return c.json({ success: true, data: { marked: count } });
});

// ── Archive a conversation ──
assistantRouter.post('/conversations/:id/archive', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const id = c.req.param('id')!;
  try {
    await archiveConversation(id);
    return c.json({ success: true });
  } catch {
    throw new HttpError(404, 'NOT_FOUND', 'Conversation not found');
  }
});

// ── Get unread message count ──
assistantRouter.get('/unread', async (c) => {
  const count = await getUnreadAiMessageCount();
  return c.json({ success: true, data: { unread: count } });
});

// ── Mark specific messages as read ──
assistantRouter.post('/messages/read', async (c) => {
  const body = await c.req.json<{ messageIds: string[] }>();
  if (!body.messageIds?.length) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'messageIds array is required');
  }
  const count = await markAiMessagesRead(body.messageIds);
  return c.json({ success: true, data: { marked: count } });
});

// ── Delete a conversation permanently ──
assistantRouter.delete('/conversations/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const id = c.req.param('id')!;
  try {
    await deleteConversation(id);
    return c.json({ success: true });
  } catch {
    throw new HttpError(404, 'NOT_FOUND', 'Conversation not found');
  }
});

// ── Heartbeat prompt ──

assistantRouter.get('/heartbeat-prompt', async (c) => {
  const result = await getHeartbeatPrompt();
  return c.json({ success: true, data: result });
});

assistantRouter.put('/heartbeat-prompt', requireRole('ADMIN'), async (c) => {
  const body = await c.req.json<{ content: string }>();
  if (!body.content?.trim()) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'content is required');
  }
  await updateHeartbeatPrompt(body.content);
  return c.json({ success: true });
});

assistantRouter.delete('/heartbeat-prompt', requireRole('ADMIN'), async (c) => {
  await resetHeartbeatPrompt();
  return c.json({ success: true });
});

// ── Ollama models ──

assistantRouter.get('/models', async (c) => {
  const models = await listOllamaModels();
  return c.json({ success: true, data: { models } });
});

assistantRouter.get('/models/:name/context', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const contextLength = await getModelContextLength(name);
  return c.json({ success: true, data: { contextLength } });
});

// ── AI settings ──

assistantRouter.get('/settings', async (c) => {
  const settings = await getAiSettings();
  return c.json({ success: true, data: settings });
});

assistantRouter.patch('/settings', requireRole('ADMIN'), async (c) => {
  const body = await c.req.json<{
    model?: string;
    maxContextTokens?: number;
    systemPrompt?: string | null;
    thinkingMode?: 'off' | 'standard' | 'deep';
    showReasoning?: boolean;
    maxToolRounds?: number;
    replEnabled?: boolean;
    structuredOutputsEnabled?: boolean;
  }>();
  await updateAiSettings(body);
  const settings = await getAiSettings();
  return c.json({ success: true, data: settings });
});

// ── Streaming chat (SSE) ──

assistantRouter.post('/chat/stream', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const body = await c.req.json<{
    message: string;
    conversationId?: string;
    nodeId?: string;
    controlNodeName?: string;
    controlNodeId?: string;
    replMode?: boolean;
    thinkingMode?: 'off' | 'standard' | 'deep';
    maxToolRounds?: number;
    attachments?: Array<{ type: 'image'; data: string; mimeType?: string }>;
  }>();

  if (!body.message?.trim()) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'message is required');
  }

  let controllerContext: string | undefined;
  if (body.controlNodeName) {
    const ctxParts: string[] = [];
    ctxParts.push(`You are the AI assistant for the "${body.controlNodeName}" Control Node (ID: ${body.controlNodeId ?? 'unknown'}).`);
    controllerContext = ctxParts.join('\n');
  }

  const user = c.get('user');

  return streamSSE(c, async (stream) => {
    try {
      await chatStream({
        message: body.message,
        conversationId: body.conversationId,
        nodeId: body.nodeId,
        controllerContext,
        type: 'chat',
        createdBy: user?.email ?? user?.userId ?? 'unknown',
        userInfo: user ? { email: user.email, role: user.role, username: user.userId } : undefined,
        replMode: body.replMode,
        thinkingMode: body.thinkingMode,
        maxToolRounds: body.maxToolRounds,
        attachments: body.attachments,
      }, async (event) => {
        await stream.writeSSE({
          event: event.event,
          data: JSON.stringify(event.data),
        });
      });
    } catch (err) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ type: 'error', error: err instanceof Error ? err.message : 'Stream failed' }),
      });
    }
  });
});

// ── Tool call approval/rejection ──

assistantRouter.post('/messages/:id/approve', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const id = c.req.param('id')!;
  const user = c.get('user');
  try {
    const result = await approveToolCall(id, user?.email ?? user?.userId ?? 'unknown');
    return c.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      throw new HttpError(404, 'NOT_FOUND', err.message);
    }
    throw err;
  }
});

assistantRouter.post('/messages/:id/reject', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const id = c.req.param('id')!;
  const user = c.get('user');
  try {
    const result = await rejectToolCall(id, user?.email ?? user?.userId ?? 'unknown');
    return c.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      throw new HttpError(404, 'NOT_FOUND', err.message);
    }
    throw err;
  }
});

// ── Command confirm (natural language command execution) ──

assistantRouter.post('/messages/:id/confirm', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const id = c.req.param('id')!;
  const db = (await import('../db/index.js')).getDb();
  const message = await db.aiMessage.findUnique({ where: { id } });

  if (!message?.pendingApproval) {
    throw new HttpError(404, 'NOT_FOUND', 'No pending command to confirm');
  }

  let approval: { toolName: string; toolArgs: Record<string, unknown>; conversationId: string };
  try {
    approval = JSON.parse(message.pendingApproval);
  } catch {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid pending approval data');
  }

  // Clear the pending approval
  await db.aiMessage.update({
    where: { id },
    data: { pendingApproval: null },
  });

  // If this was a natural command, execute it via execCommand with the preview data
  if (approval.toolName === 'executeNaturalCommand' && approval.toolArgs['_preview']) {
    const preview = approval.toolArgs['_preview'] as {
      command: string;
      args: string[];
      nodeId: string;
      nodeName: string;
    };

    const toolResult = await executeAiTool({
      name: 'execCommand',
      arguments: {
        nodeId: preview.nodeId,
        command: preview.command,
        args: preview.args,
        timeoutSeconds: 60,
      },
    });

    // Continue conversation with the result
    const chatResult = await chat({
      conversationId: approval.conversationId,
      message: `[Command confirmed and executed] \`${preview.command} ${preview.args.join(' ')}\` on ${preview.nodeName}:\n${JSON.stringify(toolResult.result).slice(0, 2000)}`,
      type: 'chat',
      createdBy: 'system',
    });

    return c.json({ success: true, data: chatResult });
  }

  // Fallback: standard approval flow
  const toolResult = await executeAiTool({
    name: approval.toolName,
    arguments: approval.toolArgs,
  });

  const chatResult = await chat({
    conversationId: approval.conversationId,
    message: `[Tool confirmed and executed] ${approval.toolName}: ${JSON.stringify(toolResult.result).slice(0, 2000)}`,
    type: 'chat',
    createdBy: 'system',
  });

  return c.json({ success: true, data: chatResult });
});

// ── Conversation export ──

assistantRouter.get('/conversations/:id/export', async (c) => {
  const id = c.req.param('id');
  const format = (c.req.query('format') ?? 'markdown') as 'markdown' | 'json' | 'csv';

  if (!['markdown', 'json', 'csv'].includes(format)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'format must be markdown, json, or csv');
  }

  try {
    const exported = await exportConversation(id, format);

    if (!exported) {
      throw new HttpError(404, 'NOT_FOUND', 'Conversation not found');
    }

    c.header('Content-Type', exported.contentType);
    c.header('Content-Disposition', `attachment; filename="${exported.filename}"`);
    return c.text(exported.content);
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      throw new HttpError(404, 'NOT_FOUND', err.message);
    }
    throw err;
  }
});

// ── AI Insights ──

assistantRouter.get('/insights', async (c) => {
  const insights = await generateInsights();
  return c.json({ success: true, data: insights });
});

assistantRouter.get('/insights/pins', async (c) => {
  const pins = await listPinnedInsights();
  return c.json({ success: true, data: { pins } });
});

assistantRouter.post('/insights/pins', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const body = await c.req.json<{
    title: string;
    body: string;
    severity: 'critical' | 'warning' | 'info' | 'success';
    category: string;
    nodeId?: string;
    generatedAt?: string;
  }>();

  if (!body.title?.trim() || !body.body?.trim()) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'title and body are required');
  }

  const pin = await pinInsight(body);
  return c.json({ success: true, data: pin });
});

assistantRouter.delete('/insights/pins/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  await unpinInsight(c.req.param('id')!);
  return c.json({ success: true });
});

// ── Model routing profiles ──

assistantRouter.get('/model-profiles', async (c) => {
  const profiles = await getModelProfiles();
  return c.json({ success: true, data: profiles });
});

assistantRouter.patch('/model-profiles', requireRole('ADMIN'), async (c) => {
  const body = await c.req.json<Record<string, {
    provider?: 'ollama' | 'llamacpp' | 'openai' | 'anthropic' | 'openrouter';
    model: string;
    fallbacks?: Array<{
      provider: 'ollama' | 'llamacpp' | 'openai' | 'anthropic' | 'openrouter';
      model: string;
    }>;
    temperature?: number;
    maxTokens?: number;
    maxToolRounds?: number;
    thinkingMode?: 'off' | 'standard' | 'deep';
  }>>();
  const profilesArray = Object.entries(body).map(([taskType, p]) => ({
    taskType,
    provider: p.provider,
    model: p.model,
    fallbacks: Array.isArray(p.fallbacks) ? p.fallbacks : undefined,
    temperature: p.temperature ?? 0.3,
    maxTokens: p.maxTokens ?? 4096,
    maxToolRounds: p.maxToolRounds,
    thinkingMode: p.thinkingMode,
  }));
  await updateModelProfiles(profilesArray);
  const profiles = await getModelProfiles();
  return c.json({ success: true, data: profiles });
});
