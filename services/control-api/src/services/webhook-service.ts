import { recordMonitorPulse } from './monitor-pulse.js';
import { redactUnknown } from '../utils/redact.js';
import { createHmac, randomBytes, createCipheriv } from 'node:crypto';
import { nanoid } from 'nanoid';
import { Queue, Worker, type Job } from 'bullmq';
import { addDurableJob } from '../queue/requeue.js';
import { getDb, type Prisma } from '../db/index.js';
import {
  isEncryptedWebhookCredential,
  decryptWebhookCredential,
  encryptWebhookCredential,
  postWebhook,
  validateWebhookTarget,
} from './webhook-security.js';

// ─── Webhook Service — dispatch, deliver, retry ───

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
const REDIS_PREFIX = process.env['REDIS_PREFIX'] ?? 'magnus-';
const WEBHOOK_QUEUE = `${REDIS_PREFIX}webhooks`;
const PROTECTED_HEADERS = new Set([
  'connection', 'content-length', 'host', 'transfer-encoding', 'user-agent',
  'x-magnus-delivery', 'x-magnus-encrypted', 'x-magnus-event', 'x-magnus-signature',
]);

let dispatchTimer: ReturnType<typeof setInterval> | undefined;
let dispatchBusy = false;

let _webhookQueue: Queue | null = null;
let _webhookWorker: Worker<WebhookJobPayload> | null = null;

/** Get the singleton webhook queue instance. */
export function getWebhookQueue(): Queue {
  if (!_webhookQueue) {
    _webhookQueue = new Queue(WEBHOOK_QUEUE, { connection: { url: REDIS_URL } });
  }
  return _webhookQueue;
}

export async function closeWebhookQueue(): Promise<void> {
  if (dispatchTimer) clearInterval(dispatchTimer);
  dispatchTimer = undefined;
  if (_webhookWorker) {
    await _webhookWorker.close();
    _webhookWorker = null;
  }
  if (_webhookQueue) {
    await _webhookQueue.close();
    _webhookQueue = null;
  }
}

export interface WebhookJobPayload {
  endpointId: string;
}

export function createWebhookJobPayload(endpointId: string): WebhookJobPayload {
  return { endpointId };
}

/**
 * Dispatch a webhook event to all matching active endpoints.
 * Enqueues deliveries to BullMQ for async processing with retries.
 */
/** Called in the same transaction as the notification. These pending rows are
 * the delivery outbox, so a crash before Redis insertion cannot lose an alert. */
export async function createWebhookDeliveries(tx: Prisma.TransactionClient, event: string, payload: Record<string, unknown>): Promise<void> {
  const endpoints = await tx.webhookEndpoint.findMany({ where: { active: true } });
  for (const ep of endpoints) {
    const events: string[] = JSON.parse(ep.events || '[]');
    if (events.length && !events.some(pattern => eventMatches(event, pattern))) continue;
    await tx.webhookDelivery.create({ data: { id: nanoid(), endpointId: ep.id, event,
      payload: JSON.stringify(payload), status: 'pending' } });
  }
}

export async function reconcileWebhookDeliveries(): Promise<void> {
  const pending = await getDb().webhookDelivery.findMany({
    where: { status: 'pending', attempts: 0, endpoint: { active: true } },
    include: { endpoint: true }, orderBy: { createdAt: 'asc' }, take: 1000,
  });
  for (const delivery of pending) {
    // Only a completed job (e.g. skipped while its endpoint was inactive) is
    // replaced; failed jobs are finalized by the worker's failure bookkeeping.
    await addDurableJob(getWebhookQueue(), 'deliver', createWebhookJobPayload(delivery.endpointId), {
      jobId: delivery.id,
      attempts: delivery.endpoint.type === 'mattermost' ? 1 : Math.max(1, Math.min(11, delivery.endpoint.retries + 1)),
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 86400, count: 10000 }, removeOnFail: { age: 604800, count: 10000 },
    }, ['completed']);
  }
}

export async function dispatchWebhook(event: string, payload: Record<string, unknown>): Promise<void> {
  await getDb().$transaction(tx => createWebhookDeliveries(tx, event, payload));
  // The periodic dispatcher owns recovery; callers only depend on durable storage.
}

/** Check if an event string matches a pattern (supports * wildcard). */
function eventMatches(event: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern === event) return true;
  // Support prefix wildcards: "node.*" matches "node.offline"
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    return event.startsWith(prefix + '.');
  }
  return false;
}

/** Sign a payload with HMAC-SHA256. */
function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Encrypt a payload using AES-256-GCM.
 * Returns Base64 envelope: iv (12B) + ciphertext + authTag (16B).
 * The recipient derives the 256-bit key from the shared secret via SHA-256.
 */
function encryptPayload(payload: string, secret: string): string {
  const key = Buffer.from(createHmac('sha256', 'magnus-webhook-enc').update(secret).digest());
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]).toString('base64');
}

function parseStoredHeaders(endpointId: string, stored: string): Record<string, string> {
  const plaintext = decryptWebhookCredential(stored, endpointId, 'headers');
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error('Webhook headers contain invalid encrypted JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Webhook headers must decrypt to an object');
  }
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(parsed)) {
    const name = rawName.trim().toLowerCase();
    if (!name || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || PROTECTED_HEADERS.has(name)) {
      throw new Error('Webhook headers contain a forbidden header name');
    }
    if (typeof rawValue !== 'string' || rawValue.length > 8_192) {
      throw new Error('Webhook headers contain an invalid value');
    }
    headers[name] = rawValue;
  }
  if (Object.keys(headers).length > 32) throw new Error('Webhook headers exceed the configured limit');
  return headers;
}

function encryptedSecret(endpoint: { id: string; secret: string | null }): string | null {
  return endpoint.secret === null
    ? null
    : decryptWebhookCredential(endpoint.secret, endpoint.id, 'secret');
}

export function redactWebhookEndpoint<T extends {
  id: string;
  secret: string | null;
  headers: string;
  url?: string;
}>(endpoint: T): Omit<T, 'secret' | 'headers'> & {
  secretConfigured: boolean;
  headersConfigured: boolean;
} {
  const secret = encryptedSecret(endpoint);
  const headers = parseStoredHeaders(endpoint.id, endpoint.headers);
  const safe = { ...endpoint } as Omit<T, 'secret' | 'headers'> & Partial<Pick<T, 'secret' | 'headers'>>;
  delete safe.secret;
  delete safe.headers;
  return {
    ...safe,
    ...(endpoint.url ? { url: new URL(webhookUrl(endpoint as { id: string; url: string })).origin, urlConfigured: true } : {}),
    secretConfigured: Boolean(secret),
    headersConfigured: Object.keys(headers).length > 0,
  };
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const temporaryEnvelope = encryptWebhookCredential(JSON.stringify(headers), 'validation', 'headers');
  return parseStoredHeaders('validation', temporaryEnvelope);
}

function normalizeDeliveryOptions(retries = 3, timeoutMs = 10_000): { retries: number; timeoutMs: number } {
  if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
    throw new Error('Webhook retries must be an integer between 0 and 10');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error('Webhook timeoutMs must be an integer between 1000 and 60000');
  }
  return { retries, timeoutMs };
}

/** Format payload for Slack/Discord integrations. */
export function formatPayload(type: string, event: string, payload: string): { body: string; contentType: string } {
  const data = JSON.parse(payload);

  // Mattermost-compatible incoming webhook: redacted text, delivered at most once.
  if (type === 'mattermost') {
    const clean = (value: unknown) => String(redactUnknown(value) ?? '').replace(/@[a-z0-9_]+/gi, '[mention]').replace(/(?:https?:\/\/)[^\s]+/g, '[link omitted]').replace(/(?:password|token|secret|authorization)\s*[:=]\s*\S+/gi, '[credential omitted]').slice(0, 2000);
    const origin = process.env['DASHBOARD_PUBLIC_ORIGIN'];
    let link = '';
    if (origin) { try { const parsed = new URL(origin); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) link = `${parsed.origin}/incidents`; } catch { /* no link */ } }
    return { body: JSON.stringify({ text: `[Magnus] ${clean(event)} · ${clean(data.severity)}\n${clean(data.title)}\n${clean(data.message)}\nObserved: ${clean(data.createdAt ?? data.timestamp)}${link ? `\nReview: ${link}` : ''}` }), contentType: 'application/json' };
  }

  if (type === 'slack') {
    return {
      body: JSON.stringify({
        text: `*[Magnus]* ${event}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${event}*\n${data.title ?? data.message ?? JSON.stringify(data)}`,
            },
          },
        ],
      }),
      contentType: 'application/json',
    };
  }

  if (type === 'discord') {
    return {
      body: JSON.stringify({
        content: `**[Magnus]** ${event}`,
        embeds: [
          {
            title: data.title ?? event,
            description: data.message ?? JSON.stringify(data),
            color: data.severity === 'critical' ? 0xff0000 : data.severity === 'warning' ? 0xffaa00 : 0x00e5ff,
          },
        ],
      }),
      contentType: 'application/json',
    };
  }

  // Generic
  return {
    body: payload,
    contentType: 'application/json',
  };
}

/** Persist the non-replayable attempt before any Mattermost POST. A stalled
 * queue job after process loss cannot post the same delivery a second time. */
export async function claimMattermostAttempt(deliveryId: string): Promise<boolean> {
  const claimed = await getDb().webhookDelivery.updateMany({ where: { id: deliveryId, status: 'pending' }, data: { status: 'sending', attempts: 1 } });
  return claimed.count === 1;
}

/** Start the webhook delivery worker. */
export function startWebhookWorker(): Worker<WebhookJobPayload> {
  if (_webhookWorker) return _webhookWorker;
  // Force the dedicated at-rest key to be present before accepting queued work.
  encryptWebhookCredential('', 'startup-check', 'secret');
  const worker = new Worker<WebhookJobPayload>(
    WEBHOOK_QUEUE,
    async (job: Job<WebhookJobPayload>) => {
      const db = getDb();
      const deliveryId = job.id;
      if (!deliveryId) throw new Error('Webhook delivery job is missing its delivery ID');
      const delivery = await db.webhookDelivery.findUnique({
        where: { id: deliveryId },
        include: { endpoint: true },
      });
      if (!delivery) return;
      if (delivery.endpointId !== job.data.endpointId) {
        throw new Error('Webhook delivery endpoint binding mismatch');
      }
      const endpoint = delivery.endpoint;
      if (!endpoint.active || delivery.status === 'success') return;
      const secret = encryptedSecret(endpoint);
      const extraHeaders = parseStoredHeaders(endpoint.id, endpoint.headers);
      const shouldEncrypt = extraHeaders['x-magnus-encrypt'] === 'true';
      delete extraHeaders['x-magnus-encrypt'];

      const { body: rawBody, contentType } = formatPayload(endpoint.type, delivery.event, delivery.payload);

      // Optionally encrypt the payload with AES-256-GCM
      const encrypted = shouldEncrypt && secret !== null && endpoint.type === 'generic';
      const body = encrypted ? encryptPayload(rawBody, secret) : rawBody;

      const headers: Record<string, string> = {
        ...extraHeaders,
        'Content-Type': encrypted ? 'application/octet-stream' : contentType,
        'User-Agent': 'Magnus-Webhook/1.0',
        'X-Magnus-Event': delivery.event,
        'X-Magnus-Delivery': deliveryId,
        ...(encrypted && { 'X-Magnus-Encrypted': 'aes-256-gcm' }),
      };

      if (secret) {
        headers['X-Magnus-Signature'] = `sha256=${signPayload(body, secret)}`;
      }

      if (endpoint.type === 'mattermost' && !(await claimMattermostAttempt(deliveryId))) return;
      try {
        const res = await postWebhook(webhookUrl(endpoint), { headers, body, timeoutMs: endpoint.timeoutMs });
        const attempt = job.attemptsMade + 1;

        await db.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            status: res.ok ? 'success' : 'failed',
            httpStatus: res.status,
            response: res.responseBody,
            attempts: attempt,
            deliveredAt: res.ok ? new Date() : undefined,
            error: res.ok ? null : `HTTP ${res.status}`,
          },
        });
        if (!res.ok) throw new Error(`Webhook delivery failed with HTTP ${res.status}`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        await db.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            status: 'failed',
            attempts: job.attemptsMade + 1,
            error: errorMsg,
          },
        });
        throw err;
      }
    },
    {
      connection: { url: REDIS_URL },
      concurrency: 5,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`[webhook-worker] Job ${job?.id} failed: ${err.message}`);
    if (job?.id && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void getDb().webhookDelivery.updateMany({ where: { id: job.id, status: 'pending' },
        data: { status: 'failed', error: 'Delivery validation or queue attempt failed', attempts: job.attemptsMade },
      }).catch(() => console.error('[webhook] failed-attempt bookkeeping pending'));
    }
  });

  const dispatch = async () => {
    if (dispatchBusy) return;
    dispatchBusy = true;
    try { await reconcileWebhookDeliveries(); recordMonitorPulse('webhooks'); }
    catch { console.error('[webhook] durable dispatch pending'); }
    finally { dispatchBusy = false; }
  };
  void dispatch();
  dispatchTimer = setInterval(() => void dispatch(), 2000);
  dispatchTimer.unref();
  _webhookWorker = worker;
  return worker;
}

export function webhookUrl(endpoint: { id: string; url: string }): string {
  return isEncryptedWebhookCredential(endpoint.url) ? decryptWebhookCredential(endpoint.url, endpoint.id, 'url') : endpoint.url;
}

// ─── CRUD helpers ───

export async function listWebhookEndpoints(): Promise<unknown[]> {
  const db = getDb();
  const endpoints = await db.webhookEndpoint.findMany({
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { deliveries: true } } },
  });
  return endpoints.map(redactWebhookEndpoint);
}

export async function getWebhookEndpoint(id: string): Promise<unknown> {
  const db = getDb();
  const endpoint = await db.webhookEndpoint.findUnique({
    where: { id },
    include: { _count: { select: { deliveries: true } } },
  });
  return endpoint ? redactWebhookEndpoint(endpoint) : null;
}

export async function createWebhookEndpoint(data: {
  name: string;
  url: string;
  type?: string;
  secret?: string;
  events?: string[];
  headers?: Record<string, string>;
  retries?: number;
  timeoutMs?: number;
  createdBy?: string;
}): Promise<unknown> {
  const db = getDb();
  const id = nanoid();
  if (!['generic','slack','discord','mattermost'].includes(data.type ?? 'generic')) throw new Error('Unsupported webhook format');
  await validateWebhookTarget(data.url);
  const headers = normalizeHeaders(data.headers ?? {});
  const { retries, timeoutMs } = normalizeDeliveryOptions(data.retries, data.timeoutMs);
  const endpoint = await db.webhookEndpoint.create({
    data: {
      id,
      name: data.name,
      url: encryptWebhookCredential(data.url, id, 'url'),
      type: data.type ?? 'generic',
      secret: data.secret === undefined ? null : encryptWebhookCredential(data.secret, id, 'secret'),
      events: JSON.stringify(data.events ?? []),
      headers: encryptWebhookCredential(JSON.stringify(headers), id, 'headers'),
      retries,
      timeoutMs,
      createdBy: data.createdBy ?? null,
    },
  });
  return redactWebhookEndpoint(endpoint);
}

export async function updateWebhookEndpoint(
  id: string,
  data: Partial<{
    name: string;
    url: string;
    type: string;
    secret: string | null;
    events: string[];
    headers: Record<string, string>;
    active: boolean;
    retries: number;
    timeoutMs: number;
  }>,
): Promise<unknown> {
  const db = getDb();
  const current = await db.webhookEndpoint.findUnique({ where: { id } });
  if (!current) return null;

  const updateData: Record<string, unknown> = {};
  if (data.name !== undefined) updateData['name'] = data.name;
  if (data.url !== undefined) {
    await validateWebhookTarget(data.url);
    updateData['url'] = encryptWebhookCredential(data.url, id, 'url');
  }
  if (data.type !== undefined) {
    if (!['generic','slack','discord','mattermost'].includes(data.type)) throw new Error('Unsupported webhook format');
    updateData['type'] = data.type;
  }
  if (data.secret !== undefined) {
    updateData['secret'] = data.secret === null ? null : encryptWebhookCredential(data.secret, id, 'secret');
  }
  if (data.events !== undefined) updateData['events'] = JSON.stringify(data.events);
  if (data.headers !== undefined) {
    const headers = normalizeHeaders(data.headers);
    updateData['headers'] = encryptWebhookCredential(JSON.stringify(headers), id, 'headers');
  }
  if (data.active !== undefined) updateData['active'] = data.active;
  if (data.retries !== undefined || data.timeoutMs !== undefined) {
    const options = normalizeDeliveryOptions(data.retries ?? current.retries, data.timeoutMs ?? current.timeoutMs);
    updateData['retries'] = options.retries;
    updateData['timeoutMs'] = options.timeoutMs;
  }

  const endpoint = await db.webhookEndpoint.update({ where: { id }, data: updateData });
  return redactWebhookEndpoint(endpoint);
}

export async function deleteWebhookEndpoint(id: string): Promise<void> {
  const db = getDb();
  await db.webhookEndpoint.delete({ where: { id } });
}

export async function listDeliveries(
  endpointId: string,
  page = 1,
  pageSize = 20,
): Promise<{ deliveries: unknown[]; total: number }> {
  const db = getDb();
  const skip = (page - 1) * pageSize;

  const [deliveries, total] = await Promise.all([
    db.webhookDelivery.findMany({
      where: { endpointId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
    }),
    db.webhookDelivery.count({ where: { endpointId } }),
  ]);

  return { deliveries, total };
}

export async function testWebhookEndpoint(id: string): Promise<{ success: boolean; error?: string }> {
  const db = getDb();
  const endpoint = await db.webhookEndpoint.findUnique({ where: { id } });
  if (!endpoint) return { success: false, error: 'Endpoint not found' };

  try {
    const testPayload = {
      event: 'webhook.test',
      message: 'This is a test webhook delivery from Magnus',
      timestamp: new Date().toISOString(),
    };

    const { body: rawBody, contentType } = formatPayload(endpoint.type, 'webhook.test', JSON.stringify(testPayload));
    const secret = encryptedSecret(endpoint);
    const extraHeaders = parseStoredHeaders(endpoint.id, endpoint.headers);
    const shouldEncrypt = extraHeaders['x-magnus-encrypt'] === 'true';
    delete extraHeaders['x-magnus-encrypt'];
    const encrypted = shouldEncrypt && secret !== null && endpoint.type === 'generic';
    const body = encrypted ? encryptPayload(rawBody, secret) : rawBody;

    const headers: Record<string, string> = {
      ...extraHeaders,
      'Content-Type': encrypted ? 'application/octet-stream' : contentType,
      'User-Agent': 'Magnus-Webhook/1.0',
      'X-Magnus-Event': 'webhook.test',
      ...(encrypted && { 'X-Magnus-Encrypted': 'aes-256-gcm' }),
    };

    if (secret) {
      headers['X-Magnus-Signature'] = `sha256=${signPayload(body, secret)}`;
    }

    const res = await postWebhook(webhookUrl(endpoint), { headers, body, timeoutMs: endpoint.timeoutMs });
    return { success: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

/**
 * Redeliver a failed webhook delivery by re-enqueuing it.
 * Returns the new delivery ID, or null if the original delivery was not found.
 */
export async function redeliverWebhookDelivery(endpointId: string, deliveryId: string): Promise<string | null> {
  const db = getDb();
  const delivery = await db.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { endpoint: true },
  });
  if (!delivery || delivery.endpointId !== endpointId) return null;

  const ep = delivery.endpoint;

  // Create a new delivery record for the redeliver attempt
  const newDelivery = await db.webhookDelivery.create({
    data: {
      id: nanoid(),
      endpointId: ep.id,
      event: delivery.event,
      payload: delivery.payload,
      status: 'pending',
    },
  });

  return newDelivery.id;
}
