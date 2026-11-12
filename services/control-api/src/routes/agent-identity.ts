import { Hono, type Context } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, getUser } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { findAgentIdentityByActorId, resolveAgentIdentity, type AgentIdentityAccess } from '../services/agent-identity.js';

/**
 * Agent identity reads, mounted at /api/v1/agents. Any role may read them, as it
 * may read nodes and Hermes profiles. Ardent profiles stay ADMIN-only, as on the
 * Ardent routes: for anyone else they answer as unknown. Authentication is
 * per route, because /agents/upgrade has its own router under the same prefix.
 */
export const agentIdentityRouter = new Hono<AppVariables>();

function access(c: Context<AppVariables>): AgentIdentityAccess {
  return { ardent: getUser(c).role === 'ADMIN' };
}

agentIdentityRouter.get('/identity', authMiddleware, async c => {
  const actorId = c.req.query('actorId');
  const found = await findAgentIdentityByActorId(actorId ?? '', access(c));
  if (!found) throw new HttpError(404, 'NOT_FOUND', 'No agent has that actor ID');
  return c.json({ success: true, data: found });
});

agentIdentityRouter.get('/:agentRef/identity', authMiddleware, async c => {
  const found = await resolveAgentIdentity(c.req.param('agentRef') ?? '', access(c));
  if (!found) throw new HttpError(404, 'NOT_FOUND', 'Agent not found');
  return c.json({ success: true, data: found });
});
