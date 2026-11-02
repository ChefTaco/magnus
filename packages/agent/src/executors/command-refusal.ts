import { RESULT_SIGNING_SECRET } from '../env.js';
import { commandRefusalSigningPayload, signCommandEvidence } from '../security/command-result-signature.js';
import { logger } from '../utils/logger.js';
import { commandLedger } from './command-executor.js';

/**
 * The error body of a refusal. Only with a local proof that the request did
 * not start, and no receipt for its id, does it carry `executed: false` and a
 * signature bound to the request digest; the server settles the lease on that
 * alone. Anything less stays uncertain, the safe answer for an older server too.
 */
export async function refusalError(request: { commandId: string; requestSha256: string }, code: string, message: string,
  details: { notStarted: boolean; highWater?: { resourceKey: string; fence: string } }) {
  const base = { code, message, ...(details.highWater ? { highWater: details.highWater.fence, resourceKey: details.highWater.resourceKey } : {}) };
  if (!details.notStarted) return base;
  try {
    const trace = await commandLedger.commandTrace(request.commandId);
    if (trace.receipt) return base;
    const unsigned = { commandId: request.commandId, requestSha256: request.requestSha256, code, highWater: details.highWater?.fence ?? null };
    return { ...base, dispatched: false, executed: false,
      refusal: { ...unsigned, signature: signCommandEvidence(commandRefusalSigningPayload(unsigned), RESULT_SIGNING_SECRET) } };
  } catch (error) {
    logger.warn(`Refusal of ${request.commandId} (${code}) stays uncertain: ${error instanceof Error ? error.message : String(error)}`);
    return base;
  }
}
/** Same statuses as /commands/execute. */
export const refusalStatus = (code: string) => code === 'LEDGER_UNAVAILABLE' ? 503 : 409;
