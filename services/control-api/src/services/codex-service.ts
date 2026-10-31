import type { CodexDeviceAuthSession, CodexNodeState } from '../types/index.js';
import { getDb } from '../db/index.js';
import { NodeApiClient } from '../sdk/index.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { SENTINEL_NODE_IDS } from '../utils/sentinel-nodes.js';

const DEFAULT_CODEX_FLEET_SCAN_INTERVAL_MS = 5 * 60_000;
const MIN_CODEX_FLEET_SCAN_INTERVAL_MS = 60_000;

function codexFleetScanIntervalMs(): number {
  const configured = Number(process.env['CODEX_FLEET_SCAN_INTERVAL_MS']);
  return Number.isFinite(configured) && configured >= MIN_CODEX_FLEET_SCAN_INTERVAL_MS
    ? configured
    : DEFAULT_CODEX_FLEET_SCAN_INTERVAL_MS;
}

export interface CodexFleetInstallation extends CodexNodeState {
  nodeId: string;
  nodeName: string;
  hostname: string;
  nodeStatus: string;
  lastHeartbeatAt: string | null;
  reachable: boolean;
}

interface NodeTarget {
  id: string;
  name: string;
  hostname: string;
  ipAddress: string;
  port: number;
  status: string;
  lastHeartbeatAt: Date | null;
}

interface CodexFleetCache {
  installations: CodexFleetInstallation[];
  refreshedAt: string;
}

export interface CodexFleetPosture {
  status: 'warming' | 'ready';
  generatedAt: string;
  refreshedAt: string | null;
  ageMs: number | null;
  scanIntervalMs: number;
  scanInProgress: boolean;
  managedNodes: number;
  installations: number;
  authenticatedWithChatgptOauth: number;
  updatesAvailable: number;
  needsLogin: number;
  currentRelease: string | null;
  nodes: Array<{
    nodeId: string;
    nodeName: string;
    hostname: string;
    version: string | null;
    latestVersion: string | null;
    updateAvailable: boolean;
    authStatus: CodexFleetInstallation['auth']['status'];
    oauth: boolean;
    checkedAt: string;
  }>;
}

let fleetCache: CodexFleetCache | null = null;
let fleetRefreshInFlight: Promise<CodexFleetInstallation[]> | null = null;
let fleetMonitorTimer: ReturnType<typeof setInterval> | null = null;

function clientFor(node: NodeTarget): NodeApiClient {
  return new NodeApiClient({
    baseUrl: getNodeBaseUrl(node.ipAddress, node.port),
      resourceNodeId: node.id,
    nodeToken: getNodeManagerSecret(),
  });
}

async function nodeTarget(nodeId: string): Promise<NodeTarget> {
  const node = await getDb().node.findFirst({
    where: { id: nodeId, status: { not: 'DECOMMISSIONED' } },
    select: { id: true, name: true, hostname: true, ipAddress: true, port: true, status: true, lastHeartbeatAt: true },
  });
  if (!node || SENTINEL_NODE_IDS.includes(node.id)) throw new Error('Managed node not found');
  return node;
}

function attachNode(node: NodeTarget, state: CodexNodeState): CodexFleetInstallation {
  return {
    ...state,
    nodeId: node.id,
    nodeName: node.name,
    hostname: node.hostname,
    nodeStatus: node.status,
    lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null,
    reachable: true,
  };
}

function unreachableNode(node: NodeTarget, error: unknown): CodexFleetInstallation {
  const message = error instanceof Error ? error.message.slice(0, 500) : 'Node agent unavailable';
  return {
    nodeId: node.id,
    nodeName: node.name,
    hostname: node.hostname,
    nodeStatus: node.status,
    lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null,
    reachable: false,
    installed: false,
    user: '',
    userHome: '',
    codexHome: '',
    codexBin: null,
    version: null,
    latestVersion: null,
    updateAvailable: false,
    provenance: 'unknown',
    updateSupported: false,
    auth: {
      status: 'error', mode: null, oauth: false, tokenExpiresAt: null,
      tokenExpired: null, refreshTokenPresent: false, lastRefreshAt: null,
      planType: null, autoLoggedOut: false, message: 'Node agent could not report Codex state.',
    },
    checkedAt: new Date().toISOString(),
    error: message,
  };
}

async function scanCodexInstallations(refreshLatest: boolean): Promise<CodexFleetInstallation[]> {
  const nodes = await getDb().node.findMany({
    where: { id: { notIn: SENTINEL_NODE_IDS }, status: { not: 'DECOMMISSIONED' } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, hostname: true, ipAddress: true, port: true, status: true, lastHeartbeatAt: true },
  });
  const results: CodexFleetInstallation[] = [];
  for (let offset = 0; offset < nodes.length; offset += 5) {
    const batch = nodes.slice(offset, offset + 5);
    results.push(...await Promise.all(batch.map(async (node) => {
      try {
        const response = await clientFor(node).getCodexState(refreshLatest);
        return attachNode(node, response.data);
      } catch (error) {
        return unreachableNode(node, error);
      }
    })));
  }
  return results;
}

export async function refreshCodexFleetCache(refreshLatest = true): Promise<CodexFleetInstallation[]> {
  if (fleetRefreshInFlight) return fleetRefreshInFlight;
  const startedAt = Date.now();
  fleetRefreshInFlight = scanCodexInstallations(refreshLatest)
    .then((installations) => {
      fleetCache = { installations, refreshedAt: new Date().toISOString() };
      const detected = installations.filter((item) => item.installed && item.reachable).length;
      console.log(`[codex-fleet] refreshed ${detected}/${installations.length} installation(s) in ${Date.now() - startedAt}ms`);
      return installations;
    })
    .finally(() => {
      fleetRefreshInFlight = null;
    });
  return fleetRefreshInFlight;
}

export async function listCodexInstallations(refreshLatest = false): Promise<CodexFleetInstallation[]> {
  if (refreshLatest) return refreshCodexFleetCache(true);
  if (fleetCache) {
    if (Date.now() - Date.parse(fleetCache.refreshedAt) >= codexFleetScanIntervalMs()) {
      void refreshCodexFleetCache(true).catch((error: unknown) => {
        console.warn(`[codex-fleet] stale-cache refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    return fleetCache.installations;
  }
  return refreshCodexFleetCache(true);
}

export function getCodexFleetPosture(): CodexFleetPosture {
  const installations = fleetCache?.installations ?? [];
  const detected = installations.filter((item) => item.installed && item.reachable);
  return {
    status: fleetCache ? 'ready' : 'warming',
    generatedAt: new Date().toISOString(),
    refreshedAt: fleetCache?.refreshedAt ?? null,
    ageMs: fleetCache ? Math.max(0, Date.now() - Date.parse(fleetCache.refreshedAt)) : null,
    scanIntervalMs: codexFleetScanIntervalMs(),
    scanInProgress: fleetRefreshInFlight !== null,
    managedNodes: installations.length,
    installations: detected.length,
    authenticatedWithChatgptOauth: detected.filter((item) => item.auth.oauth).length,
    updatesAvailable: detected.filter((item) => item.updateAvailable).length,
    needsLogin: detected.filter((item) => !item.auth.oauth).length,
    currentRelease: detected.find((item) => item.latestVersion)?.latestVersion ?? null,
    nodes: detected.map((item) => ({
      nodeId: item.nodeId,
      nodeName: item.nodeName,
      hostname: item.hostname,
      version: item.version,
      latestVersion: item.latestVersion,
      updateAvailable: item.updateAvailable,
      authStatus: item.auth.status,
      oauth: item.auth.oauth,
      checkedAt: item.checkedAt,
    })),
  };
}

export function startCodexFleetMonitor(): void {
  if (fleetMonitorTimer) return;
  const intervalMs = codexFleetScanIntervalMs();
  const refresh = (): void => {
    void refreshCodexFleetCache(true).catch((error: unknown) => {
      console.warn(`[codex-fleet] refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  refresh();
  fleetMonitorTimer = setInterval(refresh, intervalMs);
  fleetMonitorTimer.unref();
  console.log(`[codex-fleet] monitor started with ${intervalMs}ms interval`);
}

export function stopCodexFleetMonitor(): void {
  if (!fleetMonitorTimer) return;
  clearInterval(fleetMonitorTimer);
  fleetMonitorTimer = null;
}

function replaceCachedInstallation(installation: CodexFleetInstallation): void {
  if (!fleetCache) return;
  fleetCache = {
    ...fleetCache,
    installations: fleetCache.installations.map((item) =>
      item.nodeId === installation.nodeId ? installation : item),
  };
}

export async function getCodexInstallation(nodeId: string, refreshLatest = false): Promise<CodexFleetInstallation> {
  const node = await nodeTarget(nodeId);
  const response = await clientFor(node).getCodexState(refreshLatest);
  const installation = attachNode(node, response.data);
  replaceCachedInstallation(installation);
  return installation;
}

export async function updateCodexInstallation(nodeId: string): Promise<CodexFleetInstallation> {
  const node = await nodeTarget(nodeId);
  const response = await clientFor(node).updateCodex();
  const installation = attachNode(node, response.data);
  replaceCachedInstallation(installation);
  return installation;
}

export async function logoutCodexInstallation(nodeId: string): Promise<CodexFleetInstallation> {
  const node = await nodeTarget(nodeId);
  const response = await clientFor(node).logoutCodex();
  const installation = attachNode(node, response.data);
  replaceCachedInstallation(installation);
  return installation;
}

export async function startCodexDeviceLogin(nodeId: string): Promise<CodexDeviceAuthSession> {
  return (await clientFor(await nodeTarget(nodeId)).startCodexDeviceAuth()).data;
}

export async function getCodexDeviceLogin(nodeId: string, sessionId: string): Promise<CodexDeviceAuthSession> {
  return (await clientFor(await nodeTarget(nodeId)).getCodexDeviceAuth(sessionId)).data;
}

export async function cancelCodexDeviceLogin(nodeId: string, sessionId: string): Promise<CodexDeviceAuthSession> {
  return (await clientFor(await nodeTarget(nodeId)).cancelCodexDeviceAuth(sessionId)).data;
}
