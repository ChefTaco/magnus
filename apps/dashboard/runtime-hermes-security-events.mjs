import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hermesSecurityEventDiagnostics, incrementDroppedSecurityEvents, incrementPendingSecurityEvents } from './runtime-hermes-security-event-state.mjs';

const MAX_EVENT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_EVENTS = 2_000;
const MAX_PENDING_EVENTS = 1_000;
const EVENT_TYPES = new Set([
  'rejected_endpoint', 'invalid_session', 'rejected_origin', 'blocked_destination',
  'connection_failed', 'connection_started', 'connection_closed', 'queue_pressure',
  'backpressure', 'legacy_session_secret', 'host_key_mismatch',
]);
const workers = new Map();

export function hermesSecurityEventPath(env = process.env) {
  return env['HERMES_SECURITY_EVENT_PATH']
    ?? join(/*turbopackIgnore: true*/ process.cwd(), '.magnus', 'hermes-proxy-security.jsonl');
}

function cleanText(value, maxLength) {
  if (value == null) return null;
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(authorization|cookie|password|passwd|secret|token|api[-_]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/https?:\/\/[^\s/?#]+[^\s]*/gi, (url) => {
      try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.host}${parsed.pathname}`; }
      catch { return '[REDACTED_URL]'; }
    })
    .trim()
    .slice(0, maxLength);
}

function cleanIdentifier(value) {
  const text = cleanText(value, 128);
  return text && /^[A-Za-z0-9._:-]+$/.test(text) ? text : null;
}

function cleanPath(value) {
  const text = cleanText(value, 256);
  if (!text) return null;
  const pathname = text.split(/[?#]/, 1)[0].replace(/\/{2,}/g, '/');
  return (pathname.startsWith('/') ? pathname : `/${pathname}`).slice(0, 256);
}

function cleanOrigin(value) {
  const text = cleanText(value, 512);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '[REDACTED_ORIGIN]';
    return url.origin.slice(0, 256);
  } catch { return '[INVALID_ORIGIN]'; }
}

function cleanHostname(value) {
  const text = cleanText(value, 253)?.toLowerCase();
  if (!text) return null;
  if (text.includes('@') || /[/?#]/.test(text)) return '[REDACTED_HOST]';
  return /^[a-z0-9](?:[a-z0-9.:-]*[a-z0-9])?$/.test(text) ? text : '[INVALID_HOST]';
}

function boundedNumber(value, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(Math.round(number), 0), max) : undefined;
}

export function normalizeHermesSecurityEvent(event) {
  if (!event || typeof event !== 'object' || !EVENT_TYPES.has(event.type)) return null;
  const normalized = {
    timestamp: new Date(typeof event.timestamp === 'string' ? event.timestamp : Date.now()).toISOString(),
    type: event.type,
  };
  for (const key of ['correlationId', 'installationId', 'nodeId', 'transport', 'direction']) {
    const value = cleanIdentifier(event[key]);
    if (value) normalized[key] = value;
  }
  const hostname = cleanHostname(event.hostname);
  if (hostname) normalized.hostname = hostname;
  const reason = cleanText(event.reason, 256);
  if (reason) normalized.reason = reason;
  const path = cleanPath(event.path);
  if (path) normalized.path = path;
  if (event.origin != null) normalized.origin = cleanOrigin(event.origin);
  for (const key of ['durationMs', 'queuedBytes', 'backpressureDurationMs', 'peakBufferedBytes', 'droppedEvents']) {
    const value = boundedNumber(event[key], key.endsWith('Bytes') ? 1024 * 1024 * 1024 : 7 * 24 * 60 * 60 * 1000);
    if (value !== undefined) normalized[key] = value;
  }
  return normalized;
}

async function appendEvent(path, line) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    if ((await stat(path)).size >= MAX_EVENT_FILE_BYTES) await rename(path, `${path}.previous`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await appendFile(path, line, { mode: 0o600 });
}

function workerFor(path) {
  let worker = workers.get(path);
  if (!worker) {
    worker = { queue: [], running: false, dropped: 0, waiters: [] };
    workers.set(path, worker);
  }
  return worker;
}

async function drain(path, worker) {
  if (worker.running) return;
  worker.running = true;
  while (worker.queue.length > 0) {
    const line = worker.queue.shift();
    incrementPendingSecurityEvents(-1);
    try { await appendEvent(path, line); }
    catch (error) { console.error('[hermes-security] failed to record event', error); }
  }
  worker.running = false;
  for (const resolve of worker.waiters.splice(0)) resolve();
}

export function recordHermesSecurityEvent(event, options = {}) {
  const normalized = normalizeHermesSecurityEvent(event);
  if (!normalized) return false;
  const path = options.path ?? hermesSecurityEventPath(options.env);
  const worker = workerFor(path);
  if (worker.queue.length >= (options.maxPendingEvents ?? MAX_PENDING_EVENTS)) {
    worker.dropped += 1;
    incrementDroppedSecurityEvents();
    return false;
  }
  worker.queue.push(`${JSON.stringify(normalized)}\n`);
  incrementPendingSecurityEvents(1);
  void drain(path, worker);
  return true;
}

export function flushHermesSecurityEvents(options = {}) {
  const path = options.path ?? hermesSecurityEventPath(options.env);
  const worker = workerFor(path);
  if (!worker.running && worker.queue.length === 0) return Promise.resolve();
  return new Promise((resolve) => worker.waiters.push(resolve));
}

export { hermesSecurityEventDiagnostics };

export function readHermesSecurityEvents(options = {}) {
  const path = options.path ?? hermesSecurityEventPath(options.env);
  const limit = Math.min(Math.max(Number(options.limit ?? 200), 1), MAX_READ_EVENTS);
  if (!existsSync(/*turbopackIgnore: true*/ path)) return [];
  return readFileSync(/*turbopackIgnore: true*/ path, 'utf8').trim().split('\n').slice(-limit).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }).reverse();
}

export function summarizeHermesSecurityEvents(events) {
  const counts = { rejectedOrigins: 0, invalidSessions: 0, blockedDestinations: 0, rejectedEndpoints: 0, queuePressure: 0, backpressure: 0, hostKeyMismatches: 0 };
  const durations = [];
  for (const event of events) {
    if (event.type === 'rejected_origin') counts.rejectedOrigins += 1;
    if (event.type === 'invalid_session') counts.invalidSessions += 1;
    if (event.type === 'blocked_destination') counts.blockedDestinations += 1;
    if (event.type === 'rejected_endpoint') counts.rejectedEndpoints += 1;
    if (event.type === 'queue_pressure') counts.queuePressure += 1;
    if (event.type === 'backpressure') counts.backpressure += 1;
    if (event.type === 'host_key_mismatch') counts.hostKeyMismatches += 1;
    if (event.type === 'connection_closed' && Number.isFinite(event.durationMs)) durations.push(event.durationMs);
  }
  return { ...counts, connectionsClosed: durations.length, averageConnectionDurationMs: durations.length ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length) : 0 };
}
