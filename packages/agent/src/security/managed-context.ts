import { AsyncLocalStorage } from 'node:async_hooks';
import type { ManagedClaim } from './managed-http.js';
import type { CommandFence } from '../executors/command-ledger.js';

export interface ManagedExecutionContext {
  claim: ManagedClaim;
  commandId: string;
  requestSha256: string;
  coordination?: CommandFence;
  signal?: AbortSignal;
}
/** Process-only trusted context. HTTP callers cannot set this with a header. */
export const managedExecution = new AsyncLocalStorage<ManagedExecutionContext>();
