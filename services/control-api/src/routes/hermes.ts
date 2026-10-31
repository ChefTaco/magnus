import { Hono, type Context } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { hermesJobListQuerySchema } from '../schemas/hermes.js';
import {
  getHermesApiServerStatus,
  getHermesInstallation,
  getHermesJob,
  listHermesInstallations,
  listHermesJobs,
  listHermesProfiles,
} from '../services/hermes-service.js';

export const hermesRouter = new Hono<AppVariables>();

hermesRouter.use('*', authMiddleware);

function requiredParam(c: Context<AppVariables>, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new HttpError(400, 'VALIDATION_ERROR', `${name} is required`);
  return value;
}

// Read-only inventory/status endpoints remain available because they use the
// Control database and never open SSH connections.
hermesRouter.get('/installations', async (c) =>
  c.json({ success: true, data: await listHermesInstallations() }));

hermesRouter.get('/installations/:id', async (c) => {
  const data = await getHermesInstallation(requiredParam(c, 'id'));
  if (!data) throw new HttpError(404, 'NOT_FOUND', 'Hermes installation not found');
  return c.json({ success: true, data });
});

hermesRouter.get('/installations/:id/profiles', async (c) => {
  const installation = await getHermesInstallation(requiredParam(c, 'id'));
  if (!installation) throw new HttpError(404, 'NOT_FOUND', 'Hermes installation not found');
  return c.json({ success: true, data: await listHermesProfiles(installation.id) });
});

hermesRouter.get('/profiles', async (c) =>
  c.json({ success: true, data: await listHermesProfiles() }));

hermesRouter.get('/profiles/:id/api-server/status', async (c) =>
  c.json({ success: true, data: await getHermesApiServerStatus(requiredParam(c, 'id')) }));

hermesRouter.get('/jobs', async (c) => {
  const parsed = hermesJobListQuerySchema.safeParse({
    status: c.req.query('status'),
    type: c.req.query('type'),
    category: c.req.query('category'),
    installationId: c.req.query('installationId'),
    profileId: c.req.query('profileId'),
    limit: c.req.query('limit'),
  });
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION_ERROR', parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  return c.json({ success: true, data: await listHermesJobs(parsed.data) });
});

hermesRouter.get('/jobs/:id', async (c) => {
  const data = await getHermesJob(requiredParam(c, 'id'));
  if (!data) throw new HttpError(404, 'NOT_FOUND', 'Hermes operation job not found');
  return c.json({ success: true, data });
});

// SSH-backed detection, deployment, config, profile, gateway, dashboard,
// migration, and credential-bearing operations are retired until every call
// can use an inventory-pinned host key or the authenticated agent API.
hermesRouter.all('*', (c) => c.json({
  success: false,
  error: {
    code: 'HERMES_SSH_OPERATION_RETIRED',
    message: 'SSH-backed Hermes operations are retired; use the reviewed key-only host runbook',
  },
}, 410));
