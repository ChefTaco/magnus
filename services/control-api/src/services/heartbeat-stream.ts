/**
 * Read-only stats for the retired Redis Streams heartbeat transport.
 *
 * Ingestion (POST /heartbeat/stream) and the loopback replay consumer are
 * retired: no agent used them, entries carried the shared node secret in
 * plaintext, and replay misattributed caller addresses. The dashboard and
 * Prometheus still read these stats to show any residual stream state.
 */
import type { Redis as RedisType } from 'ioredis';
import { getRedis } from '../queue/redis.js';

const STREAM_KEY = 'heartbeats';

function getPhysicalStreamKey(redis: RedisType): string {
  return `${redis.options?.keyPrefix ?? ''}${STREAM_KEY}`;
}
const CONSUMER_GROUP = 'control-api';

export interface HeartbeatStreamStats {
  enabled: boolean;
  streamKey: string;
  length: number;
  consumerGroup: string;
  pending: number;
  lastDeliveredId: string | null;
  consumers: Array<{ name: string; pending: number; idleMs: number }>;
}

export async function getHeartbeatStreamStats(): Promise<HeartbeatStreamStats> {
  const redis = getRedis();
  const baseStats: HeartbeatStreamStats = {
    enabled: true,
    streamKey: getPhysicalStreamKey(redis),
    length: 0,
    consumerGroup: CONSUMER_GROUP,
    pending: 0,
    lastDeliveredId: null,
    consumers: [],
  };

  try {
    const length = await redis.call('XLEN', STREAM_KEY).catch(() => 0);
    baseStats.length = Number(length ?? 0);

    const groups = await redis.call('XINFO', 'GROUPS', STREAM_KEY).catch(() => null) as Array<Array<string | number>> | null;
    if (groups) {
      for (const g of groups) {
        // Flat array: name, <value>, consumers, <n>, pending, <n>, last-delivered-id, <id>, ...
        const obj: Record<string, string | number> = {};
        for (let i = 0; i < g.length; i += 2) {
          const k = g[i];
          const v = g[i + 1];
          if (typeof k === 'string' && v !== undefined) obj[k] = v;
        }
        if (obj['name'] === CONSUMER_GROUP) {
          baseStats.pending = Number(obj['pending'] ?? 0);
          baseStats.lastDeliveredId = typeof obj['last-delivered-id'] === 'string'
            ? obj['last-delivered-id']
            : null;
        }
      }
    }

    const consumers = await redis.call('XINFO', 'CONSUMERS', STREAM_KEY, CONSUMER_GROUP).catch(() => null) as Array<Array<string | number>> | null;
    if (consumers) {
      for (const c of consumers) {
        const obj: Record<string, string | number> = {};
        for (let i = 0; i < c.length; i += 2) {
          const k = c[i];
          const v = c[i + 1];
          if (typeof k === 'string' && v !== undefined) obj[k] = v;
        }
        baseStats.consumers.push({
          name: String(obj['name'] ?? 'unknown'),
          pending: Number(obj['pending'] ?? 0),
          idleMs: Number(obj['idle'] ?? 0),
        });
      }
    }
  } catch {
    baseStats.enabled = false;
  }

  return baseStats;
}
