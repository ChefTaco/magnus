/** The HTTP surface. Bearer tokens only, HTTP streaming only, no CORS, fixed refusals. */
import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { z } from 'zod';
import { bearerToken, type Authorizer } from './authorize.js';
import { GatewayError, REFUSALS, type RefusalCode } from './errors.js';
import type { ResourceParticipant } from './participant.js';
import { SESSION_ID, type SessionManager } from './sessions.js';
import { NODE_ID } from './target.js';

/** One input request. A client chunks a larger paste, and the session applies back-pressure. */
export const MAX_INPUT_BYTES = 16 * 1024;
// JSON can spell one byte in six (\u001b), plus the envelope.
const MAX_INPUT_BODY_BYTES = MAX_INPUT_BYTES * 6 + 1024;
const MAX_CONTROL_BODY_BYTES = 1024;
const MAX_DRAIN_BODY_BYTES = 4096;

const sessionId = z.string().regex(SESSION_ID);
const cols = z.number().int().min(1).max(500);
const rows = z.number().int().min(1).max(200);
// Strict: a host, port, username, command or anything else is a refusal, not an ignored field.
const openSchema = z.object({ nodeId: z.string().regex(NODE_ID), cols: cols.default(120), rows: rows.default(30) }).strict();
const inputSchema = z.object({ sessionId, data: z.string().min(1).max(MAX_INPUT_BYTES) }).strict();
const resizeSchema = z.object({ sessionId, cols, rows }).strict();
const sessionSchema = z.object({ sessionId }).strict();

function refuse(c: Context, code: RefusalCode, reason?: string): Response {
  const [status, message] = REFUSALS[code];
  return c.json({ error: code, message, ...(reason ? { reason } : {}) }, status as 400);
}

/** Bounded read that does not trust Content-Length. */
async function readBody(c: Context, limit: number): Promise<string> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > limit) throw new GatewayError('PAYLOAD_TOO_LARGE');
  const reader = c.req.raw.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new GatewayError('PAYLOAD_TOO_LARGE');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson<T>(c: Context, schema: z.ZodType<T>, limit: number): Promise<T> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(c.req.header('content-type') ?? '')) throw new GatewayError('UNSUPPORTED_MEDIA_TYPE');
  const text = await readBody(c, limit);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GatewayError('INVALID_REQUEST');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GatewayError('INVALID_REQUEST');
  return parsed.data;
}

const auditableAddress = z.union([z.ipv4(), z.ipv6()]);

/**
 * The address for the audit record. X-Forwarded-For is believed only when configured, because the
 * ingress overwrites it; anything but one address the audit schema accepts is not recorded.
 */
function clientAddress(c: Context, trustForwardedFor: boolean): string | null {
  let value: string | undefined;
  if (trustForwardedFor) value = c.req.header('x-forwarded-for');
  else {
    try { value = getConnInfo(c).remote.address; } catch { /* no socket behind this request */ }
  }
  return value && auditableAddress.safeParse(value).success ? value : null;
}

export interface AppDependencies {
  publicOrigin: string;
  /** Only behind an ingress that overwrites X-Forwarded-For with one address. */
  trustForwardedFor?: boolean;
  authorizer: Authorizer;
  sessions: SessionManager;
  participant: Pick<ResourceParticipant, 'drain'>;
  /** Called only for a refusal of a verified token. Must not throw. */
  auditRefusal: (event: { subject: string; actorId: string; nodeId: string | null; outcome: string; ipAddress: string | null; fingerprint: string | null }) => void;
}

export function createApp(dependencies: AppDependencies) {
  const { publicOrigin, authorizer, sessions, participant, auditRefusal, trustForwardedFor = false } = dependencies;
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof GatewayError) {
      if (error.audit) {
        auditRefusal({
          subject: error.audit.subject, actorId: error.audit.actorId, nodeId: error.audit.nodeId ?? null, outcome: error.code,
          ipAddress: clientAddress(c, trustForwardedFor), fingerprint: error.audit.fingerprint ?? null,
        });
      }
      return refuse(c, error.code, error.reason);
    }
    // Only the type: messages from dependencies can carry addresses or request content.
    console.error(JSON.stringify({ type: 'request-failed', error: error.name }));
    return refuse(c, 'INTERNAL');
  });
  app.notFound((c) => refuse(c, 'NOT_FOUND'));

  app.use('*', async (c, next) => {
    await next();
    const headers = c.res.headers;
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  });

  // Machine and browser routes alike: no browser on another origin is ever served.
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    const internal = c.req.path.startsWith('/internal/');
    if (origin !== undefined && (internal || origin !== publicOrigin)) return refuse(c, 'CROSS_ORIGIN_REJECTED');
    const site = c.req.header('sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return refuse(c, 'CROSS_ORIGIN_REJECTED');
    return next();
  });

  // A token in a query string ends up in access logs, so any option in a URL is refused.
  app.use('/terminal/*', async (c, next) => {
    // Hono answers HEAD by running the GET handler, which would attach a reader nobody can read.
    if (c.req.method === 'HEAD') return refuse(c, 'NOT_FOUND');
    const keys = [...new URL(c.req.url).searchParams.keys()];
    const allowed = c.req.method === 'GET' ? ['sessionId'] : [];
    if (keys.some((key) => !allowed.includes(key)) || new Set(keys).size !== keys.length) return refuse(c, 'CREDENTIAL_IN_URL');
    return next();
  });

  /** A verified token that no longer grants the terminal ends what its identity session holds. */
  const verified = async <T>(check: () => Promise<T>): Promise<T> => {
    try {
      return await check();
    } catch (error) {
      if (error instanceof GatewayError && error.ownerKey) sessions.endForOwner(error.ownerKey);
      throw error;
    }
  };
  const principalFor = (c: Context) => verified(() => authorizer.authorize(bearerToken(c.req.header('authorization'))));

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.post('/terminal/open', async (c) => {
    const principal = await verified(() => authorizer.authorizeOpen(bearerToken(c.req.header('authorization'))));
    const body = await readJson(c, openSchema, MAX_CONTROL_BODY_BYTES);
    try {
      const opened = await sessions.open({ principal, nodeId: body.nodeId, size: { cols: body.cols, rows: body.rows }, ipAddress: clientAddress(c, trustForwardedFor) });
      return c.json({ ...opened, nodeId: body.nodeId }, 201);
    } catch (error) {
      const refused = error instanceof GatewayError ? error : new GatewayError('INTERNAL');
      refused.audit = {
        subject: principal.identity.subject, actorId: principal.link.localUserId, nodeId: body.nodeId, fingerprint: refused.observedFingerprint ?? null,
      };
      throw refused;
    }
  });

  app.get('/terminal/stream', async (c) => {
    const principal = await principalFor(c);
    const parsed = sessionId.safeParse(c.req.query('sessionId'));
    if (!parsed.success) throw new GatewayError('INVALID_REQUEST');
    const stream = sessions.attach(parsed.data, principal);
    return new Response(stream, {
      headers: { 'Content-Type': 'application/octet-stream', 'X-Accel-Buffering': 'no' },
    });
  });

  app.get('/terminal/status', async (c) => {
    const principal = await principalFor(c);
    const parsed = sessionId.safeParse(c.req.query('sessionId'));
    if (!parsed.success) throw new GatewayError('INVALID_REQUEST');
    return c.json(sessions.status(parsed.data, principal));
  });

  app.post('/terminal/input', async (c) => {
    const principal = await principalFor(c);
    const body = await readJson(c, inputSchema, MAX_INPUT_BODY_BYTES);
    if (Buffer.byteLength(body.data) > MAX_INPUT_BYTES) throw new GatewayError('PAYLOAD_TOO_LARGE');
    sessions.input(body.sessionId, principal, body.data);
    return c.json({ ok: true });
  });

  app.post('/terminal/resize', async (c) => {
    const principal = await principalFor(c);
    const body = await readJson(c, resizeSchema, MAX_CONTROL_BODY_BYTES);
    sessions.resize(body.sessionId, principal, { cols: body.cols, rows: body.rows });
    return c.json({ ok: true });
  });

  app.post('/terminal/renew', async (c) => {
    const principal = await principalFor(c);
    const body = await readJson(c, sessionSchema, MAX_CONTROL_BODY_BYTES);
    sessions.renew(body.sessionId, principal);
    return c.json({ ok: true, tokenExpiresAt: new Date(principal.identity.expiresAt * 1000).toISOString() });
  });

  app.post('/terminal/close', async (c) => {
    const principal = await principalFor(c);
    const body = await readJson(c, sessionSchema, MAX_CONTROL_BODY_BYTES);
    sessions.close(body.sessionId, principal);
    return c.json({ ok: true });
  });

  // The API's drain challenge. Same contract and failure shape as the route it replaces.
  app.post('/internal/resource-enrollment/drain', async (c) => {
    try {
      const body = await readBody(c, MAX_DRAIN_BODY_BYTES);
      return c.json(await participant.drain(JSON.parse(body), c.req.header('x-resource-drain-key') ?? ''));
    } catch (error) {
      if (error instanceof GatewayError && error.code === 'PAYLOAD_TOO_LARGE') return c.json({ error: 'Invalid drain request' }, 413);
      return c.json({ error: 'Drain proof unavailable' }, 403);
    }
  });

  return app;
}
