/**
 * Well-known sentinel node IDs.
 *
 * These virtual Node records satisfy the `LogEntry.nodeId` foreign-key
 * constraint for internal log sources (Control API process logs, Dashboard
 * error reports).  They are seeded by `prisma/seed.ts` with
 * `metadata: '{"sentinel":true}'` and must be excluded from all fleet-facing
 * queries (node listing, scan, heartbeat monitor, etc.).
 */

/** Sentinel node representing the Control API process itself. */
export const CONTROL_API_NODE_ID = '__control-api__';

/** Sentinel node representing the Next.js Dashboard. */
export const DASHBOARD_NODE_ID = '__dashboard__';

/** Array of all sentinel node IDs — use in Prisma `id: { notIn: … }` filters. */
export const SENTINEL_NODE_IDS: string[] = [CONTROL_API_NODE_ID, DASHBOARD_NODE_ID];
