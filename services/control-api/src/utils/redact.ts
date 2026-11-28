/**
 * Secret redaction for logs, audit details and AI tool output, on HiveCommon `/log` (`redact()`,
 * `redactText()`): secret-looking keys, Authorization schemes, JWTs, private keys, provider token
 * formats, URL credentials and secret query parameters.
 */
import { redact, redactText } from '@hivemagnus/hive-common/log';

/**
 * Magnus's own text patterns, applied after HiveCommon's. They are wider in one place HiveCommon is
 * deliberately narrow: an assignment whose name only ends in a secret word (`NODE_TOKEN=...`,
 * `db_password: ...`) is masked as a whole, as Magnus always did.
 */
const MAGNUS_SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /(?:api[_-]?key|token|secret|password|passwd|private[_-]?key)\s*[:=]\s*["']?[^"',\s}]+/gi,
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactSecretText(value: string): string {
  return MAGNUS_SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, '[REDACTED]'), redactText(value));
}

/**
 * A deep copy with secrets masked. Every key Magnus masked before (any name containing `token`,
 * `secret`, `password`, `passwd`, `api_key` or `private_key`) is still masked, and so are the wider
 * HiveCommon names (`authorization`, `cookie`, `credential`, `signature`, `*key`...). Under Magnus's
 * own names every value is masked, numbers and booleans included; under the wider HiveCommon names
 * a number or boolean (a count, a `hasKey` flag) is kept, as HiveCommon does. Strings everywhere
 * are scrubbed with `redactSecretText()`.
 */
export function redactUnknown(value: unknown): unknown {
  return applyMagnusRules(redact(value));
}

const MAGNUS_SECRET_KEY = /api[_-]?key|token|secret|password|passwd|private[_-]?key/i;

/** The second pass over HiveCommon's copy (already acyclic and depth-bounded). */
function applyMagnusRules(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretText(value);
  if (Array.isArray(value)) return value.map((item) => applyMagnusRules(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) =>
      [key, MAGNUS_SECRET_KEY.test(key) ? '[REDACTED]' : applyMagnusRules(item)]));
  }
  return value;
}

/** One line naming what failed, for logs: the error's message with secrets redacted. */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactSecretText(text).replace(/\s+/g, ' ').slice(0, 500);
}
