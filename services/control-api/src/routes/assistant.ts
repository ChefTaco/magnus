import { optional } from '../utils/optional.js';
import { pagination } from '../utils/query.js';
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

import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { clientErrorMessage } from '../utils/safe-errors.js';
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
  claimPendingApproval,
  getPendingApprovalConversation,
  rejectToolCall,
  createConversationShare,
  forkConversation,
  getSharedConversation,
  conversationOwners,
  getConversationAccess,
  loadToolGate,
  toolCallBlock,
} from '../services/ai-assistant-service.js';
import { executeAiTool } from '../services/ai-tools.js';
import { logAuditEvent } from '../services/audit-service.js';
import { generateInsights, listPinnedInsights, pinInsight, unpinInsight } from '../services/ai-insights-service.js';
import { exportConversation } from '../services/ai-export-service.js';
import { clearScratchpad, listScratchpadEntries } from '../services/ai-scratchpad-service.js';
import { z } from 'zod';
import { parseBody } from '../utils/validate.js';

export const assistantRouter = new Hono<AppVariables>();

assistantRouter.use('*', authMiddleware);

const ownersOf = (c: Context<AppVariables>): string[] => conversationOwners(c.get('user'));

const thinkingModeSchema = z.enum(['off', 'standard', 'deep']);
const providerSchema = z.enum(['ollama', 'llamacpp', 'openai', 'anthropic', 'openrouter', 'emberpath']);
const actorOf = (c: Context<AppVariables>): string => getUser(c).email || getUser(c).userId;

/** POST /chat and /chat/stream. Tool rounds are clamped later (1..AI_MAX_TOOL_ROUNDS). */
const chatSchema = z.object({
  message: z.string().refine((value) => value.trim().length > 0, 'message is required'),
  conversationId: z.string().min(1).max(128).optional(),
  nodeId: z.string().min(1).max(128).optional(),
  controlNodeName: z.string().max(200).optional(),
  controlNodeId: z.string().max(128).optional(),
  replMode: z.boolean().optional(),
  thinkingMode: thinkingModeSchema.optional(),
  maxToolRounds: z.number().int().optional(),
  attachments: z.array(z.object({
    type: z.literal('image'),
    data: z.string().min(1),
    mimeType: z.string().max(100).optional(),
  })).max(10).optional(),
});

type ChatBody = z.infer<typeof chatSchema>;
const attachmentsOf = (body: ChatBody) => body.attachments?.map((attachment) => ({
  type: attachment.type, data: attachment.data, ...optional('mimeType', attachment.mimeType),
}));

const messagesReadSchema = z.object({
  messageIds: z.array(z.string().min(1).max(128), 'messageIds array is required').min(1, 'messageIds array is required').max(500),
});

const heartbeatPromptSchema = z.object({
  content: z.string('content is required').max(100_000).refine((value) => value.trim().length > 0, 'content is required'),
});

/**
 * PATCH /settings. The console sends a partial AiSettings, which may echo the read-only fields
 * (defaultModel, isCustomSystemPrompt, defaultSystemPrompt); unknown fields are dropped, not stored.
 */
const settingsSchema = z.object({
  model: z.string().trim().min(1).max(200).optional(),
  maxContextTokens: z.number().int().min(1).max(10_000_000).optional(),
  systemPrompt: z.string().max(100_000).nullable().optional(),
  thinkingMode: thinkingModeSchema.optional(),
  showReasoning: z.boolean().optional(),
  maxToolRounds: z.number().int().min(1).max(1000).optional(),
  replEnabled: z.boolean().optional(),
  structuredOutputsEnabled: z.boolean().optional(),
});

/** PATCH /model-profiles: routes by task type, as the console's updateModelProfiles() builds them. */
const modelRouteSchema = z.object({
  provider: providerSchema.optional(),
  model: z.string().max(200),
  fallbacks: z.array(z.object({ provider: providerSchema, model: z.string().min(1).max(200) })).max(10).nullish(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(1_000_000).optional(),
  maxToolRounds: z.number().int().min(1).max(1000).optional(),
  thinkingMode: thinkingModeSchema.optional(),
});
const modelProfilesSchema = z.record(z.string().trim().min(1).max(100), modelRouteSchema)
  .refine((routes) => Object.keys(routes).length <= 100, 'At most 100 model routes');

/**
 * A conversation belongs to whoever started it. ADMIN gets no exception, because no
 * console feature reads other people's conversations. Someone else's answers 404,
 * so a caller cannot tell it exists.
 */
async function requireConversation(c: Context<AppVariables>, id: string, level: 'read' | 'own' = 'own'): Promise<'owner' | 'shared'> {
  const access = await getConversationAccess(id, ownersOf(c));
  if (!access || (level === 'own' && access !== 'owner')) throw new HttpError(404, 'NOT_FOUND', 'Conversation not found');
  return access;
}

/**
 * Read state is a single flag on each message, not per user, so marking the shared heartbeat
 * conversation read clears it for everyone. That is an operator's call, like resolving anomalies.
 */
function canClearSharedReadState(c: Context<AppVariables>): boolean {
  const role = getUser(c).role;
  return role === 'ADMIN' || role === 'OPERATOR';
}

// ── Send a chat message ──
assistantRouter.post('/chat', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const body = await parseBody(c, chatSchema);

  // Build controller context from frontend-provided info
  let controllerContext: string | undefined;
  if (body.controlNodeName) {
    const ctxParts: string[] = [];
    ctxParts.push(`You are the AI assistant for the "${body.controlNodeName}" Control Node (ID: ${body.controlNodeId ?? 'unknown'}). All fleet data you access is from this control node's database. When the user asks about "the fleet" or "nodes", they mean the nodes managed by this control node. Your tools (like getFleetStatus, getNodeHealth, etc.) query this control node's data directly — they do NOT require a fleet ID parameter.`);
    controllerContext = ctxParts.join('\n');
  }

  if (body.conversationId) await requireConversation(c, body.conversationId);

  const user = c.get('user');
  const result = await chat({ message: body.message, ...optional("conversationId", body.conversationId), ...optional("nodeId", body.nodeId), ...optional("controllerContext", controllerContext), type: 'chat', createdBy: user?.email ?? user?.userId ?? 'unknown', ...optional("userInfo", user ? { email: user.email, role: user.role, username: user.userId } : undefined), ...optional("replMode", body.replMode), ...optional("thinkingMode", body.thinkingMode), ...optional("maxToolRounds", body.maxToolRounds), ...optional("attachments", attachmentsOf(body)) });

  return c.json({ success: true, data: result });
});

// ── List conversations ──
assistantRouter.get('/conversations', async (c) => {
  const result = await listConversations({ ...optional("type", c.req.query('type')), status: c.req.query('status') ?? 'active', ...pagination(c, { pageSize: 20, maxPageSize: 50 }), owners: ownersOf(c) });
  return c.json({ success: true, data: result });
});

// ── Get conversation messages ──
assistantRouter.get('/conversations/:id', async (c) => {
  const id = c.req.param('id')!;
  await requireConversation(c, id, 'read');

  const result = await getConversationMessages(id, {
    ...pagination(c, { pageSize: 50, maxPageSize: 100 }),
  });

  return c.json({ success: true, data: result });
});

assistantRouter.post('/conversations/:id/fork', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const id = c.req.param('id')!;
  await requireConversation(c, id, 'read');
  const body = (await c.req.json().catch(() => ({}))) as { fromMessageId?: string };
  const user = c.get('user');

  try {
    const fork = await forkConversation(id, { ...optional("fromMessageId", body.fromMessageId), createdBy: user?.email ?? user?.userId ?? 'unknown' });
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
  await requireConversation(c, id);
  const body = (await c.req.json().catch(() => ({}))) as { ttlHours?: number };
  const user = c.get('user');

  try {
    const share = await createConversationShare(id, user?.email ?? user?.userId ?? 'unknown', { ...optional("ttlHours", body.ttlHours) });
    return c.json({ success: true, data: share });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      throw new HttpError(404, 'NOT_FOUND', err.message);
    }
    throw err;
  }
});

assistantRouter.get('/conversations/:id/scratchpad', async (c) => {
  await requireConversation(c, c.req.param('id'), 'read');
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
  await requireConversation(c, c.req.param('id')!);
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
  const access = await requireConversation(c, id, 'read');
  // Read state is one flag per message, shared by everyone; only an operator may clear it on the shared heartbeat.
  if (access === 'shared' && !canClearSharedReadState(c)) {
    throw new HttpError(403, 'FORBIDDEN', 'Requires one of: ADMIN, OPERATOR to mark the shared heartbeat conversation read');
  }
  const count = await markConversationRead(id);
  return c.json({ success: true, data: { marked: count } });
});

// ── Archive a conversation ──
assistantRouter.post('/conversations/:id/archive', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const id = c.req.param('id')!;
  await requireConversation(c, id);
  try {
    await archiveConversation(id);
    return c.json({ success: true });
  } catch {
    throw new HttpError(404, 'NOT_FOUND', 'Conversation not found');
  }
});

// ── Get unread message count ──
assistantRouter.get('/unread', async (c) => {
  const count = await getUnreadAiMessageCount(ownersOf(c));
  return c.json({ success: true, data: { unread: count } });
});

// ── Mark specific messages as read ──
assistantRouter.post('/messages/read', async (c) => {
  const body = await parseBody(c, messagesReadSchema);
  // Read state is one flag per message, shared by everyone; only an operator may clear it on the shared heartbeat.
  const count = await markAiMessagesRead(body.messageIds, ownersOf(c), { includeShared: canClearSharedReadState(c) });
  return c.json({ success: true, data: { marked: count } });
});

// ── Delete a conversation permanently ──
assistantRouter.delete('/conversations/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const id = c.req.param('id')!;
  await requireConversation(c, id);
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
  const body = await parseBody(c, heartbeatPromptSchema);
  await updateHeartbeatPrompt(body.content);
  await logAuditEvent({
    action: 'assistant.heartbeat_prompt.update', actorId: actorOf(c), targetType: 'assistant-setting', targetId: 'heartbeat_prompt',
    details: { length: body.content.length },
  });
  return c.json({ success: true });
});

assistantRouter.delete('/heartbeat-prompt', requireRole('ADMIN'), async (c) => {
  await resetHeartbeatPrompt();
  await logAuditEvent({
    action: 'assistant.heartbeat_prompt.reset', actorId: actorOf(c), targetType: 'assistant-setting', targetId: 'heartbeat_prompt',
  });
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
  const body = await parseBody(c, settingsSchema);
  const changes = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)) as Parameters<typeof updateAiSettings>[0];
  await updateAiSettings(changes);
  await logAuditEvent({
    action: 'assistant.settings.update', actorId: actorOf(c), targetType: 'assistant-setting', targetId: 'ai_settings',
    // The system prompt is free text: record that it changed, not what it says.
    details: {
      changedFields: Object.keys(changes).sort(),
      ...Object.fromEntries(Object.entries(changes).filter(([key]) => key !== 'systemPrompt')),
      ...('systemPrompt' in changes ? { systemPromptCustom: changes.systemPrompt !== null } : {}),
    },
  });
  const settings = await getAiSettings();
  return c.json({ success: true, data: settings });
});

// ── Streaming chat (SSE) ──

assistantRouter.post('/chat/stream', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const body = await parseBody(c, chatSchema);

  let controllerContext: string | undefined;
  if (body.controlNodeName) {
    const ctxParts: string[] = [];
    ctxParts.push(`You are the AI assistant for the "${body.controlNodeName}" Control Node (ID: ${body.controlNodeId ?? 'unknown'}).`);
    controllerContext = ctxParts.join('\n');
  }

  if (body.conversationId) await requireConversation(c, body.conversationId);

  const user = c.get('user');

  return streamSSE(c, async (stream) => {
    try {
      await chatStream({ message: body.message, ...optional("conversationId", body.conversationId), ...optional("nodeId", body.nodeId), ...optional("controllerContext", controllerContext), type: 'chat', createdBy: user?.email ?? user?.userId ?? 'unknown', ...optional("userInfo", user ? { email: user.email, role: user.role, username: user.userId } : undefined), ...optional("replMode", body.replMode), ...optional("thinkingMode", body.thinkingMode), ...optional("maxToolRounds", body.maxToolRounds), ...optional("attachments", attachmentsOf(body)) }, async (event) => {
        await stream.writeSSE({
          event: event.event,
          data: JSON.stringify(event.data),
        });
      });
    } catch (err) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ type: 'error', error: clientErrorMessage(err, 'Stream failed') }),
      });
    }
  });
});

// ── Tool call approval/rejection ──

/**
 * A pending tool call is decided by someone who can read its conversation: the owner, or any
 * operator for the shared fleet heartbeat. Anyone else gets 404, as for the conversation itself.
 * A message with nothing pending is left to the handler, which reports that.
 */
async function requirePendingApprovalAccess(c: Context<AppVariables>, messageId: string): Promise<void> {
  const conversationId = await getPendingApprovalConversation(messageId);
  if (conversationId) await requireConversation(c, conversationId, 'read');
}

assistantRouter.post('/messages/:id/approve', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const id = c.req.param('id')!;
  const user = c.get('user');
  await requirePendingApprovalAccess(c, id);
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
  await requirePendingApprovalAccess(c, id);
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
  const user = c.get('user');
  await requirePendingApprovalAccess(c, id);
  const approval = await claimPendingApproval(id);
  if (!approval) {
    throw new HttpError(404, 'NOT_FOUND', 'No pending command to confirm');
  }

  await logAuditEvent({
    action: 'assistant.tool_approval',
    actorId: user?.email ?? user?.userId ?? 'unknown',
    actorType: 'user',
    targetType: 'ai_message',
    targetId: id,
    details: { toolName: approval.toolName, conversationId: approval.conversationId, decision: 'confirmed' },
  });

  // The tool may have been disabled or denied since it went pending. A natural command runs as
  // execCommand, so both names must still be allowed. Same rule as POST /messages/:id/approve.
  const gate = await loadToolGate();
  const natural = approval.toolName === 'executeNaturalCommand' && approval.toolArgs['_preview'];
  const blockedBy = [approval.toolName, ...(natural ? ['execCommand'] : [])]
    .map((name) => ({ name, block: toolCallBlock(name, gate) }))
    .find(({ block }) => block === 'disabled' || block === 'denied');
  if (blockedBy) {
    const chatResult = await chat({
      conversationId: approval.conversationId,
      message: `[Tool not run] The tool "${blockedBy.name}" is ${blockedBy.block === 'disabled' ? 'disabled' : 'denied by policy'} and was not executed.`,
      type: 'chat',
      createdBy: 'system',
    });
    return c.json({ success: true, data: chatResult });
  }

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
    }, { actorId: getUser(c).userId, conversationId: approval.conversationId });

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
  }, { actorId: getUser(c).userId, conversationId: approval.conversationId });

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
  await requireConversation(c, id, 'read');
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
  const body = await parseBody(c, z.object({
    title: z.string().trim().min(1, 'title is required').max(500),
    body: z.string().trim().min(1, 'body is required').max(20_000),
    severity: z.enum(['critical', 'warning', 'info', 'success']),
    category: z.string().min(1).max(100),
    nodeId: z.string().min(1).max(128).optional(),
    generatedAt: z.iso.datetime({ offset: true }).optional(),
  }));

  const pin = await pinInsight({
    title: body.title, body: body.body, severity: body.severity, category: body.category,
    ...optional('nodeId', body.nodeId), ...optional('generatedAt', body.generatedAt),
  });
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
  const body = await parseBody(c, modelProfilesSchema);
  const profilesArray = Object.entries(body).map(([taskType, p]) => ({
    taskType,
    ...optional("provider", p.provider),
    model: p.model,
    ...optional("fallbacks", p.fallbacks ?? undefined),
    temperature: p.temperature ?? 0.3,
    maxTokens: p.maxTokens ?? 4096,
    ...optional("maxToolRounds", p.maxToolRounds),
    ...optional("thinkingMode", p.thinkingMode),
  }));
  await updateModelProfiles(profilesArray);
  await logAuditEvent({
    action: 'assistant.model_profiles.update', actorId: actorOf(c), targetType: 'assistant-setting', targetId: 'ai_model_routes',
    details: { routes: profilesArray.map((p) => ({ taskType: p.taskType, provider: p.provider ?? 'ollama', model: p.model })) },
  });
  const profiles = await getModelProfiles();
  return c.json({ success: true, data: profiles });
});
