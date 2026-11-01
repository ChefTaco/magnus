#!/usr/bin/env node
/**
 * magnus-agent launcher: the stable process systemd starts. It runs the agent
 * from ./current and guards self-upgrades:
 *
 *   staged     the agent installed versions/<to>, pointed ./current at it and exited
 *   trial      the new version runs; it must report one accepted heartbeat
 *              (state "confirmed") before the deadline
 *   confirmed  done
 *   reverted   the trial failed (crash loop or no heartbeat in time); ./current
 *              points back at versions/<from>
 *
 * The launcher has no dependencies and never changes during an upgrade; only
 * `magnus-agent install-service` replaces it. It never escalates privileges.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LAUNCHER_PROTOCOL = 1;
export const STATE_FILE = 'upgrade-state.json';
const POLL_MS = 2_000;

/**
 * Pure decision for one launch.
 * @param {null | Record<string, any>} state
 * @param {number} now epoch ms
 * @param {number} confirmMs trial window
 * @returns {{ action: 'run' | 'revert', next: Record<string, any> | null, trial: boolean, reason?: string }}
 */
export function decideLaunch(state, now, confirmMs) {
  if (!state || typeof state !== 'object') return { action: 'run', next: null, trial: false };
  const maxAttempts = Number.isInteger(state.maxAttempts) && state.maxAttempts > 0 ? state.maxAttempts : 2;
  const stamp = new Date(now).toISOString();
  if (state.state === 'staged') {
    return { action: 'run', trial: true,
      next: { ...state, state: 'trial', attempt: 1, maxAttempts, trialDeadline: new Date(now + confirmMs).toISOString(), updatedAt: stamp } };
  }
  if (state.state === 'trial') {
    const deadline = Date.parse(state.trialDeadline ?? '');
    const attempt = Number.isInteger(state.attempt) ? state.attempt : maxAttempts;
    if (!Number.isFinite(deadline) || now >= deadline) {
      return { action: 'revert', trial: false, reason: `no confirmed heartbeat from ${state.to} within ${Math.round(confirmMs / 1000)} s`,
        next: { ...state, state: 'reverted', updatedAt: stamp } };
    }
    if (attempt >= maxAttempts) {
      return { action: 'revert', trial: false, reason: `${state.to} exited ${attempt} time(s) before reporting a heartbeat`,
        next: { ...state, state: 'reverted', updatedAt: stamp } };
    }
    return { action: 'run', trial: true, next: { ...state, attempt: attempt + 1, updatedAt: stamp } };
  }
  return { action: 'run', next: null, trial: false };
}

export function readState(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8'));
  } catch {
    return null;
  }
}

export function writeState(dir, state) {
  const path = join(dir, STATE_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const fd = openSync(temporary, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}

export function pointCurrentAt(dir, version) {
  const temporary = join(dir, `current.${process.pid}.tmp`);
  rmSync(temporary, { force: true });
  symlinkSync(join('versions', version), temporary, 'dir');
  renameSync(temporary, join(dir, 'current'));
}

function revert(dir, decision) {
  const state = decision.next;
  if (state.from && existsSync(join(dir, 'versions', state.from))) pointCurrentAt(dir, state.from);
  else state.reason = `${decision.reason}; versions/${state.from} is missing, so ./current was left as it is`;
  writeState(dir, { ...state, reason: state.reason ?? decision.reason });
  console.error(`[launcher] reverted ${state.to} -> ${state.from}: ${decision.reason}`);
}

export function confirmSeconds(env) {
  const value = Number.parseInt(env.MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS ?? '', 10);
  return Number.isInteger(value) && value >= 10 ? Math.min(value, 3600) : 180;
}

function main() {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const confirmMs = confirmSeconds(process.env) * 1000;
  const decision = decideLaunch(readState(dir), Date.now(), confirmMs);
  if (decision.action === 'revert') revert(dir, decision);
  else if (decision.next) writeState(dir, decision.next);

  const entry = join(dir, 'current', 'node_modules', '@hivemagnus', 'magnus-agent', 'dist', 'index.js');
  if (!existsSync(entry)) {
    console.error(`[launcher] ${entry} is missing; reinstall with magnus-agent install-service`);
    process.exit(1);
  }
  const child = spawn(process.execPath, [entry, 'start'], {
    cwd: dir,
    stdio: 'inherit',
    env: {
      ...process.env,
      AGENT_INSTALL_DIR: process.env.AGENT_INSTALL_DIR ?? dir,
      MAGNUS_AGENT_LAUNCHER: '1',
      MAGNUS_AGENT_LAUNCHER_PROTOCOL: String(LAUNCHER_PROTOCOL),
    },
  });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));

  let failedTrial = false;
  let watcher;
  if (decision.trial) {
    watcher = setInterval(() => {
      const state = readState(dir);
      if (!state || state.state !== 'trial') { clearInterval(watcher); return; }
      const verdict = decideLaunch({ ...state, attempt: 0 }, Date.now(), confirmMs);
      if (verdict.action === 'revert') {
        clearInterval(watcher);
        failedTrial = true;
        revert(dir, verdict);
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
      }
    }, POLL_MS);
  }
  child.on('exit', (code, signal) => {
    if (watcher) clearInterval(watcher);
    // Any exit restarts through systemd (Restart=always); a failed trial exits non-zero.
    process.exit(failedTrial ? 1 : code ?? (signal ? 1 : 0));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
