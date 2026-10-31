/** Read-only Linux socket ownership proof for an existing Hermes dashboard.
 * Never launch a CLI/server, connect to a port, or infer listening from a unit's
 * process status. Return no endpoint on incomplete/ambiguous observations.
 */
import { constants } from 'node:fs';
import { open, readdir, readlink, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

export interface DashboardObservation {
  status: 'running' | 'unknown';
  host: string | null;
  port: number | null;
  source: 'linux-proc-owned-listener';
  reason: 'observed' | 'unsupported' | 'unavailable' | 'not-observed' | 'ambiguous';
}
const unknown = (reason: DashboardObservation['reason']): DashboardObservation =>
  ({ status: 'unknown', host: null, port: null, source: 'linux-proc-owned-listener', reason });

async function bounded(path: string, limit = 65536): Promise<string> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await fd.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > limit) throw Error('inspection bound');
    return buffer.subarray(0, used).toString('utf8');
  } finally { await fd.close(); }
}
function startTick(text: string): string {
  const value = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  if (!value || !/^\d+$/.test(value)) throw Error('process identity unavailable');
  return value;
}
function dashboardArgs(args: string[]): { port: number } | null {
  const module = args.indexOf('-m');
  const command = module >= 0 && args[module + 1] === 'hermes_cli.main'
    ? module + 2 : ['hermes', 'hermes.exe'].includes(basename(args[0] ?? '')) ? 1
      : ['hermes', 'hermes.exe'].includes(basename(args[1] ?? '')) ? 2 : -1;
  if (command < 0 || args[command] !== 'dashboard') return null;
  const rest = args.slice(command + 1);
  // Registration and headless serve are not a native dashboard listener.
  if (rest.includes('register') || args.some(arg => arg === '--profile' || arg.startsWith('--profile='))) return null;
  let port = 9119;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--port') port = Number(rest[++i]);
    else if (rest[i]?.startsWith('--port=')) port = Number(rest[i]!.slice(7));
  }
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? { port } : null;
}
export function procListeners(text: string, ipv6: boolean, sockets: Set<string>, port: number): Array<{ host: string; port: number }> {
  const results: Array<{ host: string; port: number }> = [];
  for (const line of text.split('\n').slice(1)) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) throw Error('malformed socket inventory');
    if (fields[3] !== '0A' || !sockets.has(fields[9]!)) continue;
    const [address, hexPort] = fields[1]!.split(':');
    if (!address || !hexPort || !/^[A-Fa-f0-9]{4}$/.test(hexPort)
      || !(ipv6 ? /^[A-Fa-f0-9]{32}$/ : /^[A-Fa-f0-9]{8}$/).test(address)) throw Error('malformed listener');
    const foundPort = Number.parseInt(hexPort, 16);
    if (!foundPort || (port !== 0 && foundPort !== port)) continue;
    const bytes: number[] = [];
    for (let offset = 0; offset < address.length; offset += 8) {
      for (let index = offset + 6; index >= offset; index -= 2) bytes.push(Number.parseInt(address.slice(index, index + 2), 16));
    }
    const host = ipv6 ? Array.from({ length: 8 }, (_, i) => ((bytes[i * 2]! << 8) | bytes[i * 2 + 1]!).toString(16)).join(':') : bytes.join('.');
    results.push({ host: ipv6 ? new URL(`http://[${host}]`).hostname.slice(1, -1) : host, port: foundPort });
  }
  return results;
}

export async function observeHermesDashboard(home: string, options: { procRoot?: string; platform?: string; timeoutMs?: number } = {}): Promise<DashboardObservation> {
  if ((options.platform ?? process.platform) !== 'linux') return unknown('unsupported');
  const root = options.procRoot ?? '/proc';
  const deadline = Date.now() + Math.min(options.timeoutMs ?? 2500, 5000);
  const check = () => { if (Date.now() >= deadline) throw Error('inspection deadline'); };
  try {
    const owner = (await stat(home)).uid;
    const pids = (await readdir(root)).filter(value => /^\d+$/.test(value));
    if (pids.length > 8192) return unknown('unavailable');
    const found: Array<{ host: string; port: number }> = [];
    for (const pid of pids) {
      check(); const dir = join(root, pid);
      try {
        if ((await stat(dir)).uid !== owner) continue;
        const args = (await bounded(join(dir, 'cmdline'))).split('\0').filter(Boolean);
        const dashboard = dashboardArgs(args);if (!dashboard) continue;
        const before = startTick(await bounded(join(dir, 'stat')));
        // Scope to the actual process home. Never expose other environment keys.
        const env = (await bounded(join(dir, 'environ'), 262144)).split('\0');
        const configured = env.find(value => value.startsWith('HERMES_HOME='))?.slice(12);
        const userHome = env.find(value => value.startsWith('HOME='))?.slice(5);
        const processHome = configured ?? (userHome ? join(userHome, '.hermes') : null);
        if (!processHome || !isAbsolute(processHome) || resolve(processHome) !== resolve(home)) continue;
        const fds = await readdir(join(dir, 'fd'));if (fds.length > 4096) throw Error('descriptor bound');
        const sockets = new Set<string>();
        for (const fd of fds) {
          check();
          try { const link = await readlink(join(dir, 'fd', fd));const match = /^socket:\[(\d+)\]$/.exec(link);if (match) sockets.add(match[1]!); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        const processEndpoints: Array<{ host: string; port: number }> = [];
        for (const [name, ipv6] of [['tcp', false], ['tcp6', true]] as const) {
          try { processEndpoints.push(...procListeners(await bounded(join(dir, 'net', name), 1024 * 1024), ipv6, sockets, dashboard.port)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        if (startTick(await bounded(join(dir, 'stat'))) !== before) return unknown('unavailable');
        found.push(...processEndpoints);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // exited during observation
        return unknown('unavailable');
      }
    }
    check();
    const endpoints = [...new Map(found.map(value => [`${value.host}:${value.port}`, value])).values()];
    if (endpoints.length !== 1) return unknown(endpoints.length ? 'ambiguous' : 'not-observed');
    return { status: 'running', ...endpoints[0]!, source: 'linux-proc-owned-listener', reason: 'observed' };
  } catch { return unknown('unavailable'); }
}
