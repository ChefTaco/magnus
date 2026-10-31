import { EventEmitter } from 'node:events';
import type { LogChunk } from '../types/index.js';

// ─── Log Event Bus — in-process pub/sub for SSE streaming ───

const logBus = new EventEmitter();
logBus.setMaxListeners(100); // support many concurrent SSE clients

/** Emit a log entry to all connected SSE streams. */
export function emitLog(entry: LogChunk): void {
  logBus.emit('log', entry);
}

/**
 * Subscribe to new log entries.
 * @returns An unsubscribe function that removes the listener.
 */
export function onLog(handler: (entry: LogChunk) => void): () => void {
  logBus.on('log', handler);
  return () => {
    logBus.off('log', handler);
  };
}
