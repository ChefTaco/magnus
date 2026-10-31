/**
 * Module-level store for the fleet event bus: the last 50 events plus the SSE
 * connection state. `use-event-stream.ts` writes to it (one EventSource for the
 * whole app); the header LED and live ticker read it via useSyncExternalStore.
 */

export type FeedSeverity = 'info' | 'success' | 'warning' | 'error';

export interface FeedEntry {
  id: number;
  at: number;
  channel: string;
  title: string;
  message?: string;
  severity: FeedSeverity;
}

export interface FeedSnapshot {
  connected: boolean;
  entries: FeedEntry[];
}

const LIMIT = 50;
let snapshot: FeedSnapshot = { connected: false, entries: [] };
let nextId = 1;
const listeners = new Set<() => void>();

function emit(next: FeedSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export const eventFeed = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): FeedSnapshot {
    return snapshot;
  },
  getServerSnapshot(): FeedSnapshot {
    return SERVER_SNAPSHOT;
  },
  push(entry: Omit<FeedEntry, 'id' | 'at'> & { at?: number }): void {
    const full: FeedEntry = { ...entry, id: nextId++, at: entry.at ?? Date.now() };
    emit({ ...snapshot, entries: [full, ...snapshot.entries].slice(0, LIMIT) });
  },
  setConnected(connected: boolean): void {
    if (snapshot.connected !== connected) emit({ ...snapshot, connected });
  },
};

const SERVER_SNAPSHOT: FeedSnapshot = { connected: false, entries: [] };
