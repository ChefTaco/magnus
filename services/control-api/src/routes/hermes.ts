import { optional } from '../utils/optional.js';
import { Hono, type Context } from 'hono';
import type { AppVariables, UserRole } from '../types/index.js';
import { authMiddleware, getUser } from '../middleware/auth.js';
import { hermesProfileForRole } from '../services/secret-views.js';
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
function installationForRole<T extends { profiles?: Array<{ apiServerKeyFingerprint?: string | null }> | undefined }>(installation: T, role: UserRole) {
  return installation.profiles
    ? { ...installation, profiles: installation.profiles.map((profile) => hermesProfileForRole(profile, role)) }
    : installation;
}

hermesRouter.get('/installations', async (c) => {
  const role = getUser(c).role;
  return c.json({ success: true, data: (await listHermesInstallations()).map((installation) => installationForRole(installation, role)) });
});

hermesRouter.get('/installations/:id', async (c) => {
  const data = await getHermesInstallation(requiredParam(c, 'id'));
  if (!data) throw new HttpError(404, 'NOT_FOUND', 'Hermes installation not found');
  return c.json({ success: true, data: installationForRole(data, getUser(c).role) });
});

hermesRouter.get('/installations/:id/profiles', async (c) => {
  const installation = await getHermesInstallation(requiredParam(c, 'id'));
  if (!installation) throw new HttpError(404, 'NOT_FOUND', 'Hermes installation not found');
  const role = getUser(c).role;
  return c.json({ success: true, data: (await listHermesProfiles(installation.id)).map((profile) => hermesProfileForRole(profile, role)) });
});

hermesRouter.get('/profiles', async (c) => {
  const role = getUser(c).role;
  return c.json({ success: true, data: (await listHermesProfiles()).map((profile) => hermesProfileForRole(profile, role)) });
});

hermesRouter.get('/profiles/:id/api-server/status', async (c) => {
  const { keyFingerprint, ...status } = await getHermesApiServerStatus(requiredParam(c, 'id'));
  return c.json({ success: true, data: {
    ...status,
    ...(getUser(c).role === 'ADMIN' ? { keyFingerprint } : {}),
    keyConfigured: Boolean(keyFingerprint),
  } });
});

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
  return c.json({ success: true, data: await listHermesJobs({ "limit": parsed.data.limit, ...optional("status", parsed.data.status), ...optional("type", parsed.data.type), ...optional("category", parsed.data.category), ...optional("installationId", parsed.data.installationId), ...optional("profileId", parsed.data.profileId) }) });
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
