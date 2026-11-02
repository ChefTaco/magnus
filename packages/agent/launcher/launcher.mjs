#!/usr/bin/env node
/**
 * magnus-agent launcher: the stable process systemd starts. It runs the agent
 * from ./current and guards self-upgrades:
 *
 *   staged     the agent installed versions/<to>, pointed ./current at it and exited
 *   trial      the new version runs; it must report one accepted heartbeat
 *              (state "confirmed") before the deadline
 *   confirmed  done; ./last-good points at the confirmed version
 *   reverted   the trial failed (crash loop or no heartbeat in time); ./current
 *              points back at versions/<from> (or ./last-good)
 *   failed     the upgrade could not be started or reverted; ./current was left as it is
 *
 * A launcher write that fails (full or read-only disk) never stops the agent
 * from starting: the launcher logs it and runs the safest version it can. The
 * launcher has no dependencies. `magnus-agent install-service` installs it, and
 * a confirmed agent replaces it with its own copy only when that copy has a
 * higher LAUNCHER_PROTOCOL. It never escalates privileges.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lchownSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync,
  symlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 2: last-good, trial liveness marker, durable writes, state lock, MAGNUS_AGENT_LAUNCHER_CONFIRM_SECONDS. */
export const LAUNCHER_PROTOCOL = 2;
export const STATE_FILE = 'upgrade-state.json';
export const LOCK_FILE = 'upgrade-state.lock';
/** Written by an agent on trial whose heartbeats cannot reach the control API. */
export const ALIVE_FILE = 'trial-alive.json';
export const CRASH_FILE = 'launcher-crashes.json';
/** The trial window grows while the new version is alive but the control API is unreachable, up to this many windows. */
export const EXTENSION_FACTOR = 3;
export const ALIVE_FRESH_MS = 60_000;
/** Launches with an unreadable state file, within RAPID_WINDOW_MS, before falling back to ./last-good. */
export const RAPID_CRASHES = 3;
const RAPID_WINDOW_MS = 5 * 60_000;
const HEALTHY_RUN_MS = 2 * 60_000;
const POLL_MS = 2_000;
const ENTRY = ['node_modules', '@hivemagnus', 'magnus-agent', 'dist', 'index.js'];

const errorCode = error => error?.code ?? error?.message ?? String(error);

export function entryOf(dir, version) {
  return join(dir, 'versions', version, ...ENTRY);
}

export function complete(dir, version) {
  return typeof version === 'string' && version !== '' && existsSync(entryOf(dir, version));
}

/** The X of a `<name> -> versions/X` link, or null. */
export function linkVersion(dir, name) {
  try {
    const target = readlinkSync(join(dir, name));
    const match = /^versions[\\/]([^\\/]+)$/.exec(target);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function revertTarget(state, facts) {
  if (!facts.complete) return state.from ?? null;
  if (facts.complete(state.from)) return state.from;
  if (facts.lastGood && facts.lastGood !== state.to && facts.complete(facts.lastGood)) return facts.lastGood;
  return null;
}

function revertDecision(state, reason, facts, stamp) {
  const target = revertTarget(state, facts);
  const fullReason = target === null ? `${reason}; versions/${state.from} is missing and no other complete version exists, so ./current was left as it is`
    : target !== state.from ? `${reason}; versions/${state.from} is missing, so ./current points at last-good ${target}` : reason;
  return { action: 'revert', trial: false, target, reason: fullReason,
    next: { ...state, state: target === null ? 'failed' : 'reverted', reason: fullReason, updatedAt: stamp } };
}

/**
 * Pure decision for one launch.
 * @param {null | Record<string, any>} state
 * @param {number} now epoch ms
 * @param {number} confirmMs trial window
 * @param {{ current?: string | null, lastGood?: string | null, complete?: (version: string) => boolean }} [facts]
 *   current is the ./current link target (`versions/X`); complete tells whether versions/X can run
 * @returns {{ action: 'run' | 'revert', next: Record<string, any> | null, trial: boolean, reason?: string, target?: string | null }}
 */
export function decideLaunch(state, now, confirmMs, facts = {}) {
  if (!state || typeof state !== 'object') return { action: 'run', next: null, trial: false };
  const maxAttempts = Number.isInteger(state.maxAttempts) && state.maxAttempts > 0 ? state.maxAttempts : 2;
  const stamp = new Date(now).toISOString();
  if (state.state === 'staged') {
    const expected = join('versions', String(state.to));
    if (facts.current !== undefined && facts.current !== expected) {
      const reason = `./current points at ${facts.current ?? 'nothing'}, not ${expected}; the upgrade to ${state.to} was not switched in`;
      return { action: 'run', trial: false, reason, next: { ...state, state: 'failed', reason, updatedAt: stamp } };
    }
    return { action: 'run', trial: true,
      next: { ...state, state: 'trial', attempt: 1, maxAttempts, trialDeadline: new Date(now + confirmMs).toISOString(), updatedAt: stamp } };
  }
  if (state.state === 'trial') {
    // A deadline further away than one window means the wall clock moved back: clamp it.
    const parsed = Date.parse(state.trialDeadline ?? '');
    const deadline = Number.isFinite(parsed) ? Math.min(parsed, now + confirmMs) : Number.NaN;
    const attempt = Number.isInteger(state.attempt) ? state.attempt : maxAttempts;
    if (!Number.isFinite(deadline) || now >= deadline) {
      return revertDecision(state, `no confirmed heartbeat from ${state.to} within ${Math.round(confirmMs / 1000)} s`, facts, stamp);
    }
    if (attempt >= maxAttempts) return revertDecision(state, `${state.to} exited ${attempt} time(s) before reporting a heartbeat`, facts, stamp);
    return { action: 'run', trial: true, next: { ...state, attempt: attempt + 1, trialDeadline: new Date(deadline).toISOString(), updatedAt: stamp } };
  }
  return { action: 'run', next: null, trial: false };
}

/**
 * Pure decision for one poll while a trial runs. Times are monotonic
 * milliseconds since this launch; `now` (wall clock) only stamps the state and
 * judges the agent's liveness marker.
 * @returns {{ action: 'stop' | 'wait' | 'extend' | 'revert', windowMs?: number, next?: Record<string, any>, reason?: string, target?: string | null }}
 */
export function decideWatch(state, { to, elapsedMs, windowMs, confirmMs, now, alive = null, facts = {} }) {
  if (!state || typeof state !== 'object' || state.state !== 'trial' || state.to !== to) return { action: 'stop' };
  if (elapsedMs < windowMs) return { action: 'wait' };
  const stamp = new Date(now).toISOString();
  const unreachable = alive && alive.version === to && Number.isFinite(alive.at) && Math.abs(now - alive.at) < ALIVE_FRESH_MS;
  const capMs = EXTENSION_FACTOR * confirmMs;
  if (unreachable && windowMs < capMs) {
    const next = Math.min(windowMs + confirmMs, capMs);
    return { action: 'extend', windowMs: next, reason: `control API unreachable from ${to}; trial extended to ${Math.round(next / 1000)} s`,
      next: { ...state, trialDeadline: new Date(now + next - elapsedMs).toISOString(), extended: (state.extended ?? 0) + 1, updatedAt: stamp } };
  }
  const seconds = Math.round(windowMs / 1000);
  const reason = unreachable
    ? `control API unreachable from ${to}${alive.error ? ` (${String(alive.error).slice(0, 200)})` : ''}: no confirmed heartbeat within ${seconds} s`
    : `no confirmed heartbeat from ${to} within ${seconds} s`;
  return revertDecision(state, reason, facts, stamp);
}

/** Pure: whether repeated launches with an unreadable state file should fall back to ./last-good. */
export function decideCorrupt(starts, now, { current, lastGood, complete: isComplete = () => true }) {
  const recent = (Array.isArray(starts) ? starts : []).filter(at => Number.isFinite(at) && now - at >= 0 && now - at < RAPID_WINDOW_MS);
  recent.push(now);
  if (recent.length >= RAPID_CRASHES && lastGood && lastGood !== current && isComplete(lastGood)) return { fallback: lastGood, starts: [] };
  return { fallback: null, starts: recent };
}

/** @returns {{ state: Record<string, any> | null, corrupt: boolean }} */
export function readStateFile(dir) {
  let text;
  try {
    text = readFileSync(join(dir, STATE_FILE), 'utf8');
  } catch (error) {
    return { state: null, corrupt: error?.code !== 'ENOENT' };
  }
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? { state: value, corrupt: false } : { state: null, corrupt: true };
  } catch {
    return { state: null, corrupt: true };
  }
}

export function readState(dir) {
  return readStateFile(dir).state;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Running as root in a directory another account owns: hand what we write to that owner. */
function adoptOwner(dir, path) {
  if (process.getuid?.() !== 0) return;
  const owner = statSync(dir);
  if (owner.uid !== 0) lchownSync(path, owner.uid, owner.gid);
}

function fsyncDir(dir) {
  try {
    const fd = openSync(dir, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch {
    // some filesystems cannot fsync a directory
  }
}

/** temp file, fsync, rename, fsync the directory. */
export function writeDurable(dir, name, text) {
  const path = join(dir, name);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    const fd = openSync(temporary, 'w', 0o600);
    try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    adoptOwner(dir, temporary);
    renameSync(temporary, path);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
  fsyncDir(dir);
}

export function writeState(dir, state) {
  writeDurable(dir, STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

/** Atomically point `<dir>/<name>` at versions/<version>. */
export function pointLink(dir, name, version) {
  const temporary = join(dir, `${name}.${process.pid}.tmp`);
  try {
    rmSync(temporary, { force: true });
    symlinkSync(join('versions', version), temporary, 'dir');
    adoptOwner(dir, temporary);
    renameSync(temporary, join(dir, name));
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
  fsyncDir(dir);
}

export function pointCurrentAt(dir, version) {
  pointLink(dir, 'current', version);
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function lockIsStale(path, staleMs) {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); } catch (error) { if (error?.code === 'ESRCH') return true; }
    }
    return Date.now() - statSync(path).mtimeMs > staleMs;
  } catch {
    return false; // released meanwhile: retry
  }
}

/**
 * Exclusive lock (O_EXCL) around a read-modify-write of the state file, shared
 * with the agent. Failing to take it throws an error with `lockFailed: true`;
 * errors from `fn` pass through unchanged.
 */
export function withLock(dir, fn, { timeoutMs = 3_000, staleMs = 15_000 } = {}) {
  const path = join(dir, LOCK_FILE);
  const until = Date.now() + timeoutMs;
  let fd;
  for (;;) {
    try {
      fd = openSync(path, 'wx', 0o600);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw Object.assign(error, { lockFailed: true });
      if (lockIsStale(path, staleMs)) { try { rmSync(path, { force: true }); } catch { /* retry */ } continue; }
      if (Date.now() >= until) throw Object.assign(new Error(`${path} is held by another process`), { code: 'ELOCKED', lockFailed: true });
      Atomics.wait(sleeper, 0, 0, 25);
    }
  }
  try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
  try {
    return fn();
  } finally {
    try { rmSync(path, { force: true }); } catch { /* stale lock is detected by pid */ }
  }
}

/** Run `fn` under the lock, or without it when the lock cannot be taken (read-only disk): starting the agent matters more. */
function lockedOrNot(dir, fn, log) {
  try {
    return withLock(dir, fn);
  } catch (error) {
    if (!error?.lockFailed) throw error;
    log(`cannot lock ${STATE_FILE} (${errorCode(error)}); continuing without the lock`);
    return fn();
  }
}

/** Stale `<name>.<pid>.tmp` files from an interrupted write. Nothing else writes while the launcher starts. */
export function sweepTemporaries(dir, log = () => {}) {
  for (const folder of [dir, join(dir, 'launcher')]) {
    let names = [];
    try { names = readdirSync(folder); } catch { continue; }
    for (const name of names) {
      if (!/\.\d+\.tmp$/.test(name)) continue;
      try { rmSync(join(folder, name), { recursive: true, force: true }); } catch (error) { log(`cannot remove ${join(folder, name)} (${errorCode(error)})`); }
    }
  }
}

export function confirmSeconds(env) {
  const value = Number.parseInt(env.MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS ?? '', 10);
  return Number.isInteger(value) && value >= 10 ? Math.min(value, 3600) : 180;
}

const realOps = {
  readStateFile, writeState, pointCurrentAt, linkVersion, complete,
  readCrashes: dir => readJson(join(dir, CRASH_FILE))?.starts ?? [],
  writeCrashes: (dir, starts) => writeDurable(dir, CRASH_FILE, `${JSON.stringify({ starts })}\n`),
  clearCrashes: dir => rmSync(join(dir, CRASH_FILE), { force: true }),
  lock: (dir, fn, log) => lockedOrNot(dir, fn, log),
};

/** Switch and record a revert decision. Returns whether ./current now points at the revert target. */
function applyRevert(dir, decision, ops, log) {
  const next = { ...decision.next };
  let switched = false;
  if (decision.target) {
    try {
      ops.pointCurrentAt(dir, decision.target);
      switched = true;
    } catch (error) {
      next.state = 'failed';
      next.reason = `${decision.reason}; switching ./current to ${decision.target} failed (${errorCode(error)})`;
    }
  }
  try {
    ops.writeState(dir, next);
  } catch (error) {
    log(`cannot record the ${next.state} state (${errorCode(error)}); running ./current anyway`);
  }
  log(`${switched ? 'reverted' : 'could not revert'} ${next.to} -> ${decision.target ?? '(none)'}: ${next.reason}`);
  return switched;
}

/**
 * Apply the launch decision for `dir`. Never throws: a state or link write
 * that fails falls back to running the previous (or current) version without
 * a trial, so a full or read-only disk cannot turn into a crash loop.
 * @returns {{ trial: boolean, to: string | null, remainingMs: number }}
 */
export function prepareLaunch(dir, now, confirmMs, log = () => {}, overrides = {}) {
  const ops = { ...realOps, ...overrides };
  let plan = { trial: false, to: null, remainingMs: 0 };
  const body = () => {
    const { state, corrupt } = ops.readStateFile(dir);
    const current = ops.linkVersion(dir, 'current');
    const lastGood = ops.linkVersion(dir, 'last-good');
    if (corrupt) {
      const verdict = decideCorrupt(ops.readCrashes(dir), now, { current, lastGood, complete: version => ops.complete(dir, version) });
      if (!verdict.fallback) {
        log(`${STATE_FILE} is unreadable; running ./current (${current ?? 'unknown'})`);
        try { ops.writeCrashes(dir, verdict.starts); } catch { /* counted again next time */ }
        return;
      }
      try {
        ops.pointCurrentAt(dir, verdict.fallback);
        log(`${STATE_FILE} is unreadable and ${current} keeps exiting; switched ./current to last-good ${verdict.fallback}`);
        ops.writeState(dir, { state: 'reverted', from: current, to: current, requestId: null, updatedAt: new Date(now).toISOString(),
          reason: `${STATE_FILE} was unreadable and ${current} exited ${RAPID_CRASHES} times; switched to last-good ${verdict.fallback}` });
        ops.clearCrashes(dir);
      } catch (error) {
        log(`last-good fallback to ${verdict.fallback} failed (${errorCode(error)}); running ./current`);
      }
      return;
    }
    try { ops.clearCrashes(dir); } catch { /* harmless */ }
    const facts = { current: current === null ? null : join('versions', current), lastGood, complete: version => ops.complete(dir, version) };
    const decision = decideLaunch(state, now, confirmMs, facts);
    if (decision.action === 'revert') { applyRevert(dir, decision, ops, log); return; }
    if (!decision.next) return;
    try {
      ops.writeState(dir, decision.next);
    } catch (error) {
      log(`cannot record the ${decision.next.state} state for ${state.to} (${errorCode(error)})`);
      if (!decision.trial) return;
      // A trial that cannot be recorded could never be reverted: run the previous version instead.
      if (state.from && ops.complete(dir, state.from)) {
        try {
          ops.pointCurrentAt(dir, state.from);
          log(`switched ./current back to ${state.from}; ${state.to} was not started`);
        } catch (linkError) {
          log(`cannot switch ./current back to ${state.from} (${errorCode(linkError)}); running ./current without a trial`);
        }
      }
      return;
    }
    if (decision.next.state === 'failed') log(decision.reason);
    if (decision.trial) plan = { trial: true, to: state.to, remainingMs: Math.max(0, Date.parse(decision.next.trialDeadline) - now) };
  };
  try {
    ops.lock(dir, body, log);
  } catch (error) {
    log(`upgrade bookkeeping failed (${errorCode(error)}); running ./current`);
    plan = { trial: false, to: null, remainingMs: 0 };
  }
  return plan;
}

/** One watcher poll: extend, revert or keep waiting. Returns 'reverted' when the child must stop. */
export function watchTrial(dir, plan, elapsedMs, windowMs, confirmMs, log = () => {}, overrides = {}) {
  const ops = { ...realOps, ...overrides };
  let outcome = { action: 'wait', windowMs };
  const body = () => {
    const { state } = ops.readStateFile(dir);
    const now = Date.now();
    const facts = { lastGood: ops.linkVersion(dir, 'last-good'), complete: version => ops.complete(dir, version) };
    const verdict = decideWatch(state, { to: plan.to, elapsedMs, windowMs, confirmMs, now, alive: readJson(join(dir, ALIVE_FILE)), facts });
    if (verdict.action === 'stop' || verdict.action === 'wait') { outcome = { action: verdict.action, windowMs }; return; }
    if (verdict.action === 'extend') {
      try { ops.writeState(dir, verdict.next); } catch (error) { log(`cannot record the extended trial (${errorCode(error)})`); }
      log(verdict.reason);
      outcome = { action: 'extend', windowMs: verdict.windowMs };
      return;
    }
    outcome = { action: applyRevert(dir, verdict, ops, log) ? 'reverted' : 'stop', windowMs };
  };
  try {
    ops.lock(dir, body, log);
  } catch (error) {
    log(`trial check failed (${errorCode(error)})`);
  }
  return outcome;
}

function main() {
  if (process.argv.includes('--protocol')) { console.log(String(LAUNCHER_PROTOCOL)); return; }
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const log = message => console.error(`[launcher] ${message}`);
  const configured = process.env.AGENT_INSTALL_DIR;
  if (configured && resolve(configured) !== dir) log(`AGENT_INSTALL_DIR=${configured} differs from the launcher's directory; using ${dir}`);
  const confirmMs = confirmSeconds(process.env) * 1000;
  sweepTemporaries(dir, log);
  const plan = prepareLaunch(dir, Date.now(), confirmMs, log);

  let entry = join(dir, 'current', ...ENTRY);
  if (!existsSync(entry)) {
    const lastGood = linkVersion(dir, 'last-good');
    if (!plan.trial && lastGood && lastGood !== linkVersion(dir, 'current') && complete(dir, lastGood)) {
      try {
        pointCurrentAt(dir, lastGood);
        log(`${entry} is missing; switched ./current to last-good ${lastGood}`);
        entry = join(dir, 'current', ...ENTRY);
      } catch (error) {
        log(`${entry} is missing and switching to last-good failed (${errorCode(error)})`);
      }
    }
    if (!existsSync(entry)) {
      log(`${entry} is missing; reinstall with magnus-agent install-service`);
      process.exit(1);
    }
  }
  const startedAt = performance.now();
  const child = spawn(process.execPath, [entry, 'start'], {
    cwd: dir,
    stdio: 'inherit',
    env: {
      ...process.env,
      AGENT_INSTALL_DIR: dir,
      MAGNUS_AGENT_LAUNCHER: '1',
      MAGNUS_AGENT_LAUNCHER_PROTOCOL: String(LAUNCHER_PROTOCOL),
      MAGNUS_AGENT_LAUNCHER_CONFIRM_SECONDS: String(confirmMs / 1000),
    },
  });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));

  let failedTrial = false;
  let watcher;
  if (plan.trial) {
    let windowMs = plan.remainingMs;
    watcher = setInterval(() => {
      const outcome = watchTrial(dir, plan, performance.now() - startedAt, windowMs, confirmMs, log);
      windowMs = outcome.windowMs;
      if (outcome.action === 'stop') clearInterval(watcher);
      if (outcome.action === 'reverted') {
        clearInterval(watcher);
        failedTrial = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
      }
    }, POLL_MS);
  }
  child.on('exit', (code, signal) => {
    if (watcher) clearInterval(watcher);
    if (performance.now() - startedAt >= HEALTHY_RUN_MS) { try { realOps.clearCrashes(dir); } catch { /* harmless */ } }
    // Any exit restarts through systemd (Restart=always); a failed trial exits non-zero.
    process.exit(failedTrial ? 1 : code ?? (signal ? 1 : 0));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
