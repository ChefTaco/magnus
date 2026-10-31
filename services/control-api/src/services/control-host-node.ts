import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { promises as dns } from 'node:dns';
import { arch, hostname as osHostname, networkInterfaces, platform } from 'node:os';
import { isIP } from 'node:net';
import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import { isUsableNodeIp, normalizeIpAddress } from '../utils/ip.js';
import {
  controlHostAgentTlsOptions,
  controlHostAgentTlsServername,
} from '../utils/local-tls.js';

interface AgentPingResponse {
  success?: boolean;
  data?: {
    ok?: boolean;
    version?: string;
    features?: {
      nodeManagement?: boolean;
    };
  };
}

interface LocalAgentProbe {
  port: number;
  version: string;
  nodeStatus: 'ONLINE' | 'OFFLINE';
  agentStatus: 'RUNNING' | 'STOPPED';
  verifiedTlsHostname?: string;
}

interface EnsureControlHostNodeOptions {
  force?: boolean;
  probeAgent?: () => Promise<LocalAgentProbe | null>;
  resolveAddress?: (hostname: string) => Promise<string>;
  db?: ReturnType<typeof getDb>;
}

const LOCAL_AGENT_PORT = Number(process.env['CONTROL_HOST_AGENT_PORT'] ?? process.env['AGENT_PORT'] ?? 4100);
const CACHE_TTL_MS = 30_000;
let lastEnsureAt = 0;
let inFlight: Promise<void> | null = null;

function controlHostNodeEnabled(): boolean {
  return process.env['CONTROL_HOST_NODE_ENABLED'] !== 'false';
}

function getControlHostName(): string {
  return (process.env['CONTROL_HOST_NODE_NAME'] ?? process.env['CONTROL_NODE_SELF_NAME'] ?? osHostname() ?? 'magnus').trim();
}

function shouldRegisterOfflineControlHost(name: string): boolean {
  if (process.env['CONTROL_HOST_NODE_REGISTER_OFFLINE'] === 'true') return true;
  if (process.env['CONTROL_HOST_NODE_REGISTER_OFFLINE'] === 'false') return false;
  return name === 'magnus';
}

function parseMetadata(metadata: string | null | undefined): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function getInterfaceIp(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal && isUsableNodeIp(address.address)) {
        return normalizeIpAddress(address.address);
      }
    }
  }
  return null;
}

export async function resolveControlHostAddress(hostname: string): Promise<string> {
  const configured = normalizeIpAddress(process.env['CONTROL_HOST_NODE_IP'] ?? '');
  if (configured && isUsableNodeIp(configured)) return configured;

  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    const resolved = records
      .map((record) => normalizeIpAddress(record.address))
      .find((address) => isUsableNodeIp(address));
    if (resolved) return resolved;
  } catch {
    // Fall through to local interface probing.
  }

  return getInterfaceIp() ?? '127.0.0.1';
}

function requestAgentPing(protocol: 'http' | 'https', port: number): Promise<AgentPingResponse | null> {
  const request = protocol === 'https' ? httpsRequest : httpRequest;

  return new Promise((resolve) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/v1/ping',
        method: 'GET',
        ...(protocol === 'https' ? controlHostAgentTlsOptions() : {}),
        timeout: 1_500,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) {
            resolve(null);
            return;
          }

          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as AgentPingResponse);
          } catch {
            resolve(null);
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

export async function probeLocalAgent(): Promise<LocalAgentProbe | null> {
  for (const protocol of ['https', 'http'] as const) {
    const response = await requestAgentPing(protocol, LOCAL_AGENT_PORT);
    if (
      response?.success === true &&
      response.data?.ok === true &&
      response.data.features?.nodeManagement !== false
    ) {
      const tlsServername = protocol === 'https'
        ? controlHostAgentTlsOptions().servername
        : undefined;
      return {
        port: LOCAL_AGENT_PORT,
        version: response.data.version ?? '0.0.0',
        nodeStatus: 'ONLINE',
        agentStatus: 'RUNNING',
        ...(typeof tlsServername === 'string' && tlsServername.trim()
          ? { verifiedTlsHostname: tlsServername.trim().toLowerCase() }
          : {}),
      };
    }
  }

  return null;
}

/** Prefer the DNS identity proven by the local HTTPS probe over a LAN address. */
export function selectControlHostNodeAddress(
  verifiedTlsHostname: string | undefined,
  fallbackAddress: string,
  existingAddress?: string,
  expectedTlsHostname?: string,
): string {
  const verified = verifiedTlsHostname?.trim().toLowerCase();
  if (verified) return verified;

  const existing = existingAddress?.trim().toLowerCase();
  const expected = expectedTlsHostname?.trim().toLowerCase();
  if (existing && expected && existing === expected && isIP(expected) === 0) return existing;
  return fallbackAddress;
}

export async function ensureControlHostNodeNow(options: EnsureControlHostNodeOptions): Promise<void> {
  if (!controlHostNodeEnabled()) return;

  const name = getControlHostName();
  const probe = await (options.probeAgent ?? probeLocalAgent)();
  if (!probe && !shouldRegisterOfflineControlHost(name)) return;

  const agentState = probe ?? {
    port: LOCAL_AGENT_PORT,
    version: '0.0.0',
    nodeStatus: 'OFFLINE' as const,
    agentStatus: 'STOPPED' as const,
  };

  const db = options.db ?? getDb();
  const fallbackHostname = (
    process.env['CONTROL_HOST_NODE_HOSTNAME']
    ?? osHostname()
    ?? name
  ).trim().toLowerCase();
  const now = new Date();

  const existing = await db.node.findFirst({
    where: {
      OR: [
        { name },
        { hostname: fallbackHostname },
      ],
    },
    select: { id: true, metadata: true, hostname: true, ipAddress: true },
  });

  const fallbackAddress = await (options.resolveAddress ?? resolveControlHostAddress)(fallbackHostname);
  const hostname = selectControlHostNodeAddress(
    agentState.verifiedTlsHostname,
    fallbackHostname,
    existing?.hostname,
    controlHostAgentTlsServername(),
  );
  const ipAddress = selectControlHostNodeAddress(
    agentState.verifiedTlsHostname,
    fallbackAddress,
    existing?.ipAddress,
    controlHostAgentTlsServername(),
  );

  const metadata = {
    ...parseMetadata(existing?.metadata),
    managedControlHost: true,
    localAgentProbeAt: now.toISOString(),
    localAgentReachable: Boolean(probe),
  };

  if (existing) {
    await db.node.update({
      where: { id: existing.id },
      data: {
        name,
        hostname,
        ipAddress,
        port: agentState.port,
        status: agentState.nodeStatus,
        os: platform(),
        arch: arch(),
        metadata: JSON.stringify(metadata),
        ...(probe ? { lastHeartbeatAt: now } : {}),
      },
    });
    await db.agent.upsert({
      where: { nodeId: existing.id },
      update: {
        version: agentState.version,
        status: agentState.agentStatus,
        lastCheckIn: now,
      },
      create: {
        nodeId: existing.id,
        version: agentState.version,
        status: agentState.agentStatus,
        capabilities: '[]',
      },
    });
    return;
  }

  const id = nanoid();
  await db.node.create({
    data: {
      id,
      name,
      hostname,
      ipAddress,
      port: agentState.port,
      status: agentState.nodeStatus,
      os: platform(),
      arch: arch(),
      token: `control-host-${id}`,
      metadata: JSON.stringify(metadata),
      ...(probe ? { lastHeartbeatAt: now } : {}),
    },
  });
  await db.agent.create({
    data: {
      nodeId: id,
      version: agentState.version,
      status: agentState.agentStatus,
      capabilities: '[]',
    },
  });
  console.log(`[ControlHost] Registered local managed node: ${name} (${ipAddress}:${agentState.port})`);
}

export async function ensureControlHostNode(options: EnsureControlHostNodeOptions = {}): Promise<void> {
  if (!options.force && Date.now() - lastEnsureAt < CACHE_TTL_MS) return;
  if (inFlight) return inFlight;

  inFlight = ensureControlHostNodeNow(options)
    .catch((err: unknown) => {
      console.warn(`[ControlHost] Failed to ensure local managed node: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      lastEnsureAt = Date.now();
      inFlight = null;
    });

  return inFlight;
}
