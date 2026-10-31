import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, getUser } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { parseBody } from '../utils/validate.js';
import { MAGNUS_APPROVAL_BRIDGE_CONSUMER, MAGNUS_PLUGIN_API_ENABLED } from '../utils/env.js';
import { approvalAssertionSchema } from '../security/approval-assertion.js';
import { getTeamApprovalPlan, listTeamApprovalPlans, recordTeamApproval } from '../services/team-approvals.js';

export const teamApprovalRouter = new Hono<AppVariables>();
teamApprovalRouter.use('*', authMiddleware);
teamApprovalRouter.use('*', async (c, next) => {
  // Only the configured approval-bridge plugin consumer may list plans or relay decisions.
  const consumer = MAGNUS_APPROVAL_BRIDGE_CONSUMER;
  if (!MAGNUS_PLUGIN_API_ENABLED || !consumer || getUser(c).userId !== `service:magnus-plugin-read:${consumer}`)
    throw new HttpError(403, 'FORBIDDEN', 'This endpoint is restricted to the configured approval decision bridge');
  await next();
});
teamApprovalRouter.get('/plans', async c => c.json({ success: true, data: await listTeamApprovalPlans() }));
teamApprovalRouter.get('/plans/:id', async c => c.json({ success: true, data: await getTeamApprovalPlan(c.req.param('id')) }));
teamApprovalRouter.post('/decisions', async c => {
  const body = await parseBody(c, approvalAssertionSchema);
  return c.json({ success: true, data: await recordTeamApproval(body) });
});
