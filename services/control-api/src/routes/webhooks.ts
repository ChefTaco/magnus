import { Hono } from 'hono';
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
import { validateWebhookTarget } from '../services/webhook-security.js';

/** Audit only the target origin: webhook paths and queries often embed tokens. */
function webhookOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return 'invalid'; }
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
  const body = await c.req.json<{
    name: string;
    url: string;
    type?: string;
    secret?: string;
    events?: string[];
    headers?: Record<string, string>;
    retries?: number;
    timeoutMs?: number;
  }>();

  if (!body.name || !body.url) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'name and url are required');
  }

  try {
    await validateWebhookTarget(body.url);
  } catch {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Webhook target is not an approved public HTTPS endpoint');
  }

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

  const body = await c.req.json<Partial<{
    name: string;
    url: string;
    type: string;
    secret: string | null;
    events: string[];
    headers: Record<string, string>;
    active: boolean;
    retries: number;
    timeoutMs: number;
  }>>();

  if (body.url !== undefined) {
    try {
      await validateWebhookTarget(body.url);
    } catch {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Webhook target is not an approved public HTTPS endpoint');
    }
  }

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

  const page = parseInt(c.req.query('page') ?? '1', 10);
  const pageSize = parseInt(c.req.query('pageSize') ?? '20', 10);

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
  const body = await c.req.json<{ event?: string; payload?: Record<string, unknown> }>();
  if (!body.event) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'event is required');
  }
  await dispatchWebhook(body.event, body.payload ?? {});
  await logAuditEvent({ action: 'webhook.dispatch', actorId: getUser(c).userId, targetType: 'webhook',
    targetId: body.event, details: { event: body.event } });
  return c.json({ success: true }, 202);
});
