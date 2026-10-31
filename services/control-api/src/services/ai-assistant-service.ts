/**
 * ai-assistant-service.ts — AI Fleet Operations Assistant powered by Ollama.
 *
 * Connects to an Ollama instance (`OLLAMA_URL`, default `http://127.0.0.1:11434`)
 * using `OLLAMA_MODEL`. Provides fleet-aware AI analysis with tool calling,
 * memory persistence, and heartbeat-driven proactive monitoring.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { executeAiTool, listAvailableTools, type AiToolCall, type AiToolResult } from './ai-tools.js';
import { logAuditEvent } from './audit-service.js';
import { autoStoreToolResult, listScratchpadEntries } from './ai-scratchpad-service.js';
import { getLlmProvider, getLlmProviderStatuses, type LlmChatResult, type LlmMessage, type LlmToolDefinition, type ProviderFallback, type ProviderId, type ThinkingMode } from './llm-providers/index.js';
import { getOllamaThinkingCapability } from './llm-providers/ollama.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Configuration ──

const OLLAMA_BASE_URL = process.env['OLLAMA_URL'] ?? 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env['OLLAMA_MODEL'] ?? 'gemma4:31b-it-q8_0';
const OPENAI_MODEL = process.env['OPENAI_MODEL'] ?? 'gpt-4.1-mini';
const OPENROUTER_MODEL = process.env['OPENROUTER_MODEL'] ?? 'openai/gpt-4.1-mini';
const ANTHROPIC_MODEL = process.env['ANTHROPIC_MODEL'] ?? 'claude-3-5-haiku-latest';
const AI_TEMPERATURE = Number(process.env['AI_TEMPERATURE'] ?? '0.3');
const AI_MAX_TOKENS = Number(process.env['AI_MAX_TOKENS'] ?? '4096');
const AI_MAX_CONTEXT_TOKENS = Number(process.env['AI_MAX_CONTEXT_TOKENS'] ?? '100000');
const DEFAULT_MAX_TOOL_ROUNDS = Number(process.env['AI_MAX_TOOL_ROUNDS'] ?? '100');

export type { ThinkingMode } from './llm-providers/types.js';

// ── Model Routing ──

export interface ModelProfile {
  taskType: string;
  provider?: ProviderId;
  model: string;
  fallbacks?: ProviderFallback[];
  temperature: number;
  maxTokens: number;
  maxToolRounds?: number;
  thinkingMode?: ThinkingMode;
  systemPromptSuffix?: string;
  routePurpose?: string;
  routeReason?: string;
  routeSource?: 'built-in' | 'saved' | 'custom';
}

interface ModelRouteDefinition {
  purpose: string;
  reason: string;
}

const MODEL_ROUTE_DEFINITIONS: Record<string, ModelRouteDefinition> = {
  chat: {
    purpose: 'Interactive Governor chat and general user requests.',
    reason: 'Selected when the assistant request type is chat, or when an unknown task type needs the safest general fallback.',
  },
  heartbeat: {
    purpose: 'Automated fleet heartbeat analysis and proactive health summaries.',
    reason: 'Selected by the scheduled AI heartbeat flow so periodic monitoring can use lower temperature and fewer tool rounds.',
  },
  summarization: {
    purpose: 'Conversation compaction and short memory summaries.',
    reason: 'Selected by conversation summarization code paths; tools and long reasoning are intentionally minimized.',
  },
  code_generation: {
    purpose: 'Code-writing, config generation, and implementation-heavy tasks.',
    reason: 'Selected by callers that explicitly mark work as code_generation so they can get deeper reasoning and a larger token budget.',
  },
  analysis: {
    purpose: 'Background investigations, delegated agent work, and non-chat analysis.',
    reason: 'Selected for analysis conversations and callers that do not fit a more specific operational route.',
  },
  dangerous: {
    purpose: 'Safety-critical or destructive operations that need stronger review.',
    reason: 'Legacy trait route for dangerous-tool intent, destructive actions, auth/security-sensitive operations, or commands requiring extra care.',
  },
  internet_data: {
    purpose: 'External, web, or untrusted content processing.',
    reason: 'Legacy trait route for internet-sourced data where provenance, prompt-injection risk, and synthesis quality matter.',
  },
  hard: {
    purpose: 'Maximum-reasoning tasks and difficult planning/debugging.',
    reason: 'Legacy trait route for work that should prefer the strongest configured reasoning provider before falling back.',
  },
};

function getDefaultFallbacks(taskType: string): ProviderFallback[] {
  if (taskType === 'summarization') return [];
  if (taskType === 'heartbeat') {
    return [
      { provider: 'openrouter', model: OPENROUTER_MODEL },
      { provider: 'openai', model: OPENAI_MODEL },
    ];
  }
  if (taskType === 'dangerous') {
    return [
      { provider: 'anthropic', model: ANTHROPIC_MODEL },
      { provider: 'openrouter', model: OPENROUTER_MODEL },
    ];
  }
  if (taskType === 'internet_data') {
    return [
      { provider: 'openai', model: OPENAI_MODEL },
      { provider: 'anthropic', model: ANTHROPIC_MODEL },
    ];
  }
  if (taskType === 'hard') {
    return [
      { provider: 'openai', model: OPENAI_MODEL },
      { provider: 'openrouter', model: OPENROUTER_MODEL },
    ];
  }
  return [
    { provider: 'openrouter', model: OPENROUTER_MODEL },
    { provider: 'openai', model: OPENAI_MODEL },
    { provider: 'anthropic', model: ANTHROPIC_MODEL },
  ];
}

function applyRouteMetadata(profile: ModelProfile, routeSource: ModelProfile['routeSource']): ModelProfile {
  const definition = MODEL_ROUTE_DEFINITIONS[profile.taskType];
  return {
    ...profile,
    routePurpose: profile.routePurpose ?? definition?.purpose ?? 'Custom task route.',
    routeReason: profile.routeReason ?? definition?.reason ?? 'Selected only when a caller explicitly requests this task type; otherwise unknown task types fall back to chat.',
    routeSource,
  };
}

function normalizeModelProfile(profile: ModelProfile, routeSource: ModelProfile['routeSource'] = profile.routeSource ?? 'saved'): ModelProfile {
  return applyRouteMetadata({
    ...profile,
    provider: profile.provider ?? 'ollama',
    model: profile.model ?? '',
    fallbacks: profile.fallbacks ?? getDefaultFallbacks(profile.taskType),
  }, routeSource);
}

/** Default model profiles — can be overridden via settings */
const DEFAULT_MODEL_PROFILES: ModelProfile[] = [
  normalizeModelProfile({ taskType: 'chat', provider: 'ollama', model: OLLAMA_MODEL, temperature: AI_TEMPERATURE, maxTokens: AI_MAX_TOKENS, maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS, thinkingMode: 'standard' }, 'built-in'),
  normalizeModelProfile({ taskType: 'heartbeat', provider: 'ollama', model: OLLAMA_MODEL, temperature: 0.2, maxTokens: AI_MAX_TOKENS, maxToolRounds: 2, thinkingMode: 'standard' }, 'built-in'),
  normalizeModelProfile({ taskType: 'summarization', provider: 'ollama', model: OLLAMA_MODEL, temperature: 0.1, maxTokens: 2048, maxToolRounds: 1, thinkingMode: 'off', systemPromptSuffix: 'Be extremely concise.' }, 'built-in'),
  normalizeModelProfile({ taskType: 'code_generation', provider: 'ollama', model: OLLAMA_MODEL, temperature: 0.1, maxTokens: AI_MAX_TOKENS * 2, maxToolRounds: 2, thinkingMode: 'deep', systemPromptSuffix: 'Focus on generating clean, working code.' }, 'built-in'),
  normalizeModelProfile({ taskType: 'analysis', provider: 'ollama', model: OLLAMA_MODEL, temperature: 0.2, maxTokens: AI_MAX_TOKENS, maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS, thinkingMode: 'standard' }, 'built-in'),
  normalizeModelProfile({ taskType: 'dangerous', provider: 'openai', model: OPENAI_MODEL, temperature: 0.1, maxTokens: AI_MAX_TOKENS, maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS, thinkingMode: 'deep' }, 'built-in'),
  normalizeModelProfile({ taskType: 'internet_data', provider: 'openrouter', model: OPENROUTER_MODEL, temperature: 0.2, maxTokens: AI_MAX_TOKENS, maxToolRounds: 2, thinkingMode: 'standard' }, 'built-in'),
  normalizeModelProfile({ taskType: 'hard', provider: 'anthropic', model: ANTHROPIC_MODEL, temperature: 0.2, maxTokens: AI_MAX_TOKENS * 2, maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS, thinkingMode: 'deep' }, 'built-in'),
];

function mergeModelProfiles(saved: ModelProfile[] = []): ModelProfile[] {
  const merged = new Map(DEFAULT_MODEL_PROFILES.map((profile) => [profile.taskType, normalizeModelProfile(profile, 'built-in')]));

  for (const profile of saved) {
    if (!profile?.taskType) continue;
    const existing = merged.get(profile.taskType);
    merged.set(profile.taskType, normalizeModelProfile({ ...existing, ...profile }, existing ? 'saved' : 'custom'));
  }

  return Array.from(merged.values());
}

async function loadModelProfiles(): Promise<ModelProfile[]> {
  const db = getDb();
  const entry = await db.aiMemory.findUnique({ where: { key: 'ai_model_routes' } });
  if (entry) {
    try {
      const saved = JSON.parse(entry.content) as ModelProfile[];
      if (Array.isArray(saved)) return mergeModelProfiles(saved);
    } catch { /* use defaults */ }
  }
  return mergeModelProfiles();
}

/**
 * Select the model profile for a given task type.
 * Falls back to the 'chat' profile if the task type isn't configured.
 */
export async function selectModel(taskType: string): Promise<ModelProfile> {
  const profiles = await loadModelProfiles();

  return normalizeModelProfile(
    profiles.find((p) => p.taskType === taskType)
      ?? profiles.find((p) => p.taskType === 'chat')
      ?? DEFAULT_MODEL_PROFILES[0]!,
  );
}

export async function getModelProfiles(): Promise<ModelProfile[]> {
  return loadModelProfiles();
}

export async function updateModelProfiles(profiles: ModelProfile[]): Promise<void> {
  const db = getDb();
  const content = JSON.stringify(profiles.map((profile) => {
    const { routePurpose, routeReason, routeSource, ...persisted } = normalizeModelProfile(profile);
    void routePurpose;
    void routeReason;
    void routeSource;
    return persisted;
  }));
  const existing = await db.aiMemory.findUnique({ where: { key: 'ai_model_routes' } });
  if (existing) {
    await db.aiMemory.update({ where: { key: 'ai_model_routes' }, data: { content } });
  } else {
    await db.aiMemory.create({
      data: {
        id: nanoid(),
        key: 'ai_model_routes',
        category: 'configuration',
        content,
        source: 'user',
        relevance: 0.0,
      },
    });
  }
}

// ── Context Window Management ──

/** Approximate token count using character-based heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Call the AI to summarize a conversation's messages.
 * Stores the summary on the AiConversation record.
 */
export async function summarizeConversation(conversationId: string): Promise<string | null> {
  const db = getDb();
  const messages = await db.aiMessage.findMany({
    where: { conversationId, role: { in: ['user', 'assistant'] } },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
  });

  if (messages.length < 5) return null; // Too few messages to summarize

  const transcript = messages.map((m) => `${m.role}: ${m.content.slice(0, 500)}`).join('\n');
  const summaryPrompt = `Summarize this conversation in 3 concise sentences. Focus on the key topics, decisions, and outcomes:\n\n${transcript.slice(0, 6000)}`;

  try {
    const profile = await selectModel('summarization');
    const result = await callLlm([
      { role: 'system', content: 'You are a concise summarizer. Respond with ONLY the summary, no preamble.' },
      { role: 'user', content: summaryPrompt },
    ], {
      provider: profile.provider,
      model: profile.model,
      fallbacks: profile.fallbacks,
      thinkingMode: 'off',
      temperature: profile.temperature,
      maxTokens: profile.maxTokens,
    });

    const summary = result.content.slice(0, 500);
    await db.aiConversation.update({
      where: { id: conversationId },
      data: { summary },
    });
    return summary;
  } catch {
    return null;
  }
}

// ── Tool Approval ──

/** Tools that require human approval before execution. */
export const DANGEROUS_TOOLS = new Set(['execCommand', 'writeFile', 'runSkill', 'createSkillDraft', 'generateRunbook']);

/**
 * Check if a tool requires human approval based on the configured policy.
 */
export async function getToolApprovalPolicy(): Promise<{
  alwaysAllow: string[];
  requireApproval: string[];
  alwaysDeny: string[];
}> {
  const db = getDb();
  const entry = await db.aiMemory.findUnique({ where: { key: 'tool_approval_policy' } });
  if (entry) {
    try {
      return JSON.parse(entry.content);
    } catch { /* use defaults */ }
  }
  return {
    alwaysAllow: ['getFleetStatus', 'getCodexFleetStatus', 'getNodeHealth', 'getHealthHistory', 'getWazuhFleetStatus', 'getActiveAnomalies',
      'getNodeAnomalies', 'getActiveAlerts', 'getRecentCommands', 'getNodeLogs',
      'readFile', 'listDirectory', 'recallMemories', 'searchNodes', 'getCronJobs',
      'getSkills', 'getDashboardStats', 'getAuditLog', 'getNodeDetails',
      'correlateAnomalies', 'getAnomalyTimeline', 'listSkillActions', 'listScratchpadVariables',
      'saveResult', 'transformData', 'compareSnapshots'],
    requireApproval: ['execCommand', 'writeFile', 'runSkill', 'createSkillDraft', 'forgetMemory'],
    alwaysDeny: [],
  };
}

// ── Load AI context documents ──

function loadContextDoc(filename: string): string {
  try {
    return readFileSync(resolve(__dirname, '../ai', filename), 'utf-8');
  } catch {
    return `[${filename} not found]`;
  }
}

const IDENTITY = loadContextDoc('IDENTITY.md');
const USER_DOC = loadContextDoc('USER.md');
const TOOLS_DOC = loadContextDoc('TOOLS.md');
const MEMORY_DOC = loadContextDoc('MEMORY.md');
const HEARTBEAT_DOC_DEFAULT = loadContextDoc('HEARTBEAT.md');

// ── System prompt construction ──

function buildSystemPrompt(context: {
  memories?: string;
  fleetStatus?: string;
  anomalies?: string;
  isHeartbeat?: boolean;
  heartbeatDoc?: string;
  recentHistory?: string;
  controllerContext?: string;
  userContext?: string;
  scratchpadContext?: string;
  replMode?: boolean;
}): string {
  const parts = [
    IDENTITY,
    '\n---\n',
    USER_DOC,
    '\n---\n',
    TOOLS_DOC,
    '\n---\n',
    MEMORY_DOC,
  ];

  if (context.isHeartbeat) {
    parts.push('\n---\n', context.heartbeatDoc ?? HEARTBEAT_DOC_DEFAULT);
  }

  if (context.userContext) {
    parts.push('\n\n## Current User\n\n', context.userContext);
  }

  if (context.controllerContext) {
    parts.push('\n\n## Active Controller Context\n\n', context.controllerContext);
  }

  if (context.memories) {
    parts.push('\n\n## Current Memories\n\n', context.memories);
  }

  if (context.fleetStatus) {
    parts.push('\n\n## Current Fleet Status\n\n', context.fleetStatus);
  }

  if (context.anomalies) {
    parts.push('\n\n## Active Anomalies\n\n', context.anomalies);
  }

  if (context.recentHistory) {
    parts.push('\n\n## Recent Conversation History\n\n', context.recentHistory);
  }

  if (context.replMode) {
    parts.push(
      '\n\n## REPL Mode\n\n',
      'REPL mode is active. Reuse scratchpad variables when comparing, transforming, or summarizing data. Prefer `saveResult`, `transformData`, and `compareSnapshots` over re-fetching identical data when possible.',
    );
  }

  if (context.scratchpadContext) {
    parts.push('\n\n## Scratchpad Variables\n\n', context.scratchpadContext);
  }

  return parts.join('');
}

// ── LLM tool definitions ──

function getOllamaToolDefinitions(): LlmToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'getFleetStatus',
        description: 'Returns the current status of all nodes plus cached Codex CLI version, update, and ChatGPT OAuth posture',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getCodexFleetStatus',
        description: 'Returns five-minute cached Codex installation, CLI version, update-availability, and ChatGPT OAuth posture',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getNodeHealth',
        description: 'Returns detailed health data for a specific node including CPU, memory, disk, network, and services',
        parameters: {
          type: 'object',
          properties: { nodeId: { type: 'string', description: 'The unique identifier of the node' } },
          required: ['nodeId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getHealthHistory',
        description: 'Returns historical health snapshots for a node for trend analysis',
        parameters: {
          type: 'object',
          properties: {
            nodeId: { type: 'string', description: 'The unique identifier of the node' },
            hours: { type: 'number', description: 'Number of hours to look back (default: 24)' },
          },
          required: ['nodeId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getWazuhFleetStatus',
        description: 'Returns Wazuh endpoint-security agent posture across the fleet, including installation, service state, enabled state, version, manager addresses, and sample time',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getActiveAnomalies',
        description: 'Returns all unresolved anomaly events fleet-wide with severity and metrics',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getNodeAnomalies',
        description: 'Returns anomaly events for a specific node with summary statistics',
        parameters: {
          type: 'object',
          properties: { nodeId: { type: 'string', description: 'The unique identifier of the node' } },
          required: ['nodeId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getActiveAlerts',
        description: 'Returns all active alert violations including rule name, metric, threshold, and severity',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getRecentCommands',
        description: 'Returns recently executed commands across the fleet with status and results',
        parameters: {
          type: 'object',
          properties: { hours: { type: 'number', description: 'Number of hours to look back (default: 1)' } },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getNodeLogs',
        description: 'Returns recent log entries for a specific node',
        parameters: {
          type: 'object',
          properties: {
            nodeId: { type: 'string', description: 'The unique identifier of the node' },
            lines: { type: 'number', description: 'Number of log lines to return (max: 200)' },
          },
          required: ['nodeId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'readFile',
        description: 'Read the contents of a file on the control node (must be within workspace, under 1MB)',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'File path relative to workspace root' } },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'writeFile',
        description: 'Write content to a file (restricted to allowed directories)',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to workspace root' },
            content: { type: 'string', description: 'Content to write to the file' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'listDirectory',
        description: 'List contents of a directory with file sizes and modification times',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Directory path relative to workspace root (default: ".")' } },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'storeMemory',
        description: 'Store a memory in HiveMem for future reference (persists across conversations, shared with other agents)',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Short label/key for the memory' },
            content: { type: 'string', description: 'Content to store' },
            category: { type: 'string', description: 'Category tag: general, node, pattern, or preference' },
          },
          required: ['key', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'recallMemories',
        description: 'Search HiveMem for stored memories using semantic search, optionally filtered by category',
        parameters: {
          type: 'object',
          properties: {
            category: { type: 'string', description: 'Filter by category tag' },
            limit: { type: 'number', description: 'Maximum number of memories to return (max: 50)' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'forgetMemory',
        description: 'Remove a specific memory from HiveMem by its ID',
        parameters: {
          type: 'object',
          properties: { key: { type: 'string', description: 'ID of the memory to remove' } },
          required: ['key'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'execCommand',
        description: 'Execute a shell command on a specific fleet node synchronously and return stdout/stderr/exit code. Use for admin tasks like checking service status, viewing configs, or running diagnostics.',
        parameters: {
          type: 'object',
          properties: {
            nodeId: { type: 'string', description: 'The unique identifier of the target node' },
            command: { type: 'string', description: 'The command to execute (e.g., "systemctl", "cat", "df")' },
            args: { type: 'string', description: 'JSON array of command arguments (e.g., ["status", "nginx"])' },
            workingDirectory: { type: 'string', description: 'Working directory for command execution (optional)' },
            timeoutSeconds: { type: 'number', description: 'Timeout in seconds (default: 60, max: 120)' },
          },
          required: ['nodeId', 'command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'searchNodes',
        description: 'Search for nodes by name, hostname, IP address, OS, or filter by status (ONLINE, OFFLINE, DEGRADED)',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search term to match against node name, hostname, IP, or OS' },
            status: { type: 'string', description: 'Filter by node status: ONLINE, OFFLINE, DEGRADED, PROVISIONING' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getCronJobs',
        description: 'List all scheduled cron jobs across the fleet, optionally filtered by node',
        parameters: {
          type: 'object',
          properties: {
            nodeId: { type: 'string', description: 'Filter cron jobs by node ID (optional — omit for all nodes)' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getSkills',
        description: 'List all available skill bundles with their version, description, tags, and files',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getDashboardStats',
        description: 'Returns aggregated fleet statistics: node counts by status, command counts, cron job counts, and average CPU/memory across online nodes',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getAuditLog',
        description: 'Query the audit log for recent actions. Returns timestamped events with actor, action, and target information.',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Date in YYYY-MM-DD format (default: today)' },
            action: { type: 'string', description: 'Filter by action type (e.g., "command.quick_exec", "node.deploy")' },
            limit: { type: 'number', description: 'Maximum events to return (default: 25, max: 100)' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getNodeDetails',
        description: 'Returns comprehensive details for a node including agent info, latest health snapshot, tags, metadata, and optionally live software versions and available updates',
        parameters: {
          type: 'object',
          properties: {
            nodeId: { type: 'string', description: 'The unique identifier of the node' },
            includeSoftwareVersions: { type: 'boolean', description: 'If true, runs a live command to fetch software versions and pending updates (takes a few seconds)' },
          },
          required: ['nodeId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'runSkill',
        description: 'Execute a skill bundle on a specific fleet node. Runs the skill script and returns output. Use for automated remediation, diagnostics, or maintenance tasks.',
        parameters: {
          type: 'object',
          properties: {
            nodeId: { type: 'string', description: 'The unique identifier of the target node' },
            skillName: { type: 'string', description: 'Name of the skill to execute (e.g., "disk-cleaner", "log-analyzer")' },
            action: { type: 'string', description: 'Script to run within the skill (default: "run")' },
          },
          required: ['nodeId', 'skillName'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'correlateAnomalies',
        description: 'Analyze anomalies across the fleet to find correlated patterns. Groups anomalies by time proximity and identifies fleet-wide issues vs isolated incidents.',
        parameters: {
          type: 'object',
          properties: {
            windowMinutes: { type: 'number', description: 'Time window for grouping anomalies in minutes (default: 5)' },
            includeResolved: { type: 'boolean', description: 'Include resolved anomalies in analysis (default: false)' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getAnomalyTimeline',
        description: 'Get a chronological timeline of anomalies with health context for trend analysis and root cause investigation.',
        parameters: {
          type: 'object',
          properties: {
            hours: { type: 'number', description: 'Number of hours to look back (default: 24)' },
            nodeId: { type: 'string', description: 'Filter to a specific node (optional)' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'createSkillDraft',
        description: 'Create a new skill bundle with a shell script. Use this to generate automated remediation or diagnostic scripts for the fleet.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill name in kebab-case (e.g., "memory-cleanup")' },
            description: { type: 'string', description: 'Human-readable description of what the skill does' },
            tags: { type: 'array', description: 'Tags for categorization (e.g., ["maintenance", "disk"])' },
            scriptContent: { type: 'string', description: 'The bash script content for run.sh' },
          },
          required: ['name', 'description', 'scriptContent'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'listSkillActions',
        description: 'List available skills with detailed info including README content, files, and tags. Optionally filter by skill name.',
        parameters: {
          type: 'object',
          properties: {
            skillName: { type: 'string', description: 'Filter to a specific skill by name (optional)' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'generateRunbook',
        description: 'Generate a complete operational runbook (multi-step skill bundle) from a natural language description. Creates a structured runbook with pre-checks, action steps, rollback procedures, and validation steps. Returns the runbook as a skill draft.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Runbook name in kebab-case (e.g., "postgres-failover")' },
            description: { type: 'string', description: 'Description of the operational procedure' },
            scenario: { type: 'string', description: 'Detailed natural language description of the scenario and steps needed' },
            tags: { type: 'array', description: 'Tags for categorization (e.g., ["database", "disaster-recovery"])' },
          },
          required: ['name', 'description', 'scenario'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'executeNaturalCommand',
        description: 'Translate a natural language intent into a shell command for a fleet node. Returns a command preview for user confirmation before execution. Use this when the user asks to perform operations like "restart nginx on web-01", "check disk space on db-server", "show logs for apache". Supports: service management (start/stop/restart/status), package ops (install/update/remove), log viewing (journalctl, tail), disk ops (df, du), network diagnostics (ss, ping, traceroute), process listing, uptime, memory usage.',
        parameters: {
          type: 'object',
          properties: {
            intent: {
              type: 'string',
              description: 'The natural language description of what command to run (e.g., "restart nginx", "check disk space", "show logs for sshd")',
            },
            nodeName: {
              type: 'string',
              description: 'Optional node name or hostname to target (e.g., "web-01", "db-server"). If omitted, will try to extract from the intent text.',
            },
          },
          required: ['intent'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getFleetPredictions',
        description: 'Get predictive failure detection results across the fleet. Uses exponential smoothing to forecast CPU, memory, swap, and disk usage 1-6 hours ahead.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getNodePredictions',
        description: 'Get predictive failure forecasts for a specific node including trend analysis.',
        parameters: {
          type: 'object',
          properties: {
            nodeId: { type: 'string', description: 'The node ID to get predictions for' },
          },
          required: ['nodeId'],
        },
      },
    },
  ];
}

interface LlmCallOptions<TStructured = unknown> {
  provider?: ProviderId;
  fallbacks?: ProviderFallback[];
  model?: string;
  tools?: LlmToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  thinkingMode?: ThinkingMode;
  responseSchema?: z.ZodType<TStructured> | Record<string, unknown>;
}

interface LlmResult<TStructured = unknown> extends LlmChatResult {
  content: string;
  thinking: string;
  evalCount: number;
  nativeToolCalls: Array<AiToolCall & { id?: string }>;
  structured: TStructured | null;
  usedStructuredOutput: boolean;
}

function getThinkingInstruction(mode: ThinkingMode): string | null {
  switch (mode) {
    case 'deep':
      return 'Reasoning: high';
    case 'standard':
      return 'Reasoning: medium';
    default:
      return null;
  }
}

function getResponseSchema<TStructured>(schema: LlmCallOptions<TStructured>['responseSchema']): {
  jsonSchema: Record<string, unknown> | null;
  validator: z.ZodType<TStructured> | null;
} {
  if (!schema) {
    return { jsonSchema: null, validator: null };
  }

  if (typeof (schema as z.ZodType<TStructured>).safeParse === 'function') {
    return {
      jsonSchema: z.toJSONSchema(schema as z.ZodType<TStructured>, { target: 'draft-7', io: 'input', unrepresentable: 'any' }) as Record<string, unknown>,
      validator: schema as z.ZodType<TStructured>,
    };
  }

  return { jsonSchema: schema as Record<string, unknown>, validator: null };
}

function parseStructuredResponse<TStructured>(
  content: string,
  validator: z.ZodType<TStructured> | null,
): TStructured | null {
  if (!content.trim()) return null;

  try {
    const parsed = JSON.parse(content) as unknown;
    if (!validator) return parsed as TStructured;
    const result = validator.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function buildStructuredOutputInstruction(jsonSchema: Record<string, unknown>): string {
  return [
    'Return ONLY valid JSON matching this schema.',
    'Do not include markdown fences or commentary.',
    JSON.stringify(jsonSchema),
  ].join('\n\n');
}

async function callLlm<TStructured = unknown>(
  messages: LlmMessage[],
  options: LlmCallOptions<TStructured> = {},
): Promise<LlmResult<TStructured>> {
  const { jsonSchema, validator } = getResponseSchema(options.responseSchema);
  const providerChain: ProviderFallback[] = [
    { provider: options.provider ?? 'ollama', model: options.model ?? OLLAMA_MODEL },
    ...(options.fallbacks ?? []),
  ].filter((candidate, index, array) => array.findIndex((entry) => entry.provider === candidate.provider && entry.model === candidate.model) === index);

  let lastError: Error | null = null;
  let lastConfigurationError: Error | null = null;

  for (const candidate of providerChain) {
    const provider = getLlmProvider(candidate.provider);
    if (!provider.isConfigured()) {
      lastConfigurationError ??= new Error(`${provider.name} is not configured`);
      continue;
    }

    let preparedMessages = messages;
    if (jsonSchema && !provider.supportsStructuredOutputs) {
      preparedMessages = [
        ...messages,
        { role: 'system', content: buildStructuredOutputInstruction(jsonSchema) },
      ];
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        console.log(`[AI] Calling ${provider.name} model=${candidate.model} messages=${preparedMessages.length} tools=${options.tools?.length ?? 0} attempt=${attempt + 1}`);
        const result = await provider.chat({
          messages: preparedMessages,
          model: candidate.model,
          tools: provider.supportsToolCalling ? options.tools : undefined,
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          thinkingMode: options.thinkingMode,
          jsonSchema: provider.supportsStructuredOutputs ? jsonSchema : null,
        });

        let content = result.content;
        if (!content && result.nativeToolCalls.length === 0 && result.thinking) {
          const thinkingToolCalls = parseToolCallsFromThinking(result.thinking);
          if (thinkingToolCalls) {
            content = thinkingToolCalls;
          }
        }

        let structured = jsonSchema ? parseStructuredResponse(content, validator) : null;
        if (jsonSchema && !structured && attempt === 0) {
          preparedMessages = [
            ...preparedMessages,
            { role: 'assistant', content },
            {
              role: 'user',
              content: 'Your previous response did not validate. Return ONLY valid JSON matching the schema. Do not include markdown fences, prose, or commentary.',
            },
          ];
          continue;
        }

        return {
          ...result,
          content,
          nativeToolCalls: result.nativeToolCalls.map((toolCall) => ({
            ...(toolCall.id ? { id: toolCall.id } : {}),
            name: toolCall.name,
            arguments: toolCall.arguments,
          })),
          structured,
        };
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error('Unknown LLM provider error');
        lastError = normalized;
        if (normalized instanceof Error && 'retryable' in normalized && (normalized as { retryable?: boolean }).retryable) {
          break;
        }
        if (attempt === 0 && jsonSchema) {
          preparedMessages = [
            ...preparedMessages,
            {
              role: 'user',
              content: 'Retry the response as valid JSON only. The previous attempt failed validation.',
            },
          ];
          continue;
        }
        break;
      }
    }
  }

  throw lastError ?? lastConfigurationError ?? new Error('No configured LLM provider was able to satisfy the request');
}

// ── Tool call parsing and execution ──

// Maximum rounds of tool calling before forcing a final response
const MAX_TOOL_ROUNDS = DEFAULT_MAX_TOOL_ROUNDS;
const LOOP_PROGRESS_SIMILARITY_THRESHOLD = 0.9;

function stableSerialize(value: unknown): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

export function getToolCallSignature(call: Pick<AiToolCall, 'name' | 'arguments'>): string {
  return `${call.name}:${stableSerialize(call.arguments)}`;
}

function tokenizeComparableText(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 3),
  );
}

export function getTextSimilarity(left: string, right: string): number {
  const leftTokens = tokenizeComparableText(left);
  const rightTokens = tokenizeComparableText(right);

  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let overlap = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) overlap += 1;
  });

  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

export function hasStalledForwardProgress(previous: string, current: string): boolean {
  if (!previous.trim() || !current.trim()) return false;
  return getTextSimilarity(previous, current) >= LOOP_PROGRESS_SIMILARITY_THRESHOLD;
}

function getToolLoopTokenBudget(maxTokens: number | undefined, maxToolRounds: number): number {
  return Math.max(maxTokens ?? AI_MAX_TOKENS, 1024) * Math.max(maxToolRounds, 1);
}

function hasExceededToolLoopBudget(totalEvalCount: number, maxTokens: number | undefined, maxToolRounds: number): boolean {
  return totalEvalCount >= getToolLoopTokenBudget(maxTokens, maxToolRounds);
}

function findRepeatedToolCall(
  calls: Array<Pick<AiToolCall, 'name' | 'arguments'>>,
  seenSignatures: Set<string>,
): Pick<AiToolCall, 'name' | 'arguments'> | null {
  const seenThisRound = new Set<string>();

  for (const call of calls) {
    const signature = getToolCallSignature(call);
    if (seenSignatures.has(signature) || seenThisRound.has(signature)) {
      return call;
    }
    seenThisRound.add(signature);
  }

  return null;
}

function summarizeToolResults(toolResults: AiToolResult[]): string {
  if (toolResults.length === 0) {
    return 'No completed tool results were available when the loop was stopped.';
  }

  return toolResults.map((result) => {
    if (!result.success) {
      return `- **${result.name}**: Failed — ${result.error ?? 'unknown error'}`;
    }

    const rendered = typeof result.result === 'string'
      ? result.result
      : JSON.stringify(result.result, null, 2);
    return `- **${result.name}**:\n${rendered}`;
  }).join('\n\n');
}

function buildLoopStopSummary(reason: string, toolResults: AiToolResult[]): string {
  return `${reason}\n\n${summarizeToolResults(toolResults)}`;
}

/**
 * Extract complete JSON objects from text using bracket-counting.
 * Handles nested braces, string literals, and escape sequences correctly.
 */
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      let depth = 0;
      let inString = false;
      let escape = false;
      const start = i;
      for (let j = i; j < text.length; j++) {
        const ch = text[j]!;
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}') {
          depth--;
          if (depth === 0) {
            objects.push(text.slice(start, j + 1));
            i = j + 1;
            break;
          }
        }
        if (j === text.length - 1) { i = j + 1; }
      }
      if (depth > 0) i = text.length; // Unterminated, bail
    } else {
      i++;
    }
  }
  return objects;
}

/**
 * Attempt to parse a JSON string as a tool call.
 * Normalizes alternate field names:
 *   - "tool" → "name"     (model often uses "tool" instead of "name")
 *   - "parameters" → "arguments"  (model often uses "parameters" instead of "arguments")
 *   - "params" → "arguments"
 *   - "function" → "name"
 * Only returns a call if the tool name matches a registered tool.
 */
function tryParseToolCall(jsonStr: string, knownTools: Set<string>): AiToolCall | null {
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const name = (parsed['name'] ?? parsed['tool'] ?? parsed['function']) as string | undefined;
    const args = (parsed['arguments'] ?? parsed['parameters'] ?? parsed['params'] ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || !name) return null;
    if (!knownTools.has(name)) return null;
    return { name, arguments: args };
  } catch {
    return null;
  }
}

/**
 * Robust tool call parser — handles multiple formats models may produce:
 *   1. XML tags: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
 *   2. JSON code blocks: ```json\n{...}\n```
 *   3. Raw JSON objects in text: {"tool": "...", "parameters": {...}}
 *
 * Returns on the first strategy that finds valid tool calls to avoid duplicates.
 * Validates tool names against the registered tool list.
 */
function parseToolCalls(content: string): AiToolCall[] {
  const knownTools = new Set(listAvailableTools());
  const seen = new Set<string>();

  function dedup(call: AiToolCall): boolean {
    const key = call.name + JSON.stringify(call.arguments);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }

  // Strategy 1: XML <tool_call> tags (preferred format)
  const xmlCalls: AiToolCall[] = [];
  for (const match of content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    for (const jsonStr of extractJsonObjects(match[1]!)) {
      const call = tryParseToolCall(jsonStr, knownTools);
      if (call && dedup(call)) xmlCalls.push(call);
    }
  }
  if (xmlCalls.length > 0) return xmlCalls;

  // Strategy 2: JSON code blocks (```json ... ```)
  const blockCalls: AiToolCall[] = [];
  for (const match of content.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g)) {
    for (const jsonStr of extractJsonObjects(match[1]!)) {
      const call = tryParseToolCall(jsonStr, knownTools);
      if (call && dedup(call)) blockCalls.push(call);
    }
  }
  if (blockCalls.length > 0) return blockCalls;

  // Strategy 3: Raw JSON objects in the text
  const rawCalls: AiToolCall[] = [];
  for (const jsonStr of extractJsonObjects(content)) {
    const call = tryParseToolCall(jsonStr, knownTools);
    if (call && dedup(call)) rawCalls.push(call);
  }
  return rawCalls;
}

/**
 * Remove tool call markup from an assistant response so the saved content
 * is clean text for the user to read. Strips:
 *   - <tool_call>...</tool_call> blocks
 *   - Standalone lines that are only a JSON tool call object
 *   - Excess blank lines left behind
 */
function stripToolCallMarkup(content: string, knownTools: Set<string>): string {
  // Remove XML-wrapped tool calls
  let cleaned = content.replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/g, '');

  // Remove standalone JSON tool-call lines (bare JSON that parses as a tool call)
  cleaned = cleaned.replace(/^\s*\{[^\n]*\}\s*$/gm, (line) => {
    const call = tryParseToolCall(line.trim(), knownTools);
    return call ? '' : line;
  });

  // Remove empty code blocks that might remain
  cleaned = cleaned.replace(/```(?:json)?\s*```/g, '');

  // Collapse multiple blank lines into at most two
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return cleaned || content;
}

/**
 * Check if thinking content contains tool calls and return them as formatted content.
 * The model sometimes emits tool call JSON inside the thinking block instead of content.
 * Returns the tool call markup as a string (ready for parseToolCalls), or null if none found.
 */
function parseToolCallsFromThinking(thinking: string): string | null {
  const knownTools = new Set(listAvailableTools());

  // Look for XML-wrapped tool calls in thinking
  const xmlMatches = [...thinking.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)];
  if (xmlMatches.length > 0) {
    return xmlMatches.map(m => `<tool_call>${m[1]}</tool_call>`).join('\n');
  }

  // Look for raw JSON tool call objects in thinking
  const jsonObjects = extractJsonObjects(thinking);
  const toolCallJsons: string[] = [];
  for (const jsonStr of jsonObjects) {
    const call = tryParseToolCall(jsonStr, knownTools);
    if (call) {
      toolCallJsons.push(`<tool_call>${JSON.stringify({ name: call.name, arguments: call.arguments })}</tool_call>`);
    }
  }
  if (toolCallJsons.length > 0) return toolCallJsons.join('\n');

  return null;
}

async function executeToolCalls(calls: AiToolCall[]): Promise<AiToolResult[]> {
  const policy = await getToolApprovalPolicy();
  const results: AiToolResult[] = [];
  for (const call of calls) {
    // Check denial policy
    if (policy.alwaysDeny.includes(call.name)) {
      results.push({ name: call.name, success: false, result: null, error: 'Tool is denied by policy' });
      continue;
    }
    const result = await executeAiTool(call);
    results.push(result);
  }
  return results;
}

// ── Conversation management ──

export async function getOrCreateConversation(
  type: 'chat' | 'heartbeat' | 'analysis' | 'a2a',
  options?: { nodeId?: string; title?: string; createdBy?: string },
): Promise<string> {
  const db = getDb();

  // For heartbeat conversations, reuse today's
  if (type === 'heartbeat') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const existing = await db.aiConversation.findFirst({
      where: {
        type: 'heartbeat',
        createdAt: { gte: today },
        status: 'active',
      },
      select: { id: true },
    });
    if (existing) return existing.id;

    const dateStr = new Date().toISOString().split('T')[0];
    const conv = await db.aiConversation.create({
      data: {
        id: nanoid(),
        title: `Fleet Heartbeat — ${dateStr}`,
        type: 'heartbeat',
        createdBy: 'system',
      },
    });
    return conv.id;
  }

  // For chat/analysis, create a new conversation
  const conv = await db.aiConversation.create({
    data: {
      id: nanoid(),
      title: options?.title ?? 'New conversation',
      type,
      nodeId: options?.nodeId ?? null,
      createdBy: options?.createdBy ?? 'system',
    },
  });
  return conv.id;
}

// ── Memory system (HiveMem) ──

async function getMemoriesAsContext(): Promise<string> {
  const { getHiveMemClient } = await import('./hivemem-client.js');
  const hivemem = getHiveMemClient();
  if (!hivemem.configured) return 'Memory system not configured.';

  try {
    const results = await hivemem.browseMemories(50);
    if (results.memories.length === 0) return 'No stored memories yet.';

    return results.memories
      .map((m) => `- [${m.type}/${m.scope}] ${m.content}`)
      .join('\n');
  } catch {
    return 'Memory system temporarily unavailable.';
  }
}

/**
 * Retrieve the custom heartbeat prompt override if set, otherwise return null
 * (callers fall back to the default HEARTBEAT_DOC).
 */
async function getHeartbeatPromptOverride(): Promise<string | null> {
  const db = getDb();
  const record = await db.aiMemory.findUnique({ where: { key: 'heartbeat_prompt' } });
  if (record && record.content) return record.content;
  return null;
}

/**
 * Build a condensed summary of the most recent chat conversations (not heartbeat/analysis)
 * to inject as prior-session context so the AI can maintain continuity.
 * Respects a token budget of ~2 000 tokens (≈8 000 chars) across all summaries.
 */
async function getRecentChatHistoryAsContext(
  excludeConversationId: string,
): Promise<string | null> {
  const db = getDb();
  const recentConvs = await db.aiConversation.findMany({
    where: {
      type: 'chat',
      status: 'active',
      id: { not: excludeConversationId },
    },
    orderBy: { updatedAt: 'desc' },
    take: 5,
    include: {
      messages: {
        where: { role: { in: ['user', 'assistant'] } },
        orderBy: { createdAt: 'asc' },
        take: 10,
        select: { role: true, content: true, createdAt: true },
      },
    },
  });

  if (recentConvs.length === 0) return null;

  const CHAR_BUDGET = 8_000;
  let used = 0;
  const lines: string[] = [];

  for (const conv of recentConvs) {
    if (conv.messages.length === 0) continue;

    const header = `### ${conv.title} (${new Date(conv.updatedAt).toLocaleDateString()})`;
    const msgLines = conv.messages.map(
      (m) => `**${m.role === 'user' ? 'User' : 'Magnus AI'}**: ${m.content.slice(0, 500)}`,
    );
    const block = [header, ...msgLines].join('\n');

    if (used + block.length > CHAR_BUDGET) break;
    lines.push(block);
    used += block.length;
  }

  if (lines.length === 0) return null;
  return lines.join('\n\n');
}

function getScratchpadAsContext(conversationId: string): string | null {
  const entries = listScratchpadEntries(conversationId);
  if (entries.length === 0) return null;

  return entries
    .slice(0, 20)
    .map((entry) => `- ${entry.name} (${entry.source}) — ${entry.summary}`)
    .join('\n');
}

// ── Main chat function ──

export interface ChatRequest {
  conversationId?: string;
  message: string;
  type?: 'chat' | 'heartbeat' | 'analysis';
  nodeId?: string;
  createdBy?: string;
  fleetContext?: string;
  anomalyContext?: string;
  controllerContext?: string;
  userInfo?: { email?: string; role?: string; username?: string };
  replMode?: boolean;
  thinkingMode?: ThinkingMode;
  maxToolRounds?: number;
  responseSchema?: z.ZodType<unknown> | Record<string, unknown>;
  structuredTextRenderer?: (value: unknown) => string;
  /** Multi-modal image attachments (base64) */
  attachments?: Array<{
    type: 'image';
    data: string;
    mimeType?: string;
  }>;
}

export interface ChatResponse {
  conversationId: string;
  messageId: string;
  content: string;
  toolCalls: AiToolResult[];
  tokenCount: number;
  thinking?: string;
  structuredAnalysis?: unknown;
}

/**
 * Send a message to the AI assistant and get a response.
 * Handles tool calling with one round of execution.
 */
export async function chat(request: ChatRequest): Promise<ChatResponse> {
  const db = getDb();

  // Get or create conversation
  const conversationId = request.conversationId ??
    await getOrCreateConversation(
      request.type ?? 'chat',
      { nodeId: request.nodeId, createdBy: request.createdBy },
    );

  // Load conversation history. Automated heartbeats already receive a fresh
  // fleet/anomaly snapshot, so replaying prior heartbeat messages only bloats
  // the prompt and can push local models into timeout territory.
  const includeConversationHistory = request.type !== 'heartbeat';
  const history = includeConversationHistory
    ? await db.aiMessage.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
        take: 50, // Limit context window
      })
    : [];

  // Build context
  const memories = await getMemoriesAsContext();
  const heartbeatDoc = request.type === 'heartbeat'
    ? (await getHeartbeatPromptOverride()) ?? undefined
    : undefined;
  const recentHistory = (!request.conversationId && request.type !== 'heartbeat')
    ? (await getRecentChatHistoryAsContext(conversationId)) ?? undefined
    : undefined;
  // Load AI settings for model selection + model routing
  const aiSettings = await getAiSettings();
  const modelProfile = await selectModel(request.type ?? 'chat');
  const activeModel = aiSettings.model || modelProfile.model;
  const maxToolRounds = request.maxToolRounds ?? aiSettings.maxToolRounds ?? modelProfile.maxToolRounds ?? MAX_TOOL_ROUNDS;

  // Auto-fetch fleet status and anomaly context for user chats
  let fleetContext = request.fleetContext;
  let anomalyContext = request.anomalyContext;
  if (!fleetContext && request.type !== 'heartbeat') {
    try {
      const nodes = await db.node.findMany({
        where: { metadata: { not: '{"sentinel":true}' } },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, hostname: true, ipAddress: true, status: true, lastHeartbeatAt: true },
      });
      fleetContext = `Fleet has ${nodes.length} node(s):\n` + nodes.map(n =>
        `- ${n.name} (${n.hostname}, ${n.ipAddress}) — ${n.status}, last heartbeat: ${n.lastHeartbeatAt?.toISOString() ?? 'never'}`
      ).join('\n');
    } catch { /* ignore */ }
  }
  if (!anomalyContext && request.type !== 'heartbeat') {
    try {
      const unresolvedCount = await db.anomalyEvent.count({ where: { resolved: false } });
      if (unresolvedCount > 0) {
        const recentAnomalies = await db.anomalyEvent.findMany({
          where: { resolved: false },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: { id: true, nodeId: true, metric: true, value: true, severity: true, createdAt: true },
        });
        anomalyContext = `${unresolvedCount} unresolved anomalies:\n` + recentAnomalies.map(a =>
          `- [${a.severity}] ${a.metric}=${a.value.toFixed(1)} on node ${a.nodeId} at ${a.createdAt.toISOString()}`
        ).join('\n');
      }
    } catch { /* ignore */ }
  }

  // Build user context string if user info is available
  let userContext: string | undefined;
  if (request.userInfo) {
    const parts: string[] = [];
    if (request.userInfo.email) parts.push(`Email: ${request.userInfo.email}`);
    if (request.userInfo.username) parts.push(`Username: ${request.userInfo.username}`);
    if (request.userInfo.role) parts.push(`Role: ${request.userInfo.role}`);
    if (parts.length > 0) userContext = parts.join('\n');
  }

  const systemPrompt = buildSystemPrompt({
    memories,
    fleetStatus: fleetContext,
    anomalies: anomalyContext,
    isHeartbeat: request.type === 'heartbeat',
    heartbeatDoc,
    recentHistory,
    controllerContext: request.controllerContext,
    userContext,
    scratchpadContext: request.replMode ? getScratchpadAsContext(conversationId) ?? undefined : undefined,
    replMode: request.replMode,
  });

  const messages: LlmMessage[] = [];
  messages.push({ role: 'system', content: systemPrompt });

  // Add conversation history
  for (const msg of history) {
    messages.push({
      role: msg.role as LlmMessage['role'],
      content: msg.content,
    });
  }

  // Add current user message
  const userMessage: LlmMessage = { role: 'user', content: request.message };
  if (request.attachments?.length) {
    userMessage.images = request.attachments
      .filter((a) => a.type === 'image')
      .map((a) => ({ type: 'image' as const, data: a.data, mimeType: a.mimeType }));
  }
  messages.push(userMessage);

  // Save user message
  await db.aiMessage.create({
    data: {
      id: nanoid(),
      conversationId,
      role: 'user',
      content: request.message,
      isRead: true, // User messages are always "read"
    },
  });

  // Call Ollama with native tool definitions (filtered by tool config).
  // Heartbeat runs already pass pre-gathered fleet/anomaly context and should
  // avoid sending the full tool schema set on every scheduled analysis.
  const allTools = request.type === 'heartbeat' ? [] : getOllamaToolDefinitions();
  const config = allTools.length > 0 ? await getToolConfig() : [];
  const disabledSet = new Set(config.filter((e) => !e.enabled).map((e) => e.name));
  const llmTools = disabledSet.size > 0
    ? allTools.filter((t) => !disabledSet.has(t.function.name))
    : allTools;
  console.log(`[AI] chat() start — type=${request.type ?? 'chat'} provider=${modelProfile.provider ?? 'ollama'} model=${activeModel} conversationId=${conversationId} historySize=${history.length} nativeTools=${llmTools.length}`);
  let llmResult: LlmResult;
  try {
    llmResult = await callLlm(messages, {
      provider: modelProfile.provider,
      model: activeModel,
      fallbacks: modelProfile.fallbacks,
      tools: llmTools,
      temperature: modelProfile.temperature,
      maxTokens: modelProfile.maxTokens,
      thinkingMode: request.thinkingMode ?? aiSettings.thinkingMode ?? modelProfile.thinkingMode ?? 'standard',
      responseSchema: aiSettings.structuredOutputsEnabled ? request.responseSchema : undefined,
    });
  } catch (err) {
    console.error(`[AI] LLM call failed:`, err instanceof Error ? err.message : err);
    const providerLabel = modelProfile.provider === 'ollama' ? `Ollama at ${OLLAMA_BASE_URL}` : `provider ${modelProfile.provider ?? 'ollama'}`;
    const errorMsg = `⚠️ AI service unavailable: ${err instanceof Error ? err.message : 'Unknown error'}. Check ${providerLabel} and configured fallbacks.`;
    const errorMsgId = nanoid();
    await db.aiMessage.create({
      data: {
        id: errorMsgId,
        conversationId,
        role: 'assistant',
        content: errorMsg,
        isRead: false,
      },
    });
    return {
      conversationId,
      messageId: errorMsgId,
      content: errorMsg,
      toolCalls: [],
      tokenCount: 0,
    };
  }

  let responseContent = llmResult.content;
  let responseThinking = llmResult.thinking;
  let structuredAnalysis = llmResult.structured;
  let totalEvalCount = llmResult.evalCount;
  const knownTools = new Set(listAvailableTools());
  const seenToolCallSignatures = new Set<string>();
  let previousComparableResponse = '';

  // ── Multi-round tool calling loop ──
  // Supports native Ollama tool calls (preferred) with text-based parsing fallback.
  // Up to MAX_TOOL_ROUNDS rounds before forcing a final response.
  const allToolResults: AiToolResult[] = [];

  async function forceFinalResponse(instruction: string): Promise<void> {
    try {
      const forced = await callLlm([
        ...messages,
        { role: 'assistant', content: responseContent },
        { role: 'user', content: instruction },
      ], {
        provider: modelProfile.provider,
        model: activeModel,
        fallbacks: modelProfile.fallbacks,
        temperature: modelProfile.temperature,
        maxTokens: modelProfile.maxTokens,
        thinkingMode: request.thinkingMode ?? aiSettings.thinkingMode ?? modelProfile.thinkingMode ?? 'standard',
        responseSchema: aiSettings.structuredOutputsEnabled ? request.responseSchema : undefined,
      });

      responseContent = forced.content || buildLoopStopSummary(instruction, allToolResults);
      if (forced.thinking) {
        responseThinking = [responseThinking, forced.thinking].filter(Boolean).join('\n\n---\n\n');
      }
      if (forced.structured != null) {
        structuredAnalysis = forced.structured;
      }
      totalEvalCount += forced.evalCount;
    } catch {
      responseContent = buildLoopStopSummary(instruction, allToolResults);
    }
  }

  for (let round = 0; round < maxToolRounds; round++) {
    // Prefer native tool calls; fall back to text-based parsing
    const isNative = llmResult.nativeToolCalls.length > 0;
    const toolCalls = isNative
      ? llmResult.nativeToolCalls
      : parseToolCalls(responseContent);

    if (toolCalls.length === 0) break;

    const comparableResponse = stripToolCallMarkup(responseContent, knownTools);
    if (hasExceededToolLoopBudget(totalEvalCount, modelProfile.maxTokens, maxToolRounds)) {
      await forceFinalResponse('Stop calling tools and provide the best final answer now. The tool-round token budget has been reached. Use the results you already gathered.');
      break;
    }

    const repeatedToolCall = findRepeatedToolCall(toolCalls, seenToolCallSignatures);
    if (repeatedToolCall) {
      await forceFinalResponse(`Do not call any more tools. You already requested \`${repeatedToolCall.name}\` with the same arguments earlier. Use the existing evidence and respond with your best final answer.`);
      break;
    }

    if (previousComparableResponse && hasStalledForwardProgress(previousComparableResponse, comparableResponse)) {
      await forceFinalResponse('Do not call any more tools. Your last investigation step is too similar to the previous one and is no longer making forward progress. Summarize the best answer from the data you already have.');
      break;
    }

    previousComparableResponse = comparableResponse;
    toolCalls.forEach((call) => seenToolCallSignatures.add(getToolCallSignature(call)));

    console.log(`[AI] Round ${round + 1}: ${toolCalls.length} tool call(s) [${isNative ? 'native' : 'text-parsed'}]: ${toolCalls.map(t => t.name).join(', ')}`);

    // Execute all tool calls for this round
    const executableToolCalls = toolCalls.map((call) => ({
      ...call,
      arguments: {
        ...call.arguments,
        _conversationId: conversationId,
      },
    }));

    const roundResults = await executeToolCalls(executableToolCalls);
    allToolResults.push(...roundResults);

    if (request.replMode) {
      executableToolCalls.forEach((call, index) => {
        const result = roundResults[index];
        if (result?.success) {
          autoStoreToolResult(conversationId, call.name, result.result);
        }
      });
    }

    if (isNative) {
      // ── Native tool calling path ──
      // Per Ollama API spec: assistant message with tool_calls, then one `tool` role message per result.
      messages.push({
        role: 'assistant',
        content: responseContent,
        tool_calls: toolCalls,
      });
      roundResults.forEach((r, index) => {
        messages.push({
          role: 'tool',
          content: JSON.stringify(r.success ? r.result : { error: r.error }),
          tool_call_id: toolCalls[index] && 'id' in toolCalls[index] ? (toolCalls[index] as { id?: string }).id : undefined,
        });
      });
    } else {
      // ── Text-based fallback path ──
      // Use "user" role for tool results wrapped in structured markers.
      const toolResultsContent = roundResults
        .map((r) => [
          `### Tool: ${r.name}`,
          `Status: ${r.success ? 'SUCCESS' : 'FAILED'}`,
          r.error ? `Error: ${r.error}` : `Result:\n${JSON.stringify(r.result, null, 2)}`,
        ].join('\n'))
        .join('\n\n---\n\n');

      messages.push({ role: 'assistant', content: responseContent });
      messages.push({
        role: 'user',
        content: [
          '[TOOL_RESULTS]',
          toolResultsContent,
          '[/TOOL_RESULTS]',
          '',
          round < maxToolRounds - 1
            ? 'Analyze these results and respond to the user. If you need additional data, you may call more tools.'
            : 'Analyze these results and provide your final response to the user. Do not call any more tools.',
        ].join('\n'),
      });
    }

    try {
      llmResult = await callLlm(messages, {
        provider: modelProfile.provider,
        model: activeModel,
        fallbacks: modelProfile.fallbacks,
        tools: llmTools,
        temperature: modelProfile.temperature,
        maxTokens: modelProfile.maxTokens,
        thinkingMode: request.thinkingMode ?? aiSettings.thinkingMode ?? modelProfile.thinkingMode ?? 'standard',
        responseSchema: aiSettings.structuredOutputsEnabled ? request.responseSchema : undefined,
      });
      responseContent = llmResult.content;
      if (llmResult.thinking) {
        responseThinking = [responseThinking, llmResult.thinking].filter(Boolean).join('\n\n---\n\n');
      }
      if (llmResult.structured != null) {
        structuredAnalysis = llmResult.structured;
      }
      totalEvalCount += llmResult.evalCount;
    } catch (roundErr) {
      console.error(`[AI] Multi-round Ollama call failed (round ${round + 1}):`, roundErr instanceof Error ? roundErr.message : roundErr);
      // Build a fallback response from the tool results we already have
      if (allToolResults.length > 0) {
        const fallbackLines = allToolResults.map((r) => {
          if (!r.success) return `**${r.name}**: Failed — ${r.error ?? 'unknown error'}`;
          return `**${r.name}**: ${JSON.stringify(r.result, null, 2)}`;
        });
        responseContent = `I retrieved the following data but was unable to complete analysis:\n\n${fallbackLines.join('\n\n')}`;
      }
      break;
    }
  }

  // Strip any remaining tool call markup from the final response so users see clean text
  const rawContent = responseContent;
  responseContent = stripToolCallMarkup(responseContent, knownTools);

  // Guard: never save an empty response
  if (!responseContent.trim()) {
    console.warn(`[AI] stripToolCallMarkup produced empty content. rawContent=${rawContent.length} chars, toolResults=${allToolResults.length}`);
    if (allToolResults.length > 0) {
      // Build a readable summary from the tool results
      const summaryLines = allToolResults.map((r) => {
        if (!r.success) return `- **${r.name}**: Failed — ${r.error ?? 'unknown error'}`;
        const resultStr = typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2);
        return `- **${r.name}**:\n${resultStr}`;
      });
      responseContent = `Here are the results from the tools I called:\n\n${summaryLines.join('\n\n')}`;
    } else {
      responseContent = rawContent || 'I was unable to generate a response. Please try rephrasing your question.';
    }
  }

  console.log(`[AI] chat() complete — content=${responseContent.length} chars, toolCalls=${allToolResults.length}, evalCount=${totalEvalCount}`);

  if (structuredAnalysis != null && request.structuredTextRenderer) {
    const rendered = request.structuredTextRenderer(structuredAnalysis);
    if (rendered.trim()) {
      responseContent = rendered;
    }
  }

  // Use actual token count from Ollama when available, fall back to estimate
  const tokenCount = totalEvalCount > 0 ? totalEvalCount : Math.ceil(responseContent.length / 4);

  // Save assistant response
  const messageId = nanoid();
  await db.aiMessage.create({
    data: {
      id: messageId,
      conversationId,
      role: 'assistant',
      content: responseContent,
      toolCalls: JSON.stringify(allToolResults),
      thinking: responseThinking || null,
      structuredAnalysis: structuredAnalysis != null ? JSON.stringify(structuredAnalysis) : null,
      tokenCount,
      isRead: false,
    },
  });

  // Update conversation timestamp
  await db.aiConversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });

  // Auto-summarize if conversation is getting long
  const totalMessages = await db.aiMessage.count({ where: { conversationId } });
  if (totalMessages > 20 && totalMessages % 10 === 0) {
    summarizeConversation(conversationId).catch(() => {}); // fire-and-forget
  }

  return {
    conversationId,
    messageId,
    content: responseContent,
    toolCalls: allToolResults,
    tokenCount,
    thinking: responseThinking || undefined,
    structuredAnalysis: structuredAnalysis ?? undefined,
  };
}

// ── Conversation list / message queries ──

export async function listConversations(params: {
  type?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ conversations: unknown[]; total: number }> {
  const db = getDb();
  const page = params.page ?? 1;
  const pageSize = Math.min(params.pageSize ?? 20, 50);
  const skip = (page - 1) * pageSize;

  const where: Record<string, unknown> = {};
  if (params.type) where['type'] = params.type;
  // 'all' is a sentinel meaning no status filter
  if (params.status && params.status !== 'all') where['status'] = params.status;

  const [conversations, total] = await Promise.all([
    db.aiConversation.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip,
      take: pageSize,
      include: {
        _count: { select: { messages: true, children: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { content: true, role: true, createdAt: true },
        },
      },
    }),
    db.aiConversation.count({ where }),
  ]);

  return {
    conversations: conversations.map((c) => ({
      ...c,
      lastMessage: c.messages[0] ?? null,
      messages: undefined,
      messageCount: c._count.messages,
      childCount: c._count.children,
    })),
    total,
  };
}

export async function getConversationMessages(
  conversationId: string,
  params?: { page?: number; pageSize?: number },
): Promise<{ messages: unknown[]; total: number }> {
  const db = getDb();
  const page = params?.page ?? 1;
  const pageSize = Math.min(params?.pageSize ?? 50, 100);
  const skip = (page - 1) * pageSize;

  const [messages, total] = await Promise.all([
    db.aiMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      skip,
      take: pageSize,
    }),
    db.aiMessage.count({ where: { conversationId } }),
  ]);

  return {
    messages: messages.map((m) => ({
      ...m,
      toolCalls: JSON.parse(m.toolCalls),
      thinking: m.thinking ?? undefined,
      structuredAnalysis: m.structuredAnalysis ? JSON.parse(m.structuredAnalysis) : undefined,
      pendingApproval: m.pendingApproval ? JSON.parse(m.pendingApproval) : null,
    })),
    total,
  };
}

export async function getUnreadAiMessageCount(): Promise<number> {
  const db = getDb();
  return db.aiMessage.count({
    where: { role: 'assistant', isRead: false },
  });
}

export async function markAiMessagesRead(messageIds: string[]): Promise<number> {
  const db = getDb();
  const result = await db.aiMessage.updateMany({
    where: { id: { in: messageIds }, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return result.count;
}

export async function markConversationRead(conversationId: string): Promise<number> {
  const db = getDb();
  const result = await db.aiMessage.updateMany({
    where: { conversationId, isRead: false, role: 'assistant' },
    data: { isRead: true, readAt: new Date() },
  });
  return result.count;
}

export async function archiveConversation(conversationId: string): Promise<void> {
  const db = getDb();
  await db.aiConversation.update({
    where: { id: conversationId },
    data: { status: 'archived' },
  });
}

export async function deleteConversation(conversationId: string): Promise<void> {
  const db = getDb();
  // Messages cascade via foreign key, but delete explicitly to be safe
  await db.aiMessage.deleteMany({ where: { conversationId } });
  await db.aiConversation.delete({ where: { id: conversationId } });
}

async function upsertConfigurationEntry(key: string, content: string, source = 'user'): Promise<void> {
  const db = getDb();
  const existing = await db.aiMemory.findUnique({ where: { key } });

  if (existing) {
    await db.aiMemory.update({
      where: { key },
      data: { content, updatedAt: new Date() },
    });
    return;
  }

  await db.aiMemory.create({
    data: {
      id: nanoid(),
      key,
      category: 'configuration',
      content,
      source,
      relevance: 0.0,
    },
  });
}

export async function updateToolApprovalPolicy(policy: {
  alwaysAllow: string[];
  requireApproval: string[];
  alwaysDeny: string[];
}): Promise<void> {
  const normalized = {
    alwaysAllow: [...new Set(policy.alwaysAllow)].sort(),
    requireApproval: [...new Set(policy.requireApproval)].sort(),
    alwaysDeny: [...new Set(policy.alwaysDeny)].sort(),
  };
  await upsertConfigurationEntry('tool_approval_policy', JSON.stringify(normalized));
}

export async function forkConversation(
  conversationId: string,
  options?: { fromMessageId?: string; createdBy?: string },
): Promise<{ id: string; title: string; parentId: string | null; forkedFromMessageId: string | null }> {
  const db = getDb();
  const conversation = await db.aiConversation.findUnique({
    where: { id: conversationId },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });

  if (!conversation) {
    throw new Error('Conversation not found');
  }

  const forkIndex = options?.fromMessageId
    ? conversation.messages.findIndex((message) => message.id === options.fromMessageId)
    : conversation.messages.length - 1;

  if (options?.fromMessageId && forkIndex === -1) {
    throw new Error('Fork source message not found');
  }

  const messagesToCopy = conversation.messages.slice(0, Math.max(forkIndex + 1, 0));
  const siblingCount = await db.aiConversation.count({ where: { parentId: conversationId } });
  const title = `${conversation.title} — Branch ${siblingCount + 1}`;

  const fork = await db.aiConversation.create({
    data: {
      id: nanoid(),
      title,
      type: conversation.type,
      nodeId: conversation.nodeId,
      createdBy: options?.createdBy ?? conversation.createdBy,
      parentId: conversation.id,
      forkedFromMessageId: options?.fromMessageId ?? messagesToCopy.at(-1)?.id ?? null,
    },
  });

  if (messagesToCopy.length > 0) {
    await db.aiMessage.createMany({
      data: messagesToCopy.map((message) => ({
        id: nanoid(),
        conversationId: fork.id,
        role: message.role,
        content: message.content,
        toolCalls: message.toolCalls,
        thinking: message.thinking,
        structuredAnalysis: message.structuredAnalysis,
        tokenCount: message.tokenCount,
        isRead: true,
        readAt: new Date(),
        pendingApproval: null,
      })),
    });
  }

  return {
    id: fork.id,
    title: fork.title,
    parentId: fork.parentId,
    forkedFromMessageId: fork.forkedFromMessageId,
  };
}

export async function createConversationShare(
  conversationId: string,
  createdBy: string,
  options?: { ttlHours?: number },
): Promise<{ token: string; expiresAt: string }> {
  const db = getDb();
  const conversation = await db.aiConversation.findUnique({ where: { id: conversationId } });
  if (!conversation) {
    throw new Error('Conversation not found');
  }

  const token = nanoid(24);
  const expiresAt = new Date(Date.now() + (options?.ttlHours ?? 72) * 60 * 60 * 1000).toISOString();

  await upsertConfigurationEntry(
    `share:conversation:${token}`,
    JSON.stringify({
      token,
      conversationId,
      createdBy,
      expiresAt,
      createdAt: new Date().toISOString(),
    }),
    'user',
  );

  return { token, expiresAt };
}

export async function getSharedConversation(token: string): Promise<{
  token: string;
  expiresAt: string;
  conversation: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
} | null> {
  const db = getDb();
  const record = await db.aiMemory.findUnique({ where: { key: `share:conversation:${token}` } });
  if (!record) return null;

  let payload: { conversationId: string; expiresAt: string; createdAt: string; createdBy: string; token: string };
  try {
    payload = JSON.parse(record.content);
  } catch {
    return null;
  }

  if (new Date(payload.expiresAt).getTime() <= Date.now()) {
    await db.aiMemory.delete({ where: { key: `share:conversation:${token}` } }).catch(() => {});
    return null;
  }

  const conversation = await db.aiConversation.findUnique({
    where: { id: payload.conversationId },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
      },
      _count: { select: { messages: true, children: true } },
    },
  });

  if (!conversation) return null;

  return {
    token,
    expiresAt: payload.expiresAt,
    conversation: {
      id: conversation.id,
      title: conversation.title,
      type: conversation.type,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      parentId: conversation.parentId,
      forkedFromMessageId: conversation.forkedFromMessageId,
      messageCount: conversation._count.messages,
      childCount: conversation._count.children,
    },
    messages: conversation.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      toolCalls: JSON.parse(message.toolCalls),
      thinking: message.thinking,
      structuredAnalysis: message.structuredAnalysis ? JSON.parse(message.structuredAnalysis) : null,
      createdAt: message.createdAt.toISOString(),
    })),
  };
}

// ── Tool Config ──

export interface ToolConfigEntry {
  name: string;
  enabled: boolean;
}

/**
 * Return the current tool enable/disable config stored in AiMemory.
 * Tools that are not listed in the config are assumed enabled.
 */
export async function getToolConfig(): Promise<ToolConfigEntry[]> {
  const db = getDb();
  const record = await db.aiMemory.findUnique({ where: { key: 'tool_config' } });
  if (!record) return [];
  try {
    return JSON.parse(record.content) as ToolConfigEntry[];
  } catch {
    return [];
  }
}

export async function updateToolConfig(entries: ToolConfigEntry[]): Promise<void> {
  const db = getDb();
  const content = JSON.stringify(entries);
  const existing = await db.aiMemory.findUnique({ where: { key: 'tool_config' } });
  if (existing) {
    await db.aiMemory.update({
      where: { key: 'tool_config' },
      data: { content, updatedAt: new Date() },
    });
  } else {
    await db.aiMemory.create({
      data: {
        id: nanoid(),
        key: 'tool_config',
        category: 'configuration',
        content,
        source: 'user',
        relevance: 0.0, // excluded from AI context injection
      },
    });
  }
}

// ── Heartbeat Prompt ──

/**
 * Return the current heartbeat prompt. If a user override is stored in AiMemory
 * it is returned; otherwise the default HEARTBEAT.md content is returned.
 */
export async function getHeartbeatPrompt(): Promise<{ content: string; isCustom: boolean }> {
  const db = getDb();
  const record = await db.aiMemory.findUnique({ where: { key: 'heartbeat_prompt' } });
  if (record?.content) {
    return { content: record.content, isCustom: true };
  }
  return { content: HEARTBEAT_DOC_DEFAULT, isCustom: false };
}

export async function updateHeartbeatPrompt(content: string): Promise<void> {
  const db = getDb();
  const existing = await db.aiMemory.findUnique({ where: { key: 'heartbeat_prompt' } });
  if (existing) {
    await db.aiMemory.update({
      where: { key: 'heartbeat_prompt' },
      data: { content, updatedAt: new Date() },
    });
  } else {
    await db.aiMemory.create({
      data: {
        id: nanoid(),
        key: 'heartbeat_prompt',
        category: 'configuration',
        content,
        source: 'user',
        relevance: 0.0,
      },
    });
  }
}

export async function resetHeartbeatPrompt(): Promise<void> {
  const db = getDb();
  await db.aiMemory.deleteMany({ where: { key: 'heartbeat_prompt' } });
}

// ── Ollama Models ──

export interface OllamaModelInfo {
  name: string;
  size: number;
  parameterSize: string;
  family: string;
  quantizationLevel: string;
}

export async function listOllamaModels(): Promise<OllamaModelInfo[]> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Ollama API error: ${res.status}`);
  const data = (await res.json()) as {
    models?: Array<{
      name: string;
      size: number;
      details?: { parameter_size?: string; family?: string; quantization_level?: string };
    }>;
  };
  return (data.models ?? []).map((m) => ({
    name: m.name,
    size: m.size,
    parameterSize: m.details?.parameter_size ?? '',
    family: m.details?.family ?? '',
    quantizationLevel: m.details?.quantization_level ?? '',
  }));
}

export async function getModelContextLength(modelName: string): Promise<number | null> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { model_info?: Record<string, unknown> };
    for (const [key, val] of Object.entries(data.model_info ?? {})) {
      if (key.includes('context_length')) return val as number;
    }
    return null;
  } catch {
    return null;
  }
}

// ── AI Settings ──

export interface AiSettingsData {
  model: string;
  defaultModel: string;
  maxContextTokens: number;
  systemPrompt: string | null;
  isCustomSystemPrompt: boolean;
  defaultSystemPrompt: string;
  thinkingMode: ThinkingMode;
  showReasoning: boolean;
  maxToolRounds: number;
  replEnabled: boolean;
  structuredOutputsEnabled: boolean;
}

export async function getAiSettings(): Promise<AiSettingsData> {
  const db = getDb();
  const entry = await db.aiMemory.findUnique({ where: { key: 'ai_settings' } });
  let saved: {
    model?: string;
    maxContextTokens?: number;
    systemPrompt?: string | null;
    thinkingMode?: ThinkingMode;
    showReasoning?: boolean;
    maxToolRounds?: number;
    replEnabled?: boolean;
    structuredOutputsEnabled?: boolean;
  } = {};
  if (entry) {
    try { saved = JSON.parse(entry.content); } catch { /* ignore */ }
  }

  // Verify chosen model is still available, fall back to default if not
  let model = saved.model ?? OLLAMA_MODEL;
  try {
    const models = await listOllamaModels();
    if (!models.some((m) => m.name === model)) model = OLLAMA_MODEL;
  } catch {
    model = OLLAMA_MODEL;
  }

  return {
    model,
    defaultModel: OLLAMA_MODEL,
    maxContextTokens: saved.maxContextTokens ?? AI_MAX_CONTEXT_TOKENS,
    systemPrompt: saved.systemPrompt ?? null,
    isCustomSystemPrompt: saved.systemPrompt != null,
    defaultSystemPrompt: IDENTITY,
    thinkingMode: saved.thinkingMode ?? 'standard',
    showReasoning: saved.showReasoning ?? true,
    maxToolRounds: saved.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS,
    replEnabled: saved.replEnabled ?? false,
    structuredOutputsEnabled: saved.structuredOutputsEnabled ?? true,
  };
}

export async function updateAiSettings(
  settings: {
    model?: string;
    maxContextTokens?: number;
    systemPrompt?: string | null;
    thinkingMode?: ThinkingMode;
    showReasoning?: boolean;
    maxToolRounds?: number;
    replEnabled?: boolean;
    structuredOutputsEnabled?: boolean;
  },
): Promise<void> {
  const db = getDb();
  const existing = await db.aiMemory.findUnique({ where: { key: 'ai_settings' } });
  let current: Record<string, unknown> = {};
  if (existing) {
    try { current = JSON.parse(existing.content); } catch { /* ignore */ }
  }
  const merged = { ...current, ...settings };
  const content = JSON.stringify(merged);

  if (existing) {
    await db.aiMemory.update({
      where: { key: 'ai_settings' },
      data: { content, updatedAt: new Date() },
    });
  } else {
    await db.aiMemory.create({
      data: {
        id: nanoid(),
        key: 'ai_settings',
        category: 'configuration',
        content,
        source: 'user',
        relevance: 0.0,
      },
    });
  }
}

// ── Check Ollama availability ──

export async function checkOllamaHealth(): Promise<{ available: boolean; model: string; url: string; error?: string }> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { available: false, model: OLLAMA_MODEL, url: OLLAMA_BASE_URL, error: `HTTP ${response.status}` };
    }
    const data = (await response.json()) as { models?: Array<{ name: string }> };
    const modelAvailable = data.models?.some((m) => m.name === OLLAMA_MODEL || m.name.startsWith(OLLAMA_MODEL.split(':')[0]!));
    return {
      available: !!modelAvailable,
      model: OLLAMA_MODEL,
      url: OLLAMA_BASE_URL,
      error: modelAvailable ? undefined : `Model ${OLLAMA_MODEL} not found`,
    };
  } catch (err) {
    return {
      available: false,
      model: OLLAMA_MODEL,
      url: OLLAMA_BASE_URL,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

export async function getProviderStatuses(force = false) {
  return getLlmProviderStatuses(force);
}

// ── Streaming Chat ──

export type StreamEvent =
  | { event: 'thinking'; data: { round: number; status: string } }
  | { event: 'thinking_token'; data: { text: string; round: number } }
  | { event: 'tool_start'; data: { name: string; round: number } }
  | { event: 'tool_result'; data: { name: string; success: boolean; result: unknown } }
  | { event: 'scratchpad_update'; data: { entries: Array<{ name: string; source: string; summary: string }> } }
  | { event: 'token'; data: { text: string } }
  | { event: 'done'; data: { conversationId: string; messageId: string; tokenCount: number } }
  | { event: 'error'; data: { message: string } };

/**
 * Stream a chat response as SSE events.
 * Calls Ollama with stream=true and forwards token deltas.
 */
export async function chatStream(
  request: ChatRequest,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const db = getDb();

  try {
    const aiSettings = await getAiSettings();
    const profile = await selectModel(request.type ?? 'chat');
    const primaryProvider = getLlmProvider(profile.provider ?? 'ollama');

    if (!primaryProvider.supportsStreaming || !primaryProvider.streamChat) {
      const fallback = await chat(request);
      if (fallback.thinking) {
        onEvent({ event: 'thinking_token', data: { text: fallback.thinking, round: 1 } });
      }
      for (const toolCall of fallback.toolCalls) {
        onEvent({
          event: 'tool_result',
          data: { name: toolCall.name, success: toolCall.success, result: toolCall.result },
        });
      }
      onEvent({ event: 'token', data: { text: fallback.content } });
      onEvent({
        event: 'done',
        data: { conversationId: fallback.conversationId, messageId: fallback.messageId, tokenCount: fallback.tokenCount },
      });
      return;
    }

    // ── Conversation setup (same as chat()) ──
    let conversationId = request.conversationId;
    let conversation;

    if (conversationId) {
      conversation = await db.aiConversation.findUnique({
        where: { id: conversationId },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      });
    }

    if (!conversation) {
      conversation = await db.aiConversation.create({
        data: {
          id: nanoid(),
          title: request.message.slice(0, 80) || 'New conversation',
          type: request.type ?? 'chat',
          nodeId: request.nodeId ?? null,
          createdBy: request.createdBy ?? 'system',
        },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      });
    }
    conversationId = conversation.id;

    // Save user message
    await db.aiMessage.create({
      data: {
        id: nanoid(),
        conversationId,
        role: 'user',
        content: request.message,
      },
    });

    // Build system prompt and message history
    const activeModel = aiSettings.model || profile.model;
    const maxToolRounds = request.maxToolRounds ?? aiSettings.maxToolRounds ?? profile.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const memories = await getMemoriesAsContext();
    const systemPrompt = buildSystemPrompt({
      memories,
      fleetStatus: request.fleetContext,
      anomalies: request.anomalyContext,
      controllerContext: request.controllerContext,
      userContext: request.userInfo
        ? [request.userInfo.email ? `Email: ${request.userInfo.email}` : null, request.userInfo.username ? `Username: ${request.userInfo.username}` : null, request.userInfo.role ? `Role: ${request.userInfo.role}` : null]
          .filter(Boolean)
          .join('\n')
        : undefined,
      scratchpadContext: request.replMode ? getScratchpadAsContext(conversationId) ?? undefined : undefined,
      replMode: request.replMode,
    });

    const messages: LlmMessage[] = [{ role: 'system', content: systemPrompt }];

    // Add conversation history (sliding window)
    const historyMessages = conversation.messages.slice(-30);
    for (const msg of historyMessages) {
      if (msg.role === 'system') continue;
      messages.push({ role: msg.role as LlmMessage['role'], content: msg.content });
    }

    const userStreamMsg: LlmMessage = { role: 'user', content: request.message };
    if (request.attachments?.length) {
      userStreamMsg.images = request.attachments
        .filter((a) => a.type === 'image')
        .map((a) => ({ type: 'image' as const, data: a.data, mimeType: a.mimeType }));
    }
    messages.push(userStreamMsg);

    const allTools = getOllamaToolDefinitions();
    const config = await getToolConfig();
    const disabledSet = new Set(config.filter((entry) => !entry.enabled).map((entry) => entry.name));
    const tools = disabledSet.size > 0
      ? allTools.filter((tool) => !disabledSet.has(tool.function.name))
      : allTools;
    const approvalPolicy = await getToolApprovalPolicy();
    let totalTokens = 0;
    let finalContent = '';
    let finalThinking = '';
    const allToolResults: AiToolResult[] = [];
    const seenToolCallSignatures = new Set<string>();
    const knownTools = new Set(listAvailableTools());
    let previousComparableResponse = '';

    // ── Multi-round tool calling loop with streaming ──
    for (let round = 1; round <= maxToolRounds; round++) {
      onEvent({ event: 'thinking', data: { round, status: `Calling AI model (round ${round})...` } });

      const reasoningInstruction = getThinkingInstruction(
        (await getOllamaThinkingCapability(OLLAMA_BASE_URL, activeModel))
          ? (request.thinkingMode ?? aiSettings.thinkingMode ?? profile.thinkingMode ?? 'standard')
          : 'off',
      );
      const streamingMessages = reasoningInstruction
        ? [{ role: 'system', content: reasoningInstruction } satisfies LlmMessage, ...messages]
        : messages;

      // Call Ollama with streaming
      const streamResponse = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: activeModel,
          messages: streamingMessages,
          tools: round <= maxToolRounds ? tools : undefined,
          stream: true,
          options: {
            temperature: profile.temperature,
            num_predict: profile.maxTokens,
          },
        }),
      });

      if (!streamResponse.ok || !streamResponse.body) {
        onEvent({ event: 'error', data: { message: `Ollama returned ${streamResponse.status}` } });
        return;
      }

      // Read NDJSON stream
      const reader = streamResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let roundContent = '';
      let roundThinking = '';
      let nativeToolCalls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line);
            if (chunk.message?.thinking) {
              roundThinking += chunk.message.thinking;
              onEvent({ event: 'thinking_token', data: { text: chunk.message.thinking, round } });
            }
            if (chunk.message?.content) {
              roundContent += chunk.message.content;
              onEvent({ event: 'token', data: { text: chunk.message.content } });
            }
            if (chunk.message?.tool_calls) {
              nativeToolCalls = chunk.message.tool_calls;
            }
            if (chunk.eval_count) {
              totalTokens += chunk.eval_count;
            }
          } catch { /* skip malformed lines */ }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const chunk = JSON.parse(buffer);
          if (chunk.message?.thinking) {
            roundThinking += chunk.message.thinking;
            onEvent({ event: 'thinking_token', data: { text: chunk.message.thinking, round } });
          }
          if (chunk.message?.content) {
            roundContent += chunk.message.content;
            onEvent({ event: 'token', data: { text: chunk.message.content } });
          }
          if (chunk.message?.tool_calls) nativeToolCalls = chunk.message.tool_calls;
          if (chunk.eval_count) totalTokens += chunk.eval_count;
        } catch { /* skip */ }
      }

      // Strip thinking content if present
      const thinkRegex = /<think>[\s\S]*?<\/think>/g;
      roundContent = roundContent.replace(thinkRegex, '').trim();
      finalContent = roundContent;
      if (roundThinking.trim()) {
        finalThinking = [finalThinking, roundThinking.trim()].filter(Boolean).join('\n\n---\n\n');
      }

      const comparableResponse = stripToolCallMarkup(roundContent, knownTools);
      const mappedToolCalls = nativeToolCalls.map((toolCall) => ({
        name: toolCall.function.name,
        arguments: toolCall.function.arguments ?? {},
      }));

      if (mappedToolCalls.length > 0) {
        if (hasExceededToolLoopBudget(totalTokens, profile.maxTokens, maxToolRounds)) {
          finalContent = comparableResponse || buildLoopStopSummary('I stopped requesting more tools because the tool-round token budget was reached. Here is the best answer from the data gathered so far.', allToolResults);
          break;
        }

        const repeatedToolCall = findRepeatedToolCall(mappedToolCalls, seenToolCallSignatures);
        if (repeatedToolCall) {
          finalContent = comparableResponse || buildLoopStopSummary(`I stopped requesting more tools because \`${repeatedToolCall.name}\` was requested again with the same arguments. Here is the best answer from the data gathered so far.`, allToolResults);
          break;
        }

        if (previousComparableResponse && hasStalledForwardProgress(previousComparableResponse, comparableResponse)) {
          finalContent = comparableResponse || buildLoopStopSummary('I stopped requesting more tools because the investigation stopped making forward progress. Here is the best answer from the data gathered so far.', allToolResults);
          break;
        }

        previousComparableResponse = comparableResponse;
        mappedToolCalls.forEach((call) => seenToolCallSignatures.add(getToolCallSignature(call)));
      }

      // Check for tool calls
      if (nativeToolCalls.length === 0) break; // No tools, we're done

      // Execute tool calls
      messages.push({
        role: 'assistant',
        content: roundContent,
        tool_calls: mappedToolCalls,
      });

      const toolResults: Array<{ name: string; success: boolean; result: unknown; error?: string }> = [];

      for (const tc of nativeToolCalls) {
        const toolName = tc.function.name;
        const toolArgs = tc.function.arguments;

        // Check approval policy
        if (approvalPolicy.alwaysDeny.includes(toolName)) {
          toolResults.push({ name: toolName, success: false, result: null, error: 'Tool is denied by policy' });
          continue;
        }

        if (approvalPolicy.requireApproval.includes(toolName)) {
          // Save pending approval and stop
          const approvalData = JSON.stringify({
            toolName,
            toolArgs,
            round,
            conversationId,
          });

          const msgId = nanoid();
          await db.aiMessage.create({
            data: {
              id: msgId,
              conversationId,
              role: 'assistant',
              content: finalContent || `I need to run \`${toolName}\` but it requires your approval.`,
              toolCalls: JSON.stringify(toolResults),
              thinking: finalThinking || null,
              tokenCount: totalTokens,
              pendingApproval: approvalData,
            },
          });

          onEvent({
            event: 'done',
            data: { conversationId, messageId: msgId, tokenCount: totalTokens },
          });
          return;
        }

        onEvent({ event: 'tool_start', data: { name: toolName, round } });

        const result = await executeAiTool({
          name: toolName,
          arguments: {
            ...toolArgs,
            _conversationId: conversationId,
          },
        });
        toolResults.push(result);
        allToolResults.push(result);

        onEvent({
          event: 'tool_result',
          data: { name: toolName, success: result.success, result: result.result },
        });

        if (request.replMode && result.success) {
          autoStoreToolResult(conversationId, toolName, result.result);
          onEvent({
            event: 'scratchpad_update',
            data: {
              entries: listScratchpadEntries(conversationId).map((entry) => ({
                name: entry.name,
                source: entry.source,
                summary: entry.summary,
              })),
            },
          });
        }

        // If executeNaturalCommand returned a command preview, create a pending approval for execution
        if (toolName === 'executeNaturalCommand' && result.success) {
          const preview = result.result as { type?: string; command?: string; args?: string[]; nodeId?: string; nodeName?: string; requiresConfirmation?: boolean };
          if (preview?.type === 'commandPreview' && preview.requiresConfirmation !== false) {
            const approvalData = JSON.stringify({
              toolName: 'executeNaturalCommand',
              toolArgs: { ...toolArgs, _preview: { command: preview.command, args: preview.args, nodeId: preview.nodeId, nodeName: preview.nodeName } },
              round,
              conversationId,
            });

            const msgId = nanoid();
            await db.aiMessage.create({
              data: {
                id: msgId,
                conversationId,
                role: 'assistant',
                content: finalContent || `I'd like to run \`${preview.command} ${(preview.args ?? []).join(' ')}\` on **${preview.nodeName}**. Please confirm to proceed.`,
                toolCalls: JSON.stringify(toolResults),
                thinking: finalThinking || null,
                tokenCount: totalTokens,
                pendingApproval: approvalData,
              },
            });

            onEvent({
              event: 'done',
              data: { conversationId, messageId: msgId, tokenCount: totalTokens },
            });
            return;
          }
        }

        // Add tool result to messages for next round
        messages.push({
          role: 'tool',
          content: JSON.stringify({ name: toolName, result: result.result, error: result.error }),
        });
      }
    }

    // Save the final assistant message
    const messageId = nanoid();
    await db.aiMessage.create({
      data: {
        id: messageId,
        conversationId,
        role: 'assistant',
        content: finalContent,
        thinking: finalThinking || null,
        tokenCount: totalTokens,
      },
    });

    // Auto-summarize if conversation is getting long
    const messageCount = await db.aiMessage.count({ where: { conversationId } });
    if (messageCount > 20 && messageCount % 10 === 0) {
      summarizeConversation(conversationId).catch(() => {}); // fire-and-forget
    }

    onEvent({
      event: 'done',
      data: { conversationId, messageId, tokenCount: totalTokens },
    });
  } catch (err) {
    onEvent({
      event: 'error',
      data: { message: err instanceof Error ? err.message : 'Unknown streaming error' },
    });
  }
}

// ── Tool Approval Actions ──

/**
 * Approve a pending tool call and resume the conversation.
 */
export async function approveToolCall(messageId: string, actorId = 'operator'): Promise<ChatResponse | null> {
  const db = getDb();
  const message = await db.aiMessage.findUnique({ where: { id: messageId } });
  if (!message?.pendingApproval) return null;

  let approval: { toolName: string; toolArgs: Record<string, unknown>; conversationId: string };
  try {
    approval = JSON.parse(message.pendingApproval);
  } catch {
    return null;
  }

  // Clear the pending approval
  await db.aiMessage.update({
    where: { id: messageId },
    data: { pendingApproval: null },
  });

  await logAuditEvent({
    action: 'assistant.tool_approval',
    actorId,
    actorType: 'user',
    targetType: 'ai_message',
    targetId: messageId,
    details: { toolName: approval.toolName, conversationId: approval.conversationId, decision: 'approved' },
  });

  // Execute the tool
  const toolResult = await executeAiTool({
    name: approval.toolName,
    arguments: {
      ...approval.toolArgs,
      _conversationId: approval.conversationId,
    },
  });

  // Continue the conversation with the tool result
  return chat({
    conversationId: approval.conversationId,
    message: `[Tool approved and executed] ${approval.toolName}: ${JSON.stringify(toolResult.result).slice(0, 2000)}`,
    type: 'chat',
    createdBy: 'system',
  });
}

/**
 * Reject a pending tool call.
 */
export async function rejectToolCall(messageId: string, actorId = 'operator'): Promise<ChatResponse | null> {
  const db = getDb();
  const message = await db.aiMessage.findUnique({ where: { id: messageId } });
  if (!message?.pendingApproval) return null;

  let approval: { toolName: string; conversationId: string };
  try {
    approval = JSON.parse(message.pendingApproval);
  } catch {
    return null;
  }

  // Clear the pending approval
  await db.aiMessage.update({
    where: { id: messageId },
    data: { pendingApproval: null },
  });

  await logAuditEvent({
    action: 'assistant.tool_approval',
    actorId,
    actorType: 'user',
    targetType: 'ai_message',
    targetId: messageId,
    details: { toolName: approval.toolName, conversationId: approval.conversationId, decision: 'rejected' },
  });

  // Tell the AI the tool was rejected
  return chat({
    conversationId: approval.conversationId,
    message: `[Tool rejected by operator] The tool "${approval.toolName}" was denied. Please suggest an alternative approach or explain what you were trying to do.`,
    type: 'chat',
    createdBy: 'system',
  });
}
