import { AsyncLocalStorage } from 'node:async_hooks';
import type { ManagedClaim } from './managed-http.js';
import type { CommandFence } from '../executors/command-ledger.js';

export interface ManagedExecutionContext {
  claim: ManagedClaim;
  commandId: string;
  requestSha256: string;
  coordination?: CommandFence;
  signal?: AbortSignal;
  /** Run once the ledger's terminal receipt for this request is durable, or the attempt ended without one. */
  afterSettled?: Array<() => void | Promise<void>>;
}
/** Process-only trusted context. HTTP callers cannot set this with a header. */
export const managedExecution = new AsyncLocalStorage<ManagedExecutionContext>();
