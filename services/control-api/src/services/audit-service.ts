import fs from 'node:fs/promises';
import { magnusHomePath } from '../utils/magnus-home.js';
import { createReadStream, existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { AuditAction } from '../types/index.js';

/** Keys whose values must never appear in audit logs or console output. */
const SENSITIVE_KEYS = new Set([
  'token',
  'password',
  'secret',
  'apiKey',
  'api_key',
  'apiSecret',
  'api_secret',
  'authorization',
  'nodeToken',
  'nodeManagerSecret',
  'x-node-token',
  'x-api-secret',
  'x-resource-drain-key',
  'jwt',
  'jwtSecret',
  'jwt_secret',
  'deployPassword',
  'deploy_password',
  'credentials',
  'privateKey',
  'private_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
]);

/** True when sanitizeDetails() would redact this key's value. */
export function isSensitiveDetailKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key) || SENSITIVE_KEYS.has(key.toLowerCase());
}

/**
 * Recursively strip sensitive fields from an object.
 * Returns a shallow clone with secret values replaced by '[REDACTED]'.
 */
export function sanitizeDetails(obj: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!obj) return {};

  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key) || SENSITIVE_KEYS.has(key.toLowerCase())) {
      clean[key] = '[REDACTED]';
    } else if (Array.isArray(value)) {
      clean[key] = value
        .slice(0, 100)
        .map((item) =>
          item && typeof item === 'object'
            ? sanitizeDetails(item as Record<string, unknown>)
            : item,
        );
    } else if (value && typeof value === 'object') {
      clean[key] = sanitizeDetails(value as Record<string, unknown>);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

// ─── File-based audit log ───

/** Default audit logs directory — `${MAGNUS_HOME:-~/.magnus}/audit-logs`. */
function getAuditDir(): string {
  return process.env['AUDIT_LOG_DIR'] ?? magnusHomePath('audit-logs');
}

/** Return the YYYY-MM-DD string for a Date (UTC). */
function dateToKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Path to the JSONL file for a given day key. */
function logFilePath(dayKey: string): string {
  return path.join(getAuditDir(), `${dayKey}.jsonl`);
}

interface AuditLogEntry {
  id: string;
  action: string;
  actorId: string;
  actorType: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
  ipAddress: string | null;
  timestamp: string;
  prevHash: string;
  integrity: string;
  chainVersion?: 1 | 2;
  verificationState?: 'verified' | 'legacy-partial' | 'invalid';
}

// ── HMAC chain state (per-day) ──
const EMPTY_CHAIN_HASH = '0000000000000000000000000000000000000000000000000000000000000000';
let lastHash = EMPTY_CHAIN_HASH;
let activeChainPath = '';
let appendQueue: Promise<void> = Promise.resolve();

/**
 * Audit integrity has its own rotation boundary. Reusing an API/JWT/master
 * secret couples unrelated credentials, while a source-known fallback makes
 * every chain forgeable. Resolve the dedicated secret lazily so unit tests can
 * import sanitization helpers without configuring production state.
 */
export function resolveAuditHmacSecret(): string {
  const secret = process.env['AUDIT_HMAC_SECRET'] ?? '';
  if (secret.length < 32) {
    throw new Error('AUDIT_HMAC_SECRET must be a dedicated secret of at least 32 characters');
  }
  return secret;
}

/** Canonical JSON of the persisted record; object order is insignificant. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function computeIntegrity(entry: Omit<AuditLogEntry, 'integrity'>, prevHash: string): string {
  let payload: string;
  if (entry.chainVersion === undefined || entry.chainVersion === 1) {
    payload = `${prevHash}|${entry.id}|${entry.action}|${entry.actorId}|${entry.timestamp}`;
  } else if (entry.chainVersion === 2) {
    const { integrity: _integrity, verificationState: _state, ...record } = entry as AuditLogEntry;
    payload = canonical(record);
  } else throw new Error('Unsupported audit chain version');
  return createHmac('sha256', resolveAuditHmacSecret()).update(payload).digest('hex');
}

async function readVerifiedChainHead(dayKey: string): Promise<string> {
  const filePath = logFilePath(dayKey);
  if (!existsSync(filePath)) return EMPTY_CHAIN_HASH;

  let head = EMPTY_CHAIN_HASH;
  let lineNumber = 0;
  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      lineNumber += 1;
      try {
        const entry = JSON.parse(line) as AuditLogEntry;
        if (!entry.integrity || entry.prevHash !== head) {
          throw new Error('missing or discontinuous integrity metadata');
        }
        const expected = computeIntegrity(entry, head);
        if (entry.integrity !== expected) throw new Error('HMAC mismatch');
        head = entry.integrity;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        rl.close();
        reject(
          new Error(`Refusing to append to invalid audit chain at line ${lineNumber}: ${detail}`),
        );
      }
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
  return head;
}

interface AuditLogParams {
  action: AuditAction;
  actorId: string;
  actorType?: 'user' | 'agent' | 'system';
  targetType: string;
  targetId: string;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
}

/** Append one event while serialized with every other in-process append. */
async function appendAuditEvent(params: AuditLogParams): Promise<void> {
  const now = new Date();
  const dayKey = dateToKey(now);
  const filePath = logFilePath(dayKey);

  // Recover and verify the active head after every process restart, day change,
  // or audit-directory change before accepting another event.
  if (filePath !== activeChainPath) {
    lastHash = await readVerifiedChainHead(dayKey);
    activeChainPath = filePath;
  }

  const partial = {
    id: nanoid(),
    action: params.action,
    actorId: params.actorId,
    actorType: params.actorType ?? 'user',
    targetType: params.targetType,
    targetId: params.targetId,
    details: sanitizeDetails(params.details),
    ipAddress: params.ipAddress ?? null,
    timestamp: now.toISOString(),
    prevHash: lastHash,
    chainVersion: 2 as const,
  };

  const persisted = JSON.parse(JSON.stringify(partial)) as typeof partial;
  const integrity = computeIntegrity(persisted, lastHash);
  const entry: AuditLogEntry = { ...persisted, integrity };

  const dir = getAuditDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  await fs.appendFile(filePath, JSON.stringify(entry) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  await fs.chmod(filePath, 0o600);
  lastHash = integrity;
}

/** Append an immutable audit event. Details are sanitized and writes are serialized. */
export async function logAuditEvent(params: AuditLogParams): Promise<void> {
  const operation = appendQueue.then(() => appendAuditEvent(params));
  appendQueue = operation.catch(() => undefined);
  return operation;
}

/** List available day keys (YYYY-MM-DD) that have audit log files. */
export async function listAuditDays(): Promise<string[]> {
  const dir = getAuditDir();
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace('.jsonl', ''))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export interface AuditVerification {
  valid: boolean;
  totalEntries: number;
  brokenAtIndex: number;
  legacyEntries: number;
  state: 'verified' | 'legacy-partial' | 'invalid';
}

/** Verify and paginate the same byte stream, including filtered-out entries. */
export async function queryAuditEvents(opts: {
  date?: string;
  action?: string;
  actorId?: string;
  page?: number;
  pageSize?: number;
}): Promise<{
  events: AuditLogEntry[];
  total: number;
  page: number;
  pageSize: number;
  verification: AuditVerification;
}> {
  const day = opts.date ?? dateToKey(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid audit date');
  const page = Math.max(1, Math.min(100, Math.trunc(opts.page || 1)));
  const pageSize = Math.max(1, Math.min(200, Math.trunc(opts.pageSize || 50)));
  const verification: AuditVerification = {
    valid: true,
    totalEntries: 0,
    brokenAtIndex: -1,
    legacyEntries: 0,
    state: 'verified',
  };
  const matched: AuditLogEntry[] = [];
  let total = 0,
    head = EMPTY_CHAIN_HASH;
  const file = logFilePath(day);
  if (existsSync(file)) {
    const input = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const index = verification.totalEntries++;
        let entry: AuditLogEntry;
        try {
          entry = JSON.parse(line) as AuditLogEntry;
          if (!entry || typeof entry !== 'object') throw new Error('Invalid record');
        } catch {
          if (verification.brokenAtIndex < 0) verification.brokenAtIndex = index;
          continue;
        }
        try {
          if (
            !entry.integrity ||
            entry.prevHash !== head ||
            computeIntegrity(entry, head) !== entry.integrity
          )
            throw new Error('Invalid HMAC');
        } catch {
          if (verification.brokenAtIndex < 0) verification.brokenAtIndex = index;
        }
        head = entry.integrity;
        if (entry.chainVersion !== 2) verification.legacyEntries++;
        entry.verificationState =
          verification.brokenAtIndex >= 0
            ? 'invalid'
            : entry.chainVersion === 2
              ? 'verified'
              : 'legacy-partial';
        if (opts.action && entry.action !== opts.action) continue;
        if (opts.actorId && entry.actorId !== opts.actorId) continue;
        total++;
        matched.push(entry);
        if (matched.length > page * pageSize) matched.shift();
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }
  verification.valid = verification.brokenAtIndex < 0;
  verification.state = !verification.valid
    ? 'invalid'
    : verification.legacyEntries
      ? 'legacy-partial'
      : 'verified';
  // A broken chain must never be presented as ordinary trusted history.
  if (!verification.valid) for (const entry of matched) entry.verificationState = 'invalid';
  return {
    events: matched.reverse().slice((page - 1) * pageSize, page * pageSize),
    total,
    page,
    pageSize,
    verification,
  };
}

export async function verifyAuditIntegrity(date?: string): Promise<AuditVerification> {
  return (await queryAuditEvents({ date, pageSize: 1 })).verification;
}
