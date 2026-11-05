import { z } from 'zod';
import type { MiddlewareHandler } from 'hono';
import { HttpError } from '../middleware/error-handler.js';

export function rehearsalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return z.enum(['true', 'false']).default('false').parse(env['HIVE_REHEARSAL']) === 'true';
}
/** Isolated candidates must not claim restored queues, run timers or import catalogs. */
export function startLiveBackgroundServices(start: () => void, env: NodeJS.ProcessEnv = process.env): boolean {
  if (rehearsalEnabled(env)) return false;
  start();
  return true;
}
export function assertLiveExecution(env: NodeJS.ProcessEnv = process.env): void {
  if (rehearsalEnabled(env)) throw new HttpError(503, 'REHEARSAL_READ_ONLY', 'Isolated rehearsal disables host execution and queue activation');
}
export const rehearsalReadOnly: MiddlewareHandler = async (context, next) => {
  if (rehearsalEnabled() && !['GET', 'HEAD', 'OPTIONS'].includes(context.req.method))
    return context.json({ success: false, error: { code: 'REHEARSAL_READ_ONLY', message: 'Isolated rehearsal disables mutations and dispatch' } }, 503);
  return next();
};
