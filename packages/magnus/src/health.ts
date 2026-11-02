/** Waiting until a (re)started version is really serving. */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { compareVersions } from '@hivemagnus/magnus-contracts';
import { readEnvFile } from './env-file.js';
import type { Io } from './io.js';
import type { ProbeOptions } from './probe.js';
import type { Project } from './project.js';

export interface RuntimeInfo {
  version: string;
  pid: number;
  port: number;
  /** Bind address (1.1.3+). */
  host?: string;
  startedAt: string;
}

export function runtimeFile(project: Project): string {
  return project.path('run', 'server-runtime.json');
}

/**
 * Every place a server of this project may write its runtime file: the
 * project's run/ (the units set MAGNUS_RUNTIME_FILE), the env file's
 * MAGNUS_RUNTIME_FILE, and MAGNUS_HOME/run (a server started without either).
 */
export function runtimeFiles(project: Project): string[] {
  let env: Record<string, string> = {};
  try {
    env = readEnvFile(project.envFile('server'));
  } catch { /* the upgrade reports unreadable env files itself */ }
  const home = env['MAGNUS_HOME'] ? (isAbsolute(env['MAGNUS_HOME']) ? env['MAGNUS_HOME'] : project.path(env['MAGNUS_HOME'])) : project.path('data');
  return [...new Set([runtimeFile(project), ...(env['MAGNUS_RUNTIME_FILE'] ? [env['MAGNUS_RUNTIME_FILE']] : []), join(home, 'run', 'server-runtime.json')])];
}

/** The most recently started server among the runtime files. */
export function readRuntime(project: Project): RuntimeInfo | null {
  let newest: RuntimeInfo | null = null;
  for (const file of runtimeFiles(project)) {
    if (!existsSync(file)) continue;
    try {
      const info = JSON.parse(readFileSync(file, 'utf8')) as RuntimeInfo;
      if (!newest || Date.parse(info.startedAt) > Date.parse(newest.startedAt)) newest = info;
    } catch { /* being rewritten */ }
  }
  return newest;
}

/** Loopback for wildcard binds, otherwise the address the server listens on. */
export function probeHost(host: string | undefined): string {
  if (!host || host === '0.0.0.0' || host === '::' || host === '*' || host === 'localhost') return '127.0.0.1';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * The certificate a component serves, from its env file. Absent when the file
 * or setting is missing or unreadable, which Io.probe handles.
 */
export function probeOptions(project: Project, component: 'server' | 'ui'): ProbeOptions {
  try {
    const configured = readEnvFile(project.envFile(component))['TLS_CERT_PATH'];
    if (!configured) return {};
    const pem = readFileSync(isAbsolute(configured) ? configured : project.path(configured), 'utf8');
    return pem.includes('BEGIN CERTIFICATE') ? { ca: pem } : {};
  } catch {
    return {};
  }
}

export interface WaitOptions {
  version: string;
  /** The runtime file must name a process started after this instant. */
  startedAfter: Date;
  timeoutMs: number;
  /** Stop waiting early (an interrupted upgrade). */
  abort?: () => boolean;
}

export interface HealthResult {
  ok: boolean;
  detail: string;
}

/**
 * Healthy means: the runtime file reports the expected version from a process
 * started after the restart, /api/v1/health answers 200, and the console (if
 * installed) answers below 500.
 */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** First server release that writes run/server-runtime.json. */
export const RUNTIME_FILE_SINCE = '1.1.0';

export async function waitForHealthy(io: Io, project: Project, options: WaitOptions): Promise<HealthResult> {
  const deadline = io.now().getTime() + options.timeoutMs;
  // Servers before RUNTIME_FILE_SINCE do not report their version.
  const legacy = compareVersions(options.version, RUNTIME_FILE_SINCE) < 0;
  let last = 'no answer yet';
  while (io.now().getTime() < deadline) {
    if (options.abort?.()) return { ok: false, detail: `interrupted: ${last}` };
    const reported = readRuntime(project);
    // Older servers do not write the runtime file: wait until the process that wrote it (a newer one) is gone.
    const runtime = legacy
      ? (reported && reported.version !== options.version && processAlive(reported.pid) ? reported
        : { version: options.version, pid: 0, port: project.state.ports.server, startedAt: io.now().toISOString() })
      : reported;
    if (!runtime) last = 'the server has not written its runtime file';
    else if (new Date(runtime.startedAt).getTime() < options.startedAfter.getTime() - 1_000) {
      last = `no server has started since the restart (the last one ran ${runtime.version})`;
    } else if (runtime.version !== options.version) last = `serving ${runtime.version}, expected ${options.version}`;
    else {
      const server = await io.probe(`https://${probeHost(runtime.host)}:${runtime.port || project.state.ports.server}/api/v1/health`, probeOptions(project, 'server'));
      if (server !== 200) last = `/api/v1/health answered ${server ?? 'nothing'}`;
      else if (!project.state.components.includes('ui')) return { ok: true, detail: `server ${runtime.version} healthy` };
      else {
        const ui = await io.probe(`https://127.0.0.1:${project.state.ports.ui}/login`, probeOptions(project, 'ui'));
        if (ui !== null && ui < 500) return { ok: true, detail: `server ${runtime.version} and console healthy` };
        last = `the console answered ${ui ?? 'nothing'}`;
      }
    }
    await io.sleep(2_000);
  }
  return { ok: false, detail: `not healthy after ${Math.round(options.timeoutMs / 1000)} s: ${last}` };
}
