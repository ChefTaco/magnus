import {createHmac, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open, mkdir} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {isIP} from 'node:net';
import {resolveTrustedClientAddress} from './auth-protection';

export type SecurityOutcome = 'auth.login_failed' | 'auth.login_succeeded' | 'auth.login_throttled' | 'auth.login_rejected' | 'auth.login_error' | 'auth.logout' | 'auth.oauth_rejected';
export function buildSecurityEvent(event: SecurityOutcome, headers: Headers, username = '', method: 'local' | 'hive' = 'local') {
  const key = process.env['AUTH_RATE_LIMIT_LABEL_KEY'] ?? process.env['SESSION_SECRET'];
  if (!key || key.length < 32) throw new Error('Security audit identity key unavailable');
  const address = resolveTrustedClientAddress(headers).replace(/^::ffff:/, '');
  const source = isIP(address) ? address : 'unverified';
  const account = username.trim().toLowerCase().slice(0, 512);
  const label = (kind: string, value: string) => createHmac('sha256', key).update(`${kind}\0${value}`).digest('hex').slice(0, 24);
  // Only this allowlist is logged. Never include request bodies, supplied usernames,
  // cookies, authorization headers, OAuth codes, tokens, or exception messages.
  return {schemaVersion: 1, eventId: randomUUID(), occurredAt: new Date().toISOString(),
    application: 'magnus_ui', event, method, sourceAddress: source,
    accountLabel: label('account', account), sourceLabel: label('source', source),
    pairLabel: label('pair', `${method}\0${source}\0${account}`)};
}
export async function appendSecurityEvent(path: string, record: ReturnType<typeof buildSecurityEvent>): Promise<void> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o640);
  try { await file.chmod(0o640); await file.writeFile(JSON.stringify(record) + '\n'); await file.datasync(); }
  finally { await file.close(); }
}
export async function recordSecurityEvent(event: SecurityOutcome, headers: Headers, username = '', method: 'local' | 'hive' = 'local'): Promise<void> {
  const record = buildSecurityEvent(event, headers, username, method);
  // Defaults to the runtime state directory (MAGNUS_UI_DATA_DIR under magnus-ui start).
  const path = process.env['UI_SECURITY_LOG_PATH']?.trim() || join(/*turbopackIgnore: true*/ process.cwd(), '.magnus', 'security-events.jsonl');
  try { await appendSecurityEvent(path, record); }
  catch {
    console.error(JSON.stringify({...record, event: 'auth.audit_write_failed'}));
    throw new Error('Security audit persistence unavailable');
  }
}
