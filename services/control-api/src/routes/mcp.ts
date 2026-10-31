import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  getDependencyHealth,
  getFleetReadiness,
  getFleetTimeline,
  getRetentionSummary,
} from '../services/ops-service.js';
import { getCodexFleetPosture } from '../services/codex-service.js';

export const mcpRouter = new Hono<AppVariables>();

const tools = [
  { name: 'magnus_dependency_health', description: 'Read Magnus dependency health checks.' },
  { name: 'magnus_fleet_readiness', description: 'Read per-node fleet readiness and stale-node posture.' },
  { name: 'magnus_fleet_timeline', description: 'Read recent fleet events from logs, commands, deploys, Hermes jobs, and audit.' },
  { name: 'magnus_retention_summary', description: 'Read retention counts and oldest known operational records.' },
  { name: 'magnus_codex_fleet_status', description: 'Read cached Codex CLI version, update, and ChatGPT OAuth posture.' },
];

mcpRouter.use('*', authMiddleware);

mcpRouter.get('/', (c) => c.json({
  name: 'magnus-readonly',
  version: '0.1.0',
  description: 'Read-only MCP-compatible Magnus fleet tools. Mutating tools are intentionally absent.',
  tools,
}));

mcpRouter.post('/', async (c) => {
  const body = await c.req.json<{ method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }>();
  if (body.method === 'tools/list') {
    return c.json({ tools });
  }
  if (body.method === 'tools/call') {
    const name = body.params?.name;
    const result =
      name === 'magnus_dependency_health' ? await getDependencyHealth() :
      name === 'magnus_fleet_readiness' ? await getFleetReadiness() :
      name === 'magnus_fleet_timeline' ? await getFleetTimeline(Number(body.params?.arguments?.['limit'] ?? 80)) :
      name === 'magnus_retention_summary' ? await getRetentionSummary() :
      name === 'magnus_codex_fleet_status' ? getCodexFleetPosture() :
      null;
    if (!result) return c.json({ error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${name}` } }, 404);
    return c.json({ content: [{ type: 'json', json: result }] });
  }
  return c.json({ error: { code: 'UNSUPPORTED_METHOD', message: 'Supported methods: tools/list, tools/call' } }, 400);
});
