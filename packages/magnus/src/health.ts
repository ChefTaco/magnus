/** Waiting until a (re)started version is really serving. */
import { existsSync, readFileSync } from 'node:fs';
import { compareVersions } from '@hivemagnus/magnus-contracts';
import type { Io } from './io.js';
import type { Project } from './project.js';

export interface RuntimeInfo {
  version: string;
  pid: number;
  port: number;
  startedAt: string;
}

export function runtimeFile(project: Project): string {
  return project.path('run', 'server-runtime.json');
}

export function readRuntime(project: Project): RuntimeInfo | null {
  const file = runtimeFile(project);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RuntimeInfo;
  } catch {
    return null;
  }
}

export interface WaitOptions {
  version: string;
  /** The runtime file must name a process started after this instant. */
  startedAfter: Date;
  timeoutMs: number;
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
      const server = await io.probe(`https://127.0.0.1:${project.state.ports.server}/api/v1/health`);
      if (server !== 200) last = `/api/v1/health answered ${server ?? 'nothing'}`;
      else if (!project.state.components.includes('ui')) return { ok: true, detail: `server ${runtime.version} healthy` };
      else {
        const ui = await io.probe(`https://127.0.0.1:${project.state.ports.ui}/login`);
        if (ui !== null && ui < 500) return { ok: true, detail: `server ${runtime.version} and console healthy` };
        last = `the console answered ${ui ?? 'nothing'}`;
      }
    }
    await io.sleep(2_000);
  }
  return { ok: false, detail: `not healthy after ${Math.round(options.timeoutMs / 1000)} s: ${last}` };
}
