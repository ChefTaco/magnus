import { Hono } from 'hono';
import { pagination } from '../utils/query.js';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { logAuditEvent } from '../services/audit-service.js';
import { HttpError } from '../middleware/error-handler.js';
import {
  listWebhookEndpoints,
  getWebhookEndpoint,
  createWebhookEndpoint,
  updateWebhookEndpoint,
  deleteWebhookEndpoint,
  listDeliveries,
  testWebhookEndpoint,
  dispatchWebhook,
  redeliverWebhookDelivery,
} from '../services/webhook-service.js';
import { validateWebhookTarget, WebhookOriginNotAllowedError } from '../services/webhook-security.js';
import { z } from 'zod';
import { parseBody } from '../utils/validate.js';

/** Audit only the target origin: webhook paths and queries often embed tokens. */
function webhookOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return 'invalid'; }
}

/** Refused targets stay indistinguishable, so this cannot probe DNS or internal addresses. Only the allowlist is explained. */
async function assertApprovedTarget(url: string): Promise<void> {
  try {
    await validateWebhookTarget(url);
  } catch (error) {
    if (error instanceof WebhookOriginNotAllowedError) throw new HttpError(400, 'VALIDATION_ERROR', error.message);
    throw new HttpError(400, 'VALIDATION_ERROR', 'Webhook target is not an approved public HTTPS endpoint');
  }
}

const webhookFields = {
  name: z.string().trim().min(1, 'name is required').max(200),
  url: z.string().trim().min(1, 'url is required').max(2048),
  type: z.string().min(1).max(64),
  events: z.array(z.string().min(1).max(200)).max(100),
  headers: z.record(z.string().max(256), z.string().max(4096)),
  retries: z.number().int().min(0).max(10),
  timeoutMs: z.number().int().min(1_000).max(60_000),
};
const webhookCreateSchema = z.object({
  name: webhookFields.name, url: webhookFields.url, type: webhookFields.type.optional(),
  secret: z.string().min(1).max(4096).optional(), events: webhookFields.events.optional(),
  headers: webhookFields.headers.optional(), retries: webhookFields.retries.optional(), timeoutMs: webhookFields.timeoutMs.optional(),
});
const webhookUpdateSchema = z.object({
  name: webhookFields.name.optional(), url: webhookFields.url.optional(), type: webhookFields.type.optional(),
  secret: z.string().min(1).max(4096).nullable().optional(), events: webhookFields.events.optional(),
  headers: webhookFields.headers.optional(), active: z.boolean().optional(),
  retries: webhookFields.retries.optional(), timeoutMs: webhookFields.timeoutMs.optional(),
});

/** Drop keys a client left out, so `Object.keys(body)` lists only the fields it changed. */
type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] }
  & { [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> };
function stripUndefined<T extends Record<string, unknown>>(value: T): Defined<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Defined<T>;
}

export const webhooksRouter = new Hono<AppVariables>();

// All webhook routes require ADMIN role
webhooksRouter.use('*', authMiddleware);
webhooksRouter.use('*', requireRole('ADMIN'));

// ── List all webhook endpoints ──
webhooksRouter.get('/', async (c) => {
  const endpoints = await listWebhookEndpoints();
  return c.json({ success: true, data: { endpoints } });
});

// ── Get a specific webhook endpoint ──
webhooksRouter.get('/:id', async (c) => {
  const endpoint = await getWebhookEndpoint(c.req.param('id'));
  if (!endpoint) throw new HttpError(404, 'NOT_FOUND', 'Webhook endpoint not found');
  return c.json({ success: true, data: { endpoint } });
});

// ── Create a webhook endpoint ──
webhooksRouter.post('/', async (c) => {
  const body = stripUndefined(await parseBody(c, webhookCreateSchema));

  await assertApprovedTarget(body.url);

  const user = c.get('user');
  const endpoint = await createWebhookEndpoint({
    ...body,
    createdBy: user?.userId ?? user?.email ?? 'system',
  });
  await logAuditEvent({
    action: 'webhook.create', actorId: getUser(c).userId, targetType: 'webhook',
    targetId: (endpoint as { id?: string }).id ?? 'unknown',
    details: { name: body.name, type: body.type ?? 'generic', origin: webhookOrigin(body.url), events: body.events ?? [],
      secretConfigured: Boolean(body.secret), headersConfigured: Object.keys(body.headers ?? {}).length > 0 },
  });
  return c.json({ success: true, data: { endpoint } }, 201);
});

// ── Update a webhook endpoint ──
webhooksRouter.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await getWebhookEndpoint(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Webhook endpoint not found');

  const body = stripUndefined(await parseBody(c, webhookUpdateSchema));

  if (body.url !== undefined) await assertApprovedTarget(body.url);

  const endpoint = await updateWebhookEndpoint(id, body);
  // Record which fields changed, never secret or header values.
  await logAuditEvent({
    action: 'webhook.update', actorId: getUser(c).userId, targetType: 'webhook', targetId: id,
    details: { changedFields: Object.keys(body).sort(),
      ...(body.url !== undefined && { origin: webhookOrigin(body.url) }),
      ...(body.active !== undefined && { active: body.active }),
      ...(body.events !== undefined && { events: body.events }) },
  });
  return c.json({ success: true, data: { endpoint } });
});

// ── Delete a webhook endpoint ──
webhooksRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await getWebhookEndpoint(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Webhook endpoint not found');

  await deleteWebhookEndpoint(id);
  await logAuditEvent({ action: 'webhook.delete', actorId: getUser(c).userId, targetType: 'webhook', targetId: id,
    details: { name: (existing as { name?: string }).name ?? null } });
  return c.json({ success: true, data: { success: true } });
});

// ── List deliveries for an endpoint ──
webhooksRouter.get('/:id/deliveries', async (c) => {
  const id = c.req.param('id');
  const existing = await getWebhookEndpoint(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Webhook endpoint not found');

  const { page, pageSize } = pagination(c, { pageSize: 20, maxPageSize: 200 });

  const result = await listDeliveries(id, page, pageSize);
  return c.json({ success: true, data: result });
});

// ── Test a webhook endpoint ──
webhooksRouter.post('/:id/test', async (c) => {
  const result = await testWebhookEndpoint(c.req.param('id'));
  await logAuditEvent({ action: 'webhook.test', actorId: getUser(c).userId, targetType: 'webhook',
    targetId: c.req.param('id'), details: { success: result.success } });
  return c.json({ success: true, data: result }, result.success ? 200 : 502);
});

// ── Redeliver a failed webhook delivery ──
webhooksRouter.post('/:id/deliveries/:deliveryId/redeliver', async (c) => {
  const endpointId = c.req.param('id');
  const deliveryId = c.req.param('deliveryId');

  const endpoint = await getWebhookEndpoint(endpointId);
  if (!endpoint) throw new HttpError(404, 'NOT_FOUND', 'Webhook endpoint not found');

  const result = await redeliverWebhookDelivery(endpointId, deliveryId);
  if (!result) throw new HttpError(404, 'NOT_FOUND', 'Delivery not found');
  await logAuditEvent({ action: 'webhook.redeliver', actorId: getUser(c).userId, targetType: 'webhook',
    targetId: endpointId, details: { deliveryId, newDeliveryId: result } });

  return c.json({ success: true, data: { deliveryId: result } });
});

// ── Dispatch a webhook event (system/external callers) ──
webhooksRouter.post('/dispatch', async (c) => {
  const body = await parseBody(c, z.object({ event: z.string().min(1).max(200), payload: z.record(z.string(), z.unknown()).optional() }));
  await dispatchWebhook(body.event, body.payload ?? {});
  await logAuditEvent({ action: 'webhook.dispatch', actorId: getUser(c).userId, targetType: 'webhook',
    targetId: body.event, details: { event: body.event } });
  return c.json({ success: true }, 202);
});
