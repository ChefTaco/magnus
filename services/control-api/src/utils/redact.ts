/**
 * Secret redaction for logs, audit details and AI tool output, on HiveCommon `/log` (`redact()`,
 * `redactText()`): secret-looking keys, Authorization schemes, JWTs, private keys, provider token
 * formats, URL credentials, secret query parameters and `name=value` pairs whose name ends in a
 * secret word (`NODE_TOKEN=...`, `db_password: ...`).
 */
import { redact, redactText, REDACTED } from '@hivemagnus/hive-common/log';

/**
 * The few things Magnus always masked that HiveCommon's text rules leave in clear, applied after
 * them. Each only reaches text HiveCommon did not already mask.
 */
const MAGNUS_TEXT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // A provider key glued to a word character (`\nsk-...` in escaped JSON): HiveCommon needs a word
  // boundary before `sk-`.
  [/sk-[A-Za-z0-9_-]{12,}/g, REDACTED],
  // A bearer credential of any length, also glued to a word character (`\nBearer ...`): HiveCommon
  // needs a boundary and at least four characters. One HiveCommon already masked is left alone.
  [/Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/-]+=*/g, `Bearer ${REDACTED}`],
  // A secret value that runs on after `&` (`password: p&ss`): HiveCommon stops the value at `&`,
  // as in a query string. Mask the rest up to where Magnus always ended it, keeping the name.
  [/\b([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password|passwd|private[_-]?key)["']?\s*[:=]\s*["']?)(?:\[REDACTED\])?&[^"',\s}]*/gi, `$1${REDACTED}`],
];

export function redactSecretText(value: string): string {
  let text = redactText(value);
  for (const [pattern, replacement] of MAGNUS_TEXT_RULES) text = text.replace(pattern, replacement);
  return text;
}

/** Every key name Magnus masks whatever its value, numbers, booleans and null included. */
const MAGNUS_SECRET_KEY = /api[_-]?key|token|secret|password|passwd|private[_-]?key/i;

/**
 * A deep copy with secrets masked. Every key Magnus masked before (any name containing `token`,
 * `secret`, `password`, `passwd`, `api_key` or `private_key`) is still masked, and so are the wider
 * HiveCommon names (`authorization`, `cookie`, `credential`, `signature`, `*key`...). Under Magnus's
 * own names every value is masked, numbers and booleans included; under the wider HiveCommon names
 * a number or boolean (a count, a `hasKey` flag) is kept, as HiveCommon does. Strings everywhere
 * are scrubbed with `redactSecretText()`.
 */
export function redactUnknown(value: unknown): unknown {
  return scrubStrings(redact(value, { keyPattern: MAGNUS_SECRET_KEY, maskNonStrings: 'listed' }));
}

/** Magnus's text rules over HiveCommon's copy (already acyclic and depth-bounded). */
function scrubStrings(value: unknown): unknown {
  if (typeof value === 'string') return value === REDACTED ? value : redactSecretText(value);
  if (Array.isArray(value)) return value.map((item) => scrubStrings(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, scrubStrings(item)]));
  }
  return value;
}

/** One line naming what failed, for logs: the error's message with secrets redacted. */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactSecretText(text).replace(/\s+/g, ' ').slice(0, 500);
}
