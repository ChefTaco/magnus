import { HOST_FQDN } from '../env.js';
import { resultSigningKey } from '../security/local-evidence-keys.js';
import { commandRefusalSigningPayload, signCommandEvidence } from '../security/command-result-signature.js';
import { logger } from '../utils/logger.js';
import { commandLedger } from './command-executor.js';
import { nodeEvidenceFields } from '../security/evidence-signing.js';

/**
 * The error body of a refusal. Only with a local proof that the request did
 * not start, nothing local for its id and a lease to name, does it carry
 * `executed: false` and a signature bound to the request, the lease and this node;
 * the server settles the lease on that alone. Anything less stays uncertain, the
 * safe answer for an older server too. A claim this command still holds counts as
 * something local: the request may be between its claim and its receipt.
 */
export async function refusalError(request: { commandId: string; requestSha256: string; leaseId?: string | undefined }, code: string, message: string,
  details: { notStarted: boolean; highWater?: { resourceKey: string; fence: string } }) {
  const base = { code, message, ...(details.highWater ? { highWater: details.highWater.fence, resourceKey: details.highWater.resourceKey } : {}) };
  if (!details.notStarted || !request.leaseId) return base;
  try {
    const trace = await commandLedger.commandTrace(request.commandId);
    if (trace.receipt || trace.activeLock) return base;
    const unsigned = { commandId: request.commandId, requestSha256: request.requestSha256, code, highWater: details.highWater?.fence ?? null, nodeFqdn: HOST_FQDN, leaseId: request.leaseId };
    return { ...base, dispatched: false, executed: false,
      refusal: { ...unsigned, signature: signCommandEvidence(commandRefusalSigningPayload(unsigned), resultSigningKey()),
        ...nodeEvidenceFields('command-refusal', commandRefusalSigningPayload(unsigned)) } };
  } catch (error) {
    logger.warn(`Refusal of ${request.commandId} (${code}) stays uncertain: ${error instanceof Error ? error.message : String(error)}`);
    return base;
  }
}
/** Same statuses as /commands/execute. */
export const refusalStatus = (code: string) => code === 'LEDGER_UNAVAILABLE' ? 503 : 409;
