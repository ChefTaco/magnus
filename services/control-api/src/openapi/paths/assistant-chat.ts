/**
 * Fleet assistant conversations, chat, tool-call decisions and share links
 * (`routes/assistant.ts`, `services/ai-assistant-service.ts`).
 */
import {
  type JsonSchema, type Paths, browserOperation, err400, err401, err403, err404, errorResponse, eventStream, inlineBody, optionalBody, pp, qp, success, userAuth,
} from '../helpers.js';

const TAGS = ['Assistant'];
const err413 = errorResponse('Request body larger than API_BODY_LIMIT_BYTES (default 1 MiB)');
const WRITE = 'Roles: ADMIN, OPERATOR.';
const OWN = 'Only the conversation\'s owner (the user who started it); any other conversation answers 404, so a caller cannot tell it exists. ADMIN has no exception.';
const READ = 'The owner, or any caller for the server\'s shared heartbeat conversation (`createdBy: system`, `type: heartbeat`); any other conversation answers 404.';
const conversationId = pp('id', 'Conversation ID');
const messageId = pp('id', 'Assistant message ID');

const isoDate = { type: 'string', format: 'date-time' };
const toolResult: JsonSchema = { type: 'object', required: ['name', 'success', 'result'], properties: {
  name: { type: 'string' }, success: { type: 'boolean' }, result: {}, error: { type: 'string' } } };
const chatResponse: JsonSchema = { type: 'object', required: ['conversationId', 'messageId', 'content', 'toolCalls', 'tokenCount'], properties: {
  conversationId: { type: 'string' },
  messageId: { type: 'string', description: 'The assistant message; it holds `pendingApproval` when a tool call waits for a decision' },
  content: { type: 'string' },
  toolCalls: { type: 'array', items: toolResult },
  tokenCount: { type: 'integer' },
  thinking: { type: 'string' },
  structuredAnalysis: {},
  pendingApproval: { type: 'object', properties: { toolName: { type: 'string' } }, description: 'Set when a tool call is waiting for approval' },
} };
const chatRequest: JsonSchema = { type: 'object', required: ['message'], properties: {
  message: { type: 'string', minLength: 1, description: 'Must contain non-whitespace text' },
  conversationId: { type: 'string', description: 'Continue this conversation; it must be the caller\'s own (404 otherwise). Omitted: a new conversation is created for the caller.' },
  nodeId: { type: 'string', description: 'Node the new conversation is about' },
  controlNodeName: { type: 'string', description: 'Display name of the control node, added to the system prompt' },
  controlNodeId: { type: 'string' },
  replMode: { type: 'boolean' },
  thinkingMode: { type: 'string', enum: ['off', 'standard', 'deep'] },
  maxToolRounds: { type: 'integer', description: 'Clamped to 1..AI_MAX_TOOL_ROUNDS (default 100); default from the AI settings or the chat model profile' },
  attachments: { type: 'array', items: { type: 'object', required: ['type', 'data'], properties: {
    type: { type: 'string', enum: ['image'] }, data: { type: 'string', description: 'Base64 image data' }, mimeType: { type: 'string' } } } },
} };
const message: JsonSchema = { type: 'object', properties: {
  id: { type: 'string' }, conversationId: { type: 'string' }, role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
  content: { type: 'string' }, toolCalls: { type: 'array', items: toolResult }, thinking: { type: 'string' }, structuredAnalysis: {},
  tokenCount: { type: 'integer' }, isRead: { type: 'boolean' }, readAt: { ...isoDate, nullable: true },
  pendingApproval: { type: 'object', nullable: true, description: 'Tool call awaiting a decision: toolName, toolArgs and conversationId' },
  createdAt: isoDate,
} };
const marked = success('Messages marked read', { type: 'object', properties: { marked: { type: 'integer' } } });
const decision = (verb: string) => success(`${verb}; the conversation continued. \`data\` is null when the message holds no pending tool call (already decided or never pending).`,
  { ...chatResponse, nullable: true });

export const paths: Paths = {
  '/assistant/chat': {
    post: { tags: TAGS, summary: 'Send a message to the fleet assistant and wait for its answer',
      description: `${WRITE} Runs tool calls in the same request; a tool that needs approval leaves \`pendingApproval\` on the answer. Fails with 500 when no model provider answers.`,
      security: userAuth, requestBody: inlineBody(chatRequest),
      responses: { 200: success('Assistant answer', chatResponse), 400: err400, 401: err401, 403: err403, 404: err404, 413: err413 } },
  },
  '/assistant/chat/stream': {
    post: { tags: TAGS, summary: 'Send a message to the fleet assistant and stream its answer',
      description: `${WRITE} Same body and conversation rule as \`POST /assistant/chat\`; validation and ownership fail before the stream opens. ` +
        'Events (JSON data): `thinking` {round, status}, `thinking_token` {text, round}, `tool_start` {name, round}, `tool_result` {name, success, result}, ' +
        '`scratchpad_update` {entries}, `token` {text}, `done` {conversationId, messageId, tokenCount} and `error`. A provider failure inside the stream is an ' +
        '`error` event with {message}; a failure of the stream itself is an `error` event with {type: "error", error}.',
      security: userAuth, requestBody: inlineBody(chatRequest),
      responses: { 200: eventStream('Server-sent events'), 400: err400, 401: err401, 403: err403, 404: err404, 413: err413 } },
  },
  '/assistant/conversations': {
    get: browserOperation('GET', '/assistant/conversations', { tags: TAGS, summary: 'List the caller\'s conversations',
      description: 'Newest first. `status` defaults to `active`; `all` removes the filter. `pageSize` defaults to 20.',
      queryDescriptions: { type: 'chat, heartbeat or analysis', status: 'active (default), archived, or all', page: 'Page number (from 1)', pageSize: 'Items per page (1-50, default 20)' } }),
  },
  '/assistant/conversations/{id}': {
    get: { tags: TAGS, summary: 'Read a conversation\'s messages', description: `Any role. ${READ} Oldest first.`, security: userAuth,
      parameters: [conversationId, qp('page', 'Page number (from 1)', { type: 'integer' }), qp('pageSize', 'Items per page (1-100, default 50; clamped)', { type: 'integer' })],
      responses: { 200: success('Messages', { type: 'object', properties: { messages: { type: 'array', items: message }, total: { type: 'integer' } } }), 401: err401, 404: err404 } },
    delete: { tags: TAGS, summary: 'Delete a conversation and its messages', description: `${WRITE} ${OWN}`, security: userAuth, parameters: [conversationId],
      responses: { 200: success('Deleted'), 401: err401, 403: err403, 404: err404 } },
  },
  '/assistant/conversations/{id}/export': {
    get: { tags: TAGS, summary: 'Export a conversation as an attachment', description: `Any role. ${READ}`, security: userAuth,
      parameters: [conversationId, qp('format', 'Output format (default markdown)', { enum: ['markdown', 'json', 'csv'] })],
      responses: { 200: { description: 'Conversation file (Content-Disposition: attachment)', content: {
        'text/markdown': { schema: { type: 'string' } }, 'application/json': { schema: { type: 'object' } }, 'text/csv': { schema: { type: 'string' } } } },
      400: err400, 401: err401, 404: err404 } },
  },
  '/assistant/conversations/{id}/fork': {
    post: { tags: TAGS, summary: 'Branch a conversation into a new one owned by the caller',
      description: `${WRITE} ${READ} Copies the messages up to and including \`fromMessageId\` (default: all) into a conversation titled "<title> — Branch N".`,
      security: userAuth, parameters: [conversationId],
      requestBody: optionalBody({ type: 'object', properties: { fromMessageId: { type: 'string', description: 'Last message to copy; unknown answers 404' } } }),
      responses: { 200: success('New conversation', { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' },
        parentId: { type: 'string', nullable: true }, forkedFromMessageId: { type: 'string', nullable: true } } }), 401: err401, 403: err403, 404: err404 } },
  },
  '/assistant/conversations/{id}/share': {
    post: { tags: TAGS, summary: 'Create a read-only share link for a conversation',
      description: `${WRITE} ${OWN} Anyone signed in who holds the token can read the conversation through \`GET /assistant/shares/{token}\` until it expires.`,
      security: userAuth, parameters: [conversationId],
      requestBody: optionalBody({ type: 'object', properties: { ttlHours: { type: 'number', description: 'Lifetime in hours (1-720, default 72; clamped)' } } }),
      responses: { 200: success('Share token', { type: 'object', properties: { token: { type: 'string' }, expiresAt: isoDate } }), 401: err401, 403: err403, 404: err404 } },
  },
  '/assistant/conversations/{id}/scratchpad': {
    get: { tags: TAGS, summary: 'Read a conversation\'s scratchpad entries', description: `Any role. ${READ} The scratchpad lives in the server process memory, so a restart empties it.`,
      security: userAuth, parameters: [conversationId],
      responses: { 200: success('Scratchpad', { type: 'object', properties: { entries: { type: 'array', items: { type: 'object', properties: {
        name: { type: 'string' }, source: { type: 'string' }, summary: { type: 'string' }, value: {}, createdAt: isoDate, updatedAt: isoDate } } } } }),
      401: err401, 404: err404 } },
    delete: { tags: TAGS, summary: 'Clear a conversation\'s scratchpad', description: `${WRITE} ${OWN}`, security: userAuth, parameters: [conversationId],
      responses: { 200: success('Cleared'), 401: err401, 403: err403, 404: err404 } },
  },
  '/assistant/conversations/{id}/read': {
    post: { tags: TAGS, summary: 'Mark a conversation\'s assistant messages read', description: `Any role. ${READ}`, security: userAuth, parameters: [conversationId],
      responses: { 200: marked, 401: err401, 404: err404 } },
  },
  '/assistant/conversations/{id}/archive': {
    post: { tags: TAGS, summary: 'Archive a conversation', description: `${WRITE} ${OWN} Sets its status to \`archived\`.`, security: userAuth, parameters: [conversationId],
      responses: { 200: success('Archived'), 401: err401, 403: err403, 404: err404 } },
  },
  '/assistant/shares/{token}': {
    get: { tags: TAGS, summary: 'Read a shared conversation', description: 'Any role; the token is the only check, not ownership. Tool results are redacted. An expired token is deleted and answers 404.',
      security: userAuth, parameters: [pp('token', 'Share token')],
      responses: { 200: success('Shared conversation', { type: 'object', properties: {
        token: { type: 'string' }, expiresAt: isoDate,
        conversation: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, type: { type: 'string' }, createdAt: isoDate, updatedAt: isoDate,
          parentId: { type: 'string', nullable: true }, forkedFromMessageId: { type: 'string', nullable: true }, messageCount: { type: 'integer' }, childCount: { type: 'integer' } } },
        messages: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, role: { type: 'string' }, content: { type: 'string' },
          toolCalls: { type: 'array', items: toolResult }, thinking: { type: 'string', nullable: true }, structuredAnalysis: { nullable: true }, createdAt: isoDate } } },
      } }), 401: err401, 404: err404 } },
  },
  '/assistant/unread': {
    get: { tags: TAGS, summary: 'Count unread assistant messages', description: 'Any role. Counts the caller\'s own conversations and the shared heartbeat conversation.',
      security: userAuth, responses: { 200: success('Unread count', { type: 'object', properties: { unread: { type: 'integer' } } }), 401: err401 } },
  },
  '/assistant/messages/read': {
    post: { tags: TAGS, summary: 'Mark assistant messages read', description: 'Any role. Only messages in conversations the caller can read are changed; others are ignored.',
      security: userAuth, requestBody: inlineBody({ type: 'object', required: ['messageIds'], properties: { messageIds: { type: 'array', minItems: 1, items: { type: 'string' } } } }),
      responses: { 200: marked, 400: err400, 401: err401 } },
  },
  '/assistant/messages/{id}/approve': {
    post: { tags: TAGS, summary: 'Approve a pending tool call and run it',
      description: `${WRITE} Allowed for whoever can read the message's conversation (${READ.charAt(0).toLowerCase()}${READ.slice(1)}) The approval is claimed atomically, so the tool runs once. ` +
        'A tool disabled or denied since it went pending is not run; the conversation says so. Audited as `assistant.tool_approval`.',
      security: userAuth, parameters: [messageId], responses: { 200: decision('Approved'), 401: err401, 403: err403, 404: err404 } },
  },
  '/assistant/messages/{id}/reject': {
    post: { tags: TAGS, summary: 'Reject a pending tool call', description: `${WRITE} Same access rule as approve. The assistant is told the tool was denied. Audited as \`assistant.tool_approval\`.`,
      security: userAuth, parameters: [messageId], responses: { 200: decision('Rejected'), 401: err401, 403: err403, 404: err404 } },
  },
  '/assistant/messages/{id}/confirm': {
    post: { tags: TAGS, summary: 'Confirm a pending command or tool call and run it',
      description: `${WRITE} Same access rule as approve. A pending \`executeNaturalCommand\` runs its previewed command through \`execCommand\` (60 s timeout); any other tool runs as approved. ` +
        'Either tool disabled or denied since it went pending is not run. Audited as `assistant.tool_approval`.',
      security: userAuth, parameters: [messageId],
      responses: { 200: success('Confirmed; the conversation continued', chatResponse), 401: err401, 403: err403, 404: { ...err404, description: 'No pending command to confirm, or the conversation is not readable' } } },
  },
};
