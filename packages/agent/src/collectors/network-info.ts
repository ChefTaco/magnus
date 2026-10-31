/**
 * network-info.ts — Network information collector for dependency mapping.
 *
 * Provides listening ports and established connections data
 * so the control API can build a dependency graph.
 */

import { Hono } from 'hono';
import { execSync } from 'node:child_process';

export const networkInfoRoutes = new Hono();

interface ListeningPort {
  port: number;
  protocol: string;
  process: string;
  pid?: number;
}

interface Connection {
  localPort: number;
  remoteIp: string;
  remotePort: number;
  state: string;
}

/**
 * GET /network-info
 * Returns listening ports and established connections on this host.
 */
networkInfoRoutes.get('/', async (c) => {
  const listeningPorts = getListeningPorts();
  const connections = getEstablishedConnections();

  return c.json({
    listeningPorts,
    connections,
    timestamp: new Date().toISOString(),
  });
});

function getListeningPorts(): ListeningPort[] {
  try {
    // Use ss to get listening sockets with process info
    const output = execSync('ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const ports: ListeningPort[] = [];
    const lines = output.split('\n').slice(1); // skip header

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;

      // Parse local address (e.g., 0.0.0.0:22 or *:22 or :::22)
      const localAddr = parts[3] ?? '';
      const portMatch = localAddr.match(/:(\d+)$/);
      if (!portMatch) continue;

      const port = Number(portMatch[1]);
      if (isNaN(port)) continue;

      // Extract process name from `users:(("sshd",pid=1234,fd=3))`
      const processInfo = parts.find((p) => p.startsWith('users:'));
      let process = 'unknown';
      let pid: number | undefined;
      if (processInfo) {
        const nameMatch = processInfo.match(/\("([^"]+)"/);
        const pidMatch = processInfo.match(/pid=(\d+)/);
        if (nameMatch) process = nameMatch[1]!;
        if (pidMatch) pid = Number(pidMatch[1]);
      } else if (parts[0] === 'tcp' || parts[0] === 'tcp6') {
        const netstatProcess = parts[6]?.match(/^(\d+)\/(.+)$/);
        if (netstatProcess) {
          pid = Number(netstatProcess[1]);
          process = netstatProcess[2]!;
        }
      }

      ports.push({ port, protocol: 'tcp', process, pid });
    }

    // Dedupe by port
    const seen = new Set<number>();
    return ports.filter((p) => {
      if (seen.has(p.port)) return false;
      seen.add(p.port);
      return true;
    });
  } catch {
    return [];
  }
}

function getEstablishedConnections(): Connection[] {
  try {
    const output = execSync('ss -tn state established 2>/dev/null || netstat -tn 2>/dev/null | grep ESTABLISHED', {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const connections: Connection[] = [];
    // The netstat fallback is already filtered and has no header. Do not
    // discard its first connection; headers fail the row checks below.
    const lines = output.split('\n');

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;

      // `ss -tn state established` omits the State column, leaving
      // Recv-Q, Send-Q, Local, Peer. netstat starts with Proto instead.
      const isNetstat = parts[0] === 'tcp' || parts[0] === 'tcp6';
      if (isNetstat ? parts[5] !== 'ESTABLISHED' : !/^\d+$/.test(parts[0] ?? '')) continue;
      const localIndex = isNetstat ? 3 : 2;
      const localAddr = parts[localIndex] ?? '';
      const remoteAddr = parts[localIndex + 1] ?? '';

      const localMatch = localAddr.match(/:(\d+)$/);
      const remoteMatch = remoteAddr.match(/^(.+):(\d+)$/);
      if (!localMatch || !remoteMatch) continue;

      const localPort = Number(localMatch[1]);
      const remoteIp = remoteMatch[1]!.replace(/^\[|]$/g, ''); // strip IPv6 brackets
      const remotePort = Number(remoteMatch[2]);

      if (isNaN(localPort) || isNaN(remotePort)) continue;
      // Skip localhost connections
      if (remoteIp === '127.0.0.1' || remoteIp === '::1') continue;

      connections.push({ localPort, remoteIp, remotePort, state: 'ESTABLISHED' });
    }

    return connections;
  } catch {
    return [];
  }
}
