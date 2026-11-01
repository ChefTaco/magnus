/** Reachability and configuration checks behind `magnus-server check`. */
import { existsSync } from 'node:fs';
import pg from 'pg';
import { Redis } from 'ioredis';
import { describeMigration, migrationsNeedingAttention, readMigrationState } from './migrations.js';

export type CheckStatus = 'pass' | 'warn' | 'fail';
export interface CheckResult { name: string; status: CheckStatus; message: string }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Strip credentials from a connection URL before printing it. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '<invalid URL>';
  }
}

/** Connect to PostgreSQL and compare applied migrations with the packaged ones. */
export async function checkDatabase(url: string, migrationsDir: string): Promise<CheckResult[]> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch (error) {
    await client.end().catch(() => undefined);
    return [{ name: 'database', status: 'fail', message: `cannot reach ${redactUrl(url)}: ${errorMessage(error)}` }];
  }
  const results: CheckResult[] = [{ name: 'database', status: 'pass', message: `connected to ${redactUrl(url)}` }];
  try {
    const { packaged, pending } = await readMigrationState(client, migrationsDir);
    const attention = migrationsNeedingAttention(pending);
    results.push(pending.length === 0
      ? { name: 'migrations', status: 'pass', message: `${packaged.length} applied` }
      : { name: 'migrations', status: 'warn', message: `${pending.length} pending${attention.length ? ` (needs attention: ${attention.map(describeMigration).join('; ')})` : ''}; run \`magnus-server migrate\`` });
  } catch (error) {
    results.push({ name: 'migrations', status: 'warn', message: `cannot read migration state: ${errorMessage(error)}` });
  } finally {
    await client.end().catch(() => undefined);
  }
  return results;
}

/** PING Redis with a short timeout. */
export async function checkRedis(url: string): Promise<CheckResult> {
  const redis = new Redis(url, { lazyConnect: true, connectTimeout: 5_000, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    const reply = await redis.ping();
    return { name: 'redis', status: reply === 'PONG' ? 'pass' : 'fail', message: `${redactUrl(url)} answered ${reply}` };
  } catch (error) {
    return { name: 'redis', status: 'fail', message: `cannot reach ${redactUrl(url)}: ${errorMessage(error)}` };
  } finally {
    redis.disconnect();
  }
}

/** TLS is mandatory in production; cleartext is a loopback-only development opt-in. */
export function checkTls(env: NodeJS.ProcessEnv): CheckResult {
  const cert = env['TLS_CERT_PATH'];
  const key = env['TLS_KEY_PATH'];
  if (cert && key) {
    const missing = [cert, key].filter(path => !existsSync(path));
    return missing.length === 0
      ? { name: 'tls', status: 'pass', message: `certificate ${cert}` }
      : { name: 'tls', status: 'fail', message: `missing ${missing.join(', ')}` };
  }
  if (env['NODE_ENV'] === 'production') return { name: 'tls', status: 'fail', message: 'TLS_CERT_PATH and TLS_KEY_PATH are required in production' };
  return (env['ALLOW_INSECURE_HTTP'] ?? '').toLowerCase() === 'true'
    ? { name: 'tls', status: 'warn', message: 'no certificate; cleartext HTTP on loopback (development opt-in)' }
    : { name: 'tls', status: 'fail', message: 'no certificate; set TLS_CERT_PATH/TLS_KEY_PATH or ALLOW_INSECURE_HTTP=true for local development' };
}
