/** Shared freshness rule for exclusive commands and managed interactive sessions. */
export const RESOURCE_HEARTBEAT_FRESH_MS = 120_000;
export function hasFreshOnlineHealth(node: { status: string; lastHeartbeatAt: Date | null }, now = Date.now()): boolean {
  return node.status === 'ONLINE' && Boolean(node.lastHeartbeatAt) && now - node.lastHeartbeatAt!.getTime() <= RESOURCE_HEARTBEAT_FRESH_MS;
}
