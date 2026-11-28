/**
 * AI assistant configuration (heartbeat prompt, settings, models, model routes), fleet insights,
 * the read-only MCP endpoint and scheduled AI operations.
 */
import {
  type JsonSchema, type Paths, browserOperation, body, err400, err401, err403, err404, inlineBody, pp, qp, success, userAuth,
} from '../helpers.js';

const TAGS = ['Assistant'];
const SCHEDULE_TAGS = ['AI Schedules'];
const ADMIN_ONLY = 'Roles: ADMIN.';
const WRITE_ROLES = 'Roles: ADMIN, OPERATOR.';
const ANY_ROLE = 'Any role.';

const thinkingMode = { type: 'string', enum: ['off', 'standard', 'deep'] };
const providerId = { type: 'string', enum: ['ollama', 'llamacpp', 'openai', 'anthropic', 'openrouter', 'emberpath'] };

const heartbeatPrompt: JsonSchema = {
  type: 'object', required: ['content', 'isCustom'],
  properties: {
    content: { type: 'string', description: 'The stored override, or the built-in HEARTBEAT.md text' },
    isCustom: { type: 'boolean', description: 'True when an override is stored' },
  },
};

const settingsFields: Record<string, JsonSchema> = {
  model: { type: 'string', minLength: 1, maxLength: 200, description: 'Ollama model name' },
  maxContextTokens: { type: 'integer', minimum: 1, maximum: 10_000_000 },
  systemPrompt: { type: ['string', 'null'], maxLength: 100_000, description: 'null restores the built-in system prompt' },
  thinkingMode,
  showReasoning: { type: 'boolean' },
  maxToolRounds: { type: 'integer', minimum: 1, maximum: 1000 },
  replEnabled: { type: 'boolean' },
  structuredOutputsEnabled: { type: 'boolean' },
};
const aiSettings: JsonSchema = {
  type: 'object',
  properties: {
    ...settingsFields,
    model: { type: 'string', description: 'The saved model while Ollama lists it; otherwise the default model (also when Ollama is unreachable)' },
    systemPrompt: { type: ['string', 'null'] },
    defaultModel: { type: 'string', description: 'OLLAMA_MODEL' },
    isCustomSystemPrompt: { type: 'boolean' },
    defaultSystemPrompt: { type: 'string' },
  },
  required: ['model', 'defaultModel', 'maxContextTokens', 'systemPrompt', 'isCustomSystemPrompt', 'defaultSystemPrompt', 'thinkingMode',
    'showReasoning', 'maxToolRounds', 'replEnabled', 'structuredOutputsEnabled'],
};

const fallback = { type: 'object', required: ['provider', 'model'], properties: { provider: providerId, model: { type: 'string', minLength: 1, maxLength: 200 } } };
const modelProfile: JsonSchema = {
  type: 'object', required: ['taskType', 'provider', 'model', 'fallbacks', 'temperature', 'maxTokens', 'routePurpose', 'routeReason', 'routeSource'],
  properties: {
    taskType: { type: 'string', description: 'Built in: chat, heartbeat, summarization, code_generation, analysis, dangerous, internet_data, hard; any other name is a custom route' },
    provider: providerId,
    model: { type: 'string' },
    fallbacks: { type: 'array', items: fallback },
    temperature: { type: 'number' },
    maxTokens: { type: 'integer' },
    maxToolRounds: { type: 'integer' },
    thinkingMode,
    systemPromptSuffix: { type: 'string' },
    routePurpose: { type: 'string' },
    routeReason: { type: 'string' },
    routeSource: { type: 'string', enum: ['built-in', 'saved', 'custom'] },
  },
};
const modelProfilePatch: JsonSchema = {
  type: 'object',
  description: 'Routes by task type (keys of 1-100 characters, at most 100 routes). The body replaces every saved route: a built-in task type left out returns to its default, and a custom one left out is removed.',
  maxProperties: 100,
  additionalProperties: {
    type: 'object', required: ['model'],
    properties: {
      provider: providerId,
      model: { type: 'string', maxLength: 200 },
      fallbacks: { type: ['array', 'null'], items: fallback, maxItems: 10, description: 'When absent or null the task type\'s default fallbacks apply' },
      temperature: { type: 'number', minimum: 0, maximum: 2, default: 0.3 },
      maxTokens: { type: 'integer', minimum: 1, maximum: 1_000_000, default: 4096 },
      maxToolRounds: { type: 'integer', minimum: 1, maximum: 1000 },
      thinkingMode,
    },
  },
};

const ollamaModel = {
  type: 'object', required: ['name', 'size', 'parameterSize', 'family', 'quantizationLevel'],
  properties: {
    name: { type: 'string' }, size: { type: 'integer', description: 'Bytes' },
    parameterSize: { type: 'string' }, family: { type: 'string' }, quantizationLevel: { type: 'string' },
  },
};

// ── MCP ──
const mcpTool = { type: 'object', required: ['name', 'description'], properties: { name: { type: 'string' }, description: { type: 'string' } } };
const mcpToolNames = ['magnus_dependency_health', 'magnus_fleet_readiness', 'magnus_fleet_timeline', 'magnus_retention_summary', 'magnus_codex_fleet_status'];

// ── AI schedules ──
const cronExpr = {
  type: 'string', minLength: 5, maxLength: 100,
  description: 'Five-field cron expression (minute hour day-of-month month day-of-week) using numbers, *, ranges, steps and lists',
};
const scheduledOp: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    cronExpr: { type: 'string' },
    enabled: { type: 'boolean' },
    type: { type: 'string', enum: ['chat', 'analysis', 'runbook'] },
    prompt: { type: 'string' },
    nodeId: { type: ['string', 'null'] },
    createdBy: { type: 'string', description: 'Email or user id of the creator' },
    lastRunAt: { type: ['string', 'null'], format: 'date-time' },
    nextRunAt: { type: ['string', 'null'], format: 'date-time' },
    runCount: { type: 'integer' },
    lastResult: { type: ['string', 'null'], description: 'First 2,000 characters of the last answer' },
    lastError: { type: ['string', 'null'], description: 'Last failure, or why a run stopped at a tool that needs approval' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};
const scheduleData = (description: string, status = 200) => ({ [status]: body(description, { type: 'object', required: ['data'], properties: { data: scheduledOp } }) });
const scheduleId = pp('id', 'Scheduled operation ID');

export const paths: Paths = {
  // ──────────────── Heartbeat prompt ────────────────
  '/assistant/heartbeat-prompt': {
    get: {
      tags: TAGS, summary: 'Read the heartbeat analysis prompt', description: `The stored override, or the built-in prompt. ${ANY_ROLE}`, security: userAuth,
      responses: { 200: success('Heartbeat prompt', heartbeatPrompt), 401: err401 },
    },
    put: {
      tags: TAGS, summary: 'Replace the heartbeat analysis prompt',
      description: `Stores an override used by later heartbeat analyses. Audited as \`assistant.heartbeat_prompt.update\` with the prompt's length, not its text. ${ADMIN_ONLY}`, security: userAuth,
      requestBody: inlineBody({ type: 'object', required: ['content'], properties: { content: { type: 'string', minLength: 1, maxLength: 100_000, description: 'Must contain more than whitespace' } } }),
      responses: { 200: success('Stored'), 400: { ...err400, description: 'Not JSON, or `content` missing, not a string or only whitespace' }, 401: err401, 403: err403 },
    },
    delete: {
      tags: TAGS, summary: 'Restore the built-in heartbeat analysis prompt',
      description: `Removes the override; succeeds when there is none. Audited as \`assistant.heartbeat_prompt.reset\`. ${ADMIN_ONLY}`, security: userAuth,
      responses: { 200: success('Override removed'), 401: err401, 403: err403 },
    },
  },

  // ──────────────── Settings and models ────────────────
  '/assistant/settings': {
    get: {
      tags: TAGS, summary: 'Read the assistant settings', description: `Saved values merged over the defaults. ${ANY_ROLE}`, security: userAuth,
      responses: { 200: success('Assistant settings', aiSettings), 401: err401 },
    },
    patch: {
      tags: TAGS, summary: 'Change the assistant settings',
      description: 'Send only the fields to change; they are merged into the saved settings. Other members (such as the read-only `defaultModel`, '
        + '`isCustomSystemPrompt` and `defaultSystemPrompt` a client may echo back) are ignored and not stored. Audited as `assistant.settings.update` '
        + 'with the changed field names and values, except the system prompt text. ' + ADMIN_ONLY,
      security: userAuth,
      requestBody: inlineBody({ type: 'object', properties: settingsFields }),
      responses: { 200: success('Settings after the change', aiSettings), 400: err400, 401: err401, 403: err403 },
    },
  },
  '/assistant/models': {
    get: {
      tags: TAGS, summary: 'List the models the configured Ollama server offers', description: `Asks Ollama (\`/api/tags\`, 5 s timeout). ${ANY_ROLE}`, security: userAuth,
      responses: {
        200: success('Ollama models', { type: 'object', required: ['models'], properties: { models: { type: 'array', items: ollamaModel } } }),
        401: err401, 500: { description: 'Ollama is unreachable or answered an error' },
      },
    },
  },
  '/assistant/models/{name}/context': {
    get: {
      tags: TAGS, summary: 'Read the context length of an Ollama model', description: `From Ollama \`/api/show\`. null when Ollama does not answer or reports none. ${ANY_ROLE}`, security: userAuth,
      parameters: [pp('name', 'Model name, URL-encoded (for example `llama3%3A8b`)')],
      responses: { 200: success('Context length', { type: 'object', required: ['contextLength'], properties: { contextLength: { type: ['integer', 'null'] } } }), 401: err401 },
    },
  },
  '/assistant/model-profiles': {
    get: {
      tags: TAGS, summary: 'List the model routes by task type', description: `Built-in routes with any saved changes, plus custom routes. ${ANY_ROLE}`, security: userAuth,
      responses: { 200: success('Model routes', { type: 'array', items: modelProfile }), 401: err401 },
    },
    patch: {
      tags: TAGS, summary: 'Replace the saved model routes',
      description: 'Audited as `assistant.model_profiles.update` with each route\'s task type, provider and model. ' + ADMIN_ONLY, security: userAuth,
      requestBody: inlineBody(modelProfilePatch),
      responses: { 200: success('Model routes after the change', { type: 'array', items: modelProfile }), 400: err400, 401: err401, 403: err403 },
    },
  },

  // ──────────────── Fleet insights ────────────────
  '/assistant/insights': {
    get: browserOperation('GET', '/assistant/insights', { tags: TAGS, summary: 'Fleet insights from the latest heartbeat analysis' }),
  },
  '/assistant/insights/pins': {
    get: browserOperation('GET', '/assistant/insights/pins', { tags: TAGS, summary: 'List pinned insights' }),
    post: browserOperation('POST', '/assistant/insights/pins', { tags: TAGS, summary: 'Pin an insight', errors: { 400: err400 } }),
  },
  '/assistant/insights/pins/{id}': {
    delete: browserOperation('DELETE', '/assistant/insights/pins/{id}', {
      tags: TAGS, summary: 'Unpin an insight', description: 'Succeeds when no pin has this ID.', params: { id: 'Pin ID' },
    }),
  },

  // ──────────────── MCP (read-only) ────────────────
  '/mcp': {
    get: {
      tags: ['MCP'], summary: 'Describe the read-only MCP-compatible tool endpoint',
      description: `Server name, version and the tool list. The body has no \`success\` envelope. ${ANY_ROLE}`, security: userAuth,
      responses: {
        200: body('Server description', {
          type: 'object', required: ['name', 'version', 'description', 'tools'],
          properties: { name: { type: 'string', enum: ['magnus-readonly'] }, version: { type: 'string' }, description: { type: 'string' }, tools: { type: 'array', items: mcpTool } },
        }),
        401: err401,
      },
    },
    post: {
      tags: ['MCP'], summary: 'Call an MCP method: tools/list or tools/call',
      description: 'A JSON-RPC style request; `jsonrpc`, `id` and other members are accepted and ignored, and the answer is not a JSON-RPC envelope. '
        + 'Every tool only reads: dependency health, fleet readiness (without secret fingerprints), the fleet timeline (`arguments.limit`, default 80), '
        + `retention counts and the cached Codex posture. ${ANY_ROLE}`,
      security: userAuth,
      requestBody: inlineBody({
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['tools/list', 'tools/call'] },
          params: {
            type: ['object', 'null'],
            properties: { name: { type: 'string', enum: mcpToolNames }, arguments: { type: ['object', 'null'], additionalProperties: true } },
          },
        },
      }),
      responses: {
        200: body('`{ tools }` for tools/list; `{ content: [{ type: "json", json }] }` for tools/call', {
          oneOf: [
            { type: 'object', required: ['tools'], properties: { tools: { type: 'array', items: mcpTool } } },
            { type: 'object', required: ['content'], properties: { content: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['json'] }, json: {} } } } } },
          ],
        }),
        400: { ...err400, description: 'Invalid body (`VALIDATION_ERROR`), or a method other than tools/list and tools/call (`UNSUPPORTED_METHOD`)' },
        401: err401,
        404: { ...err404, description: 'Unknown tool (`UNKNOWN_TOOL`)' },
      },
    },
  },

  // ──────────────── Scheduled AI operations ────────────────
  '/ai-schedules': {
    get: {
      tags: SCHEDULE_TAGS, summary: 'List scheduled AI operations', description: `Newest first. The body has no \`success\` member. ${ANY_ROLE}`, security: userAuth,
      parameters: [qp('page', 'Page number (from 1; default 1)', { type: 'integer' }), qp('limit', 'Items per page (1-100, default 20; clamped)', { type: 'integer' })],
      responses: {
        200: body('Scheduled operations', {
          type: 'object', required: ['data', 'pagination'],
          properties: {
            data: { type: 'array', items: scheduledOp },
            pagination: { type: 'object', properties: { page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' }, totalPages: { type: 'integer' } } },
          },
        }),
        401: err401,
      },
    },
    post: {
      tags: SCHEDULE_TAGS, summary: 'Create a scheduled AI operation',
      description: `The next run is computed from \`cronExpr\`; runs happen only while MAGNUS_AI_SCHEDULER_ENABLED=true or through \`POST /ai-schedules/execute-due\`. Audited as \`ai_schedule.create\` (without the prompt). ${WRITE_ROLES}`,
      security: userAuth,
      requestBody: inlineBody({
        type: 'object', required: ['name', 'cronExpr', 'prompt'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          description: { type: 'string', maxLength: 500 },
          cronExpr,
          type: { type: 'string', enum: ['chat', 'analysis', 'runbook'], default: 'chat' },
          prompt: { type: 'string', minLength: 1, maxLength: 5000 },
          nodeId: { type: 'string', description: 'Scope the operation to one node' },
        },
      }),
      responses: { ...scheduleData('Created operation', 201), 400: err400, 401: err401, 403: err403 },
    },
  },
  '/ai-schedules/{id}': {
    get: {
      tags: SCHEDULE_TAGS, summary: 'Get a scheduled AI operation', description: ANY_ROLE, security: userAuth, parameters: [scheduleId],
      responses: { ...scheduleData('Scheduled operation'), 401: err401, 404: err404 },
    },
    patch: {
      tags: SCHEDULE_TAGS, summary: 'Update a scheduled AI operation',
      description: `Send only the fields to change; a new \`cronExpr\` recomputes the next run. \`type\` cannot change. Audited as \`ai_schedule.update\` with the changed field names (and \`enabled\`, \`cronExpr\` and \`nodeId\` values, never the prompt). ${WRITE_ROLES}`, security: userAuth,
      parameters: [scheduleId],
      requestBody: inlineBody({
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          description: { type: 'string', maxLength: 500 },
          cronExpr,
          prompt: { type: 'string', minLength: 1, maxLength: 5000 },
          enabled: { type: 'boolean' },
          nodeId: { type: ['string', 'null'], description: 'null removes the node scope' },
        },
      }),
      responses: { ...scheduleData('Updated operation'), 400: err400, 401: err401, 403: err403, 404: err404 },
    },
    delete: {
      tags: SCHEDULE_TAGS, summary: 'Delete a scheduled AI operation', description: `Audited as \`ai_schedule.delete\`. ${WRITE_ROLES}`, security: userAuth, parameters: [scheduleId],
      responses: { 200: success('Deleted'), 401: err401, 403: err403, 404: err404 },
    },
  },
  '/ai-schedules/execute-due': {
    post: {
      tags: SCHEDULE_TAGS, summary: 'Run the scheduled AI operations that are due now',
      description: 'Runs up to 10 enabled operations whose next run has passed, oldest first. Each occurrence is claimed first, so the scheduler, this route and '
        + 'other servers run it once; a failed run waits for its next turn. A run stops at any tool that needs approval and is not counted. '
        + 'Every run, here or from the scheduler, is audited as `ai_schedule.run` with its outcome (completed, stopped or failed); from this route the caller is the actor, from the scheduler `ai-scheduler`. '
        + `Works whether or not MAGNUS_AI_SCHEDULER_ENABLED is set. ${ADMIN_ONLY}`,
      security: userAuth,
      responses: { 200: success('Operations that completed', { type: 'object', required: ['executed'], properties: { executed: { type: 'integer' } } }), 401: err401, 403: err403 },
    },
  },
};
