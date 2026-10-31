import * as os from 'node:os';
import { readFileSync } from 'node:fs';
import { exec } from 'node:child_process';
import type { HealthSnapshot, HealthProvider } from '../types/index.js';
import { collectDockerGroupService } from './docker-group.js';
import { collectSystemUpdates } from './system-updates.js';
import { collectTailscaleNodeKey } from './tailscale-node-key.js';
import { collectGpuTelemetry } from './gpu-collector.js';
import { collectCredentialRenewalPosture } from '../credential-renewal.js';

type WazuhAgentInfo = {
  installed: boolean;
  serviceStatus: 'active' | 'inactive' | 'failed' | 'not_installed' | 'unknown';
  enabled: 'enabled' | 'disabled' | 'static' | 'unknown';
  version: string | null;
  managerAddresses: string[];
};

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Async wrapper for shell commands (replaces execSync). The deadline is a
 * race, not only exec's own timeout: a probe stuck in uninterruptible IO
 * (e.g. `df` on a hung network mount) may never exit after SIGKILL, and the
 * heartbeat must not wait on it.
 */
function execAsync(cmd: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Probe timed out after ${timeoutMs}ms: ${cmd.split(' ')[0]}`)), timeoutMs);
    exec(cmd, { encoding: 'utf-8', timeout: timeoutMs, killSignal: 'SIGKILL' }, (err, stdout) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** Check if Cockpit is available — cached for 5 minutes. */
let _cockpitCache: { value: boolean; expires: number } | null = null;

async function isCockpitAvailable(): Promise<boolean> {
  if (_cockpitCache && Date.now() < _cockpitCache.expires) return _cockpitCache.value;
  try {
    await execAsync('systemctl is-active cockpit.socket');
    _cockpitCache = { value: true, expires: Date.now() + 5 * 60 * 1000 };
    return true;
  } catch {
    _cockpitCache = { value: false, expires: Date.now() + 5 * 60 * 1000 };
    return false;
  }
}

/** Baseline snapshot for delta-based CPU calculation. Updated on every call. */
let prevCpuSample: { totalIdle: number; totalTick: number } | null = null;

/** Collect CPU information via /proc/stat or os module. */
function collectCpu(): { usagePercent: number; cores: number; model: string; loadAverage: [number, number, number] } {
  const cpus = os.cpus();
  const loadAvg = os.loadavg() as [number, number, number];

  // Sum cumulative CPU tick totals from os.cpus()
  let totalIdle = 0;
  let totalTick = 0;
  for (const cpu of cpus) {
    const { user, nice, sys, idle, irq } = cpu.times;
    totalTick += user + nice + sys + idle + irq;
    totalIdle += idle;
  }

  // Compute usage as delta from previous sample so we report current-interval
  // usage rather than the lifetime average since boot.
  let usagePercent = 0;
  if (prevCpuSample !== null) {
    const idleDelta = totalIdle - prevCpuSample.totalIdle;
    const tickDelta = totalTick - prevCpuSample.totalTick;
    usagePercent = tickDelta > 0 ? Math.round((1 - idleDelta / tickDelta) * 10000) / 100 : 0;
  }
  // Always store current totals as the baseline for next call
  prevCpuSample = { totalIdle, totalTick };

  return {
    usagePercent,
    cores: cpus.length,
    model: cpus[0]?.model ?? 'unknown',
    loadAverage: loadAvg,
  };
}

/** Collect memory information. */
async function collectMemory(): Promise<{
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usagePercent: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}> {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;

  let swapTotalBytes = 0;
  let swapUsedBytes = 0;
  try {
    const memInfo = await execAsync('cat /proc/meminfo');
    const swapTotal = memInfo.match(/SwapTotal:\s+(\d+)/);
    const swapFree = memInfo.match(/SwapFree:\s+(\d+)/);
    if (swapTotal?.[1]) swapTotalBytes = parseInt(swapTotal[1], 10) * 1024;
    if (swapFree?.[1]) swapUsedBytes = swapTotalBytes - parseInt(swapFree[1], 10) * 1024;
  } catch {
    // swapinfo not available
  }

  return {
    totalBytes,
    usedBytes,
    freeBytes,
    usagePercent: Math.round((usedBytes / totalBytes) * 10000) / 100,
    swapTotalBytes,
    swapUsedBytes,
  };
}

export interface CollectedDisk {
  mountPoint: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usagePercent: number;
  filesystem: string;
  filesystemType: string;
}

const VIRTUAL_DISK_TYPES = new Set([
  'devtmpfs',
  'efivarfs',
  'overlay',
  'proc',
  'squashfs',
  'sysfs',
  'tmpfs',
]);

/** Parse persistent local, network, and user-share filesystems from `df`. */
export function parseDiskOutput(output: string): CollectedDisk[] {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line): CollectedDisk | null => {
      const parts = line.trim().split(/\s+/);
      const filesystem = parts[0] ?? '';
      const filesystemType = parts[1] ?? '';
      const mountPoint = parts[6] ?? '';
      if (!filesystem || !mountPoint.startsWith('/') || VIRTUAL_DISK_TYPES.has(filesystemType)) {
        return null;
      }
      return {
        filesystem,
        filesystemType,
        mountPoint,
        totalBytes: parseInt(parts[2] ?? '0', 10),
        usedBytes: parseInt(parts[3] ?? '0', 10),
        freeBytes: parseInt(parts[4] ?? '0', 10),
        usagePercent: parseInt((parts[5] ?? '0').replace('%', ''), 10),
      };
    })
    .filter((disk): disk is CollectedDisk => disk !== null);
}

/** Collect disk info via `df`. */
async function collectDisks(): Promise<CollectedDisk[]> {
  try {
    const output = await execAsync('df -B1 --output=source,fstype,size,used,avail,pcent,target 2>/dev/null | tail -n +2');
    return parseDiskOutput(output);
  } catch {
    return [];
  }
}

/** Collect network interface info with live rx/tx stats from /proc/net/dev. */
function collectNetwork(): Array<{
  interface: string;
  rxBytes: number;
  txBytes: number;
  rxErrors: number;
  txErrors: number;
  ipAddress: string;
}> {
  const interfaces = os.networkInterfaces();

  // Parse /proc/net/dev for byte counters
  let procStats: Record<string, { rxBytes: number; txBytes: number; rxErrors: number; txErrors: number }> = {};
  try {
    const raw = readFileSync('/proc/net/dev', 'utf-8');
    for (const line of raw.split('\n').slice(2)) {
      const match = line.match(/^\s*(\S+):\s+(\d+)\s+\d+\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)\s+\d+\s+(\d+)/);
      if (match) {
        procStats[match[1]!] = {
          rxBytes: parseInt(match[2]!, 10),
          rxErrors: parseInt(match[3]!, 10),
          txBytes: parseInt(match[4]!, 10),
          txErrors: parseInt(match[5]!, 10),
        };
      }
    }
  } catch {
    // /proc/net/dev not available (non-Linux)
    procStats = {};
  }

  const result: Array<{ interface: string; rxBytes: number; txBytes: number; rxErrors: number; txErrors: number; ipAddress: string }> = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs || name === 'lo') continue;
    const ipv4 = addrs.find((a) => a.family === 'IPv4');
    if (ipv4) {
      const stats = procStats[name];
      result.push({
        interface: name,
        rxBytes: stats?.rxBytes ?? 0,
        txBytes: stats?.txBytes ?? 0,
        rxErrors: stats?.rxErrors ?? 0,
        txErrors: stats?.txErrors ?? 0,
        ipAddress: ipv4.address,
      });
    }
  }
  return result;
}

/** Collect active systemd services. */
async function collectServices(): Promise<Array<{
  name: string;
  status: 'active' | 'inactive' | 'failed' | 'unknown';
  pid: number | null;
  memoryBytes: number | null;
  cpuPercent: number | null;
}>> {
  try {
    const output = await execAsync(
      'systemctl list-units --type=service --state=active,failed --no-pager --no-legend --plain 2>/dev/null | head -30',
    );
    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        const name = (parts[0] ?? '').replace('.service', '');
        const sub = parts[3] ?? 'unknown';
        const status: 'active' | 'failed' | 'unknown' =
          sub === 'running' || sub === 'exited' || sub === 'waiting'
            ? 'active'
            : sub === 'failed'
              ? 'failed'
              : 'unknown';
        return {
          name,
          status,
          pid: null,
          memoryBytes: null,
          cpuPercent: null,
        };
      });
  } catch {
    return [];
  }
}

function getSystemdProperty(output: string, property: string): string {
  return output
    .split('\n')
    .find((line) => line.startsWith(`${property}=`))
    ?.slice(property.length + 1)
    .trim() ?? '';
}

/**
 * Report the local Wazuh agent posture without reading or exposing credentials.
 * The manager addresses are useful fleet inventory; keys and registration data
 * in ossec.conf are intentionally excluded.
 */
async function collectWazuhAgent(): Promise<WazuhAgentInfo> {
  const result: WazuhAgentInfo = {
    installed: false,
    serviceStatus: 'not_installed',
    enabled: 'unknown',
    version: null,
    managerAddresses: [],
  };

  try {
    const unit = await execAsync(
      'systemctl show wazuh-agent.service --property=LoadState --property=ActiveState --property=UnitFileState --no-pager 2>/dev/null',
    );
    const loadState = getSystemdProperty(unit, 'LoadState');
    const activeState = getSystemdProperty(unit, 'ActiveState');
    const unitFileState = getSystemdProperty(unit, 'UnitFileState');

    result.installed = loadState !== '' && loadState !== 'not-found';
    if (result.installed) {
      result.serviceStatus = activeState === 'active'
        ? 'active'
        : activeState === 'failed'
          ? 'failed'
          : activeState === 'inactive'
            ? 'inactive'
            : 'unknown';
      result.enabled = unitFileState === 'enabled'
        ? 'enabled'
        : unitFileState === 'disabled'
          ? 'disabled'
          : unitFileState === 'static'
            ? 'static'
            : 'unknown';
    }
  } catch {
    // A non-systemd host or a missing unit is represented as not installed.
  }

  if (!result.installed) {
    try {
      const version = (await execAsync("dpkg-query -W -f='${Version}' wazuh-agent 2>/dev/null")).trim();
      if (version) {
        result.installed = true;
        result.serviceStatus = 'unknown';
        result.version = version;
      }
    } catch {
      return result;
    }
  }

  if (!result.version) {
    try {
      const version = (await execAsync("dpkg-query -W -f='${Version}' wazuh-agent 2>/dev/null")).trim();
      result.version = version || null;
    } catch {
      // Package metadata is unavailable on non-Debian installations.
    }
  }

  try {
    const config = readFileSync('/var/ossec/etc/ossec.conf', 'utf-8');
    result.managerAddresses = [...config.matchAll(/<address>\s*([^<\s]+)\s*<\/address>/gi)]
      .map((match) => match[1] ?? '')
      .filter(Boolean)
      .filter((address, index, values) => values.indexOf(address) === index);
  } catch {
    // The service can be installed while the config is unreadable or not yet provisioned.
  }

  return result;
}

/** Main health collection — always uses system probes. Reports cockpitAvailable so the
 *  dashboard can surface Cockpit links. Full Cockpit-API data integration is deferred. */
export async function collectSystemHealth(): Promise<
  Omit<HealthSnapshot, 'id' | 'nodeId' | 'timestamp'> & { source: HealthProvider }
> {
  const cockpitAvailable = await isCockpitAvailable();
  const source: HealthProvider = cockpitAvailable ? 'cockpit' : 'system-probe';

  // Collect probes in parallel to reduce wall-clock time
  const cpu = collectCpu();
  const [memory, disks, services, wazuh, systemUpdates, tailscaleNodeKey, gpu, hiveMemCredentials] = await Promise.all([
    collectMemory(),
    collectDisks(),
    collectServices(),
    collectWazuhAgent(),
    collectSystemUpdates(),
    collectTailscaleNodeKey(),
    collectGpuTelemetry(),
    collectCredentialRenewalPosture(),
  ]);
  const network = collectNetwork();
  services.unshift(tailscaleNodeKey, collectDockerGroupService(), ...hiveMemCredentials);

  return {
    cpu,
    memory,
    disks,
    network,
    services,
    wazuh,
    systemUpdates,
    gpu,
    cockpitAvailable,
    source,
  };
}
