import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// The launcher is plain JavaScript so it runs without dependencies.
import {
  confirmSeconds, decideCorrupt, decideLaunch, decideWatch, LAUNCHER_PROTOCOL, prepareLaunch, RAPID_CRASHES, readState, sweepTemporaries, withLock,
  writeState,
} from '../../launcher/launcher.mjs';
import { declaredLauncherProtocol, MIN_LAUNCHER_PROTOCOL, withStateLock } from './self-upgrade.js';

const minute = 60_000;
const now = Date.parse('2026-11-01T00:00:00Z');
const trial = { state: 'trial', from: '1.0.3', to: '1.1.0', requestId: 'r', attempt: 1, maxAttempts: 2, trialDeadline: '2026-11-01T00:03:00.000Z' };

describe('launcher decision', () => {
  it('runs normally without an upgrade in progress', () => {
    expect(decideLaunch(null, now, 3 * minute)).toEqual({ action: 'run', next: null, trial: false });
    expect(decideLaunch({ state: 'confirmed', from: '1.0.3', to: '1.1.0' }, now, minute).action).toBe('run');
  });
  it('starts a staged version on trial with a deadline', () => {
    const decision = decideLaunch({ state: 'staged', from: '1.0.3', to: '1.1.0', attempt: 0, maxAttempts: 2 }, now, 3 * minute, { current: 'versions/1.1.0' });
    expect(decision).toMatchObject({ action: 'run', trial: true, next: { state: 'trial', attempt: 1, trialDeadline: '2026-11-01T00:03:00.000Z' } });
  });
  it('records a failed upgrade instead of a doomed trial when ./current was not switched', () => {
    const decision = decideLaunch({ state: 'staged', from: '1.0.3', to: '1.1.0' }, now, 3 * minute, { current: 'versions/1.0.3' });
    expect(decision).toMatchObject({ action: 'run', trial: false, next: { state: 'failed', reason: expect.stringMatching(/not versions\/1\.1\.0/) } });
  });
  it('retries a crash once, then reverts', () => {
    expect(decideLaunch(trial, now, 3 * minute)).toMatchObject({ action: 'run', trial: true, next: { attempt: 2 } });
    expect(decideLaunch({ ...trial, attempt: 2 }, now, 3 * minute)).toMatchObject({ action: 'revert', target: '1.0.3', next: { state: 'reverted' } });
  });
  it('reverts once the deadline passes without a confirmation', () => {
    expect(decideLaunch({ ...trial, trialDeadline: '2026-10-31T23:59:00.000Z' }, now, 3 * minute))
      .toMatchObject({ action: 'revert', reason: expect.stringMatching(/no confirmed heartbeat/) });
  });
  it('clamps a deadline that is further away than one window (the clock moved back)', () => {
    const decision = decideLaunch({ ...trial, trialDeadline: '2026-11-02T00:00:00.000Z' }, now, 3 * minute);
    expect(decision.next?.trialDeadline).toBe('2026-11-01T00:03:00.000Z');
  });
  it('reverts to last-good when versions/<from> is gone, and records failed when nothing can run', () => {
    const facts = (complete: string[]) => ({ lastGood: '1.0.2', complete: (version: string) => complete.includes(version) });
    expect(decideLaunch({ ...trial, attempt: 2 }, now, minute, facts(['1.0.2', '1.1.0'])))
      .toMatchObject({ action: 'revert', target: '1.0.2', next: { state: 'reverted', reason: expect.stringMatching(/last-good 1\.0\.2/) } });
    expect(decideLaunch({ ...trial, attempt: 2 }, now, minute, facts(['1.1.0'])))
      .toMatchObject({ action: 'revert', target: null, next: { state: 'failed', reason: expect.stringMatching(/left as it is/) } });
  });
  it('bounds the confirmation window', () => {
    expect(confirmSeconds({})).toBe(180);
    expect(confirmSeconds({ MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS: '5' })).toBe(180);
    expect(confirmSeconds({ MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS: '20' })).toBe(20);
  });
});

describe('launcher trial watch', () => {
  const watch = (overrides: Record<string, unknown> = {}) =>
    ({ to: '1.1.0', elapsedMs: 10 * minute, windowMs: 3 * minute, confirmMs: 3 * minute, now, ...overrides });
  it('waits inside the window and stops when the trial is over', () => {
    expect(decideWatch(trial, watch({ elapsedMs: minute })).action).toBe('wait');
    expect(decideWatch({ ...trial, state: 'confirmed' }, watch()).action).toBe('stop');
    expect(decideWatch(trial, watch({ to: '1.2.0' })).action).toBe('stop');
  });
  it('reverts after the window and keeps the real attempt count', () => {
    expect(decideWatch({ ...trial, attempt: 2 }, watch())).toMatchObject({ action: 'revert', next: { state: 'reverted', attempt: 2 } });
  });
  it('extends the window while the agent is alive but cannot reach the control API, up to the cap', () => {
    const alive = { version: '1.1.0', at: now - 5_000, error: 'fetch failed' };
    const extended = decideWatch(trial, watch({ elapsedMs: 3 * minute, alive }));
    expect(extended).toMatchObject({ action: 'extend', windowMs: 6 * minute, next: { extended: 1, trialDeadline: '2026-11-01T00:03:00.000Z' } });
    expect(decideWatch(trial, watch({ elapsedMs: 9 * minute, windowMs: 9 * minute, alive })))
      .toMatchObject({ action: 'revert', reason: expect.stringMatching(/^control API unreachable from 1\.1\.0 \(fetch failed\)/) });
    // A stale marker or one from another version does not extend.
    expect(decideWatch(trial, watch({ elapsedMs: 3 * minute, alive: { ...alive, at: now - 10 * minute } })).action).toBe('revert');
    expect(decideWatch(trial, watch({ elapsedMs: 3 * minute, alive: { ...alive, version: '1.0.3' } })).action).toBe('revert');
  });
});

describe('launcher with an unreadable state file', () => {
  it('falls back to last-good after repeated launches', () => {
    let starts: number[] = [];
    for (let index = 1; index < RAPID_CRASHES; index++) {
      const verdict = decideCorrupt(starts, now + index * 1000, { current: '1.1.0', lastGood: '1.0.3' });
      expect(verdict.fallback).toBeNull();
      starts = verdict.starts;
    }
    expect(decideCorrupt(starts, now + 10_000, { current: '1.1.0', lastGood: '1.0.3' }).fallback).toBe('1.0.3');
    expect(decideCorrupt(starts, now + 10_000, { current: '1.0.3', lastGood: '1.0.3' }).fallback).toBeNull();
    expect(decideCorrupt(starts, now + 60 * minute, { current: '1.1.0', lastGood: '1.0.3' }).fallback).toBeNull();
  });
});

function install(): string {
  const dir = mkdtempSync(join(tmpdir(), 'magnus-launcher-unit-'));
  for (const version of ['1.0.2', '1.0.3', '1.1.0']) {
    const dist = join(dir, 'versions', version, 'node_modules', '@hivemagnus', 'magnus-agent', 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.js'), '');
  }
  symlinkSync(join('versions', '1.1.0'), join(dir, 'current'));
  symlinkSync(join('versions', '1.0.2'), join(dir, 'last-good'));
  return dir;
}
const fail = (code: string) => () => { throw Object.assign(new Error(code), { code }); };

describe('launcher bookkeeping that cannot write', () => {
  it('runs the previous version when the trial cannot be recorded', () => {
    const dir = install();
    writeState(dir, { state: 'staged', from: '1.0.3', to: '1.1.0', requestId: 'r' });
    const logs: string[] = [];
    const plan = prepareLaunch(dir, now, 3 * minute, (line: string) => logs.push(line), { writeState: fail('ENOSPC') });
    expect(plan.trial).toBe(false);
    expect(readlinkSync(join(dir, 'current'))).toBe(join('versions', '1.0.3'));
    expect(logs.join('\n')).toMatch(/ENOSPC[\s\S]*switched \.\/current back to 1\.0\.3/);
  });
  it('runs ./current without a trial when neither the state nor the link can be written', () => {
    const dir = install();
    writeState(dir, { state: 'staged', from: '1.0.3', to: '1.1.0', requestId: 'r' });
    const plan = prepareLaunch(dir, now, 3 * minute, () => {}, { writeState: fail('EROFS'), pointCurrentAt: fail('EROFS'), lock: (_: string, fn: () => void) => fn() });
    expect(plan.trial).toBe(false);
    expect(readlinkSync(join(dir, 'current'))).toBe(join('versions', '1.1.0'));
  });
  it('still switches back when the revert cannot be recorded, and records failed when it cannot switch', () => {
    const dir = install();
    writeState(dir, { ...trial, attempt: 2 });
    expect(prepareLaunch(dir, now, 3 * minute, () => {}, { writeState: fail('ENOSPC') }).trial).toBe(false);
    expect(readlinkSync(join(dir, 'current'))).toBe(join('versions', '1.0.3'));

    const other = install();
    writeState(other, { ...trial, attempt: 2 });
    prepareLaunch(other, now, 3 * minute, () => {}, { pointCurrentAt: fail('EACCES') });
    expect(readState(other)).toMatchObject({ state: 'failed', attempt: 2, reason: expect.stringMatching(/switching \.\/current to 1\.0\.3 failed \(EACCES\)/) });
  });
  it('falls back to last-good on the third launch with a corrupt state file', () => {
    const dir = install();
    writeFileSync(join(dir, 'upgrade-state.json'), '{"state": "tri');
    for (let index = 1; index < RAPID_CRASHES; index++) prepareLaunch(dir, now + index * 1000, 3 * minute);
    expect(readlinkSync(join(dir, 'current'))).toBe(join('versions', '1.1.0'));
    prepareLaunch(dir, now + 10_000, 3 * minute);
    expect(readlinkSync(join(dir, 'current'))).toBe(join('versions', '1.0.2'));
    expect(readState(dir)).toMatchObject({ state: 'reverted', reason: expect.stringMatching(/unreadable/) });
    expect(existsSync(join(dir, 'launcher-crashes.json'))).toBe(false);
  });
});

describe('launcher files', () => {
  it('writes the state durably and sweeps stale temporaries', () => {
    const dir = install();
    writeState(dir, { state: 'idle' });
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    mkdirSync(join(dir, 'launcher'));
    writeFileSync(join(dir, 'upgrade-state.json.4242.tmp'), '');
    symlinkSync('versions/1.0.3', join(dir, 'current.4242.tmp'));
    writeFileSync(join(dir, 'launcher', 'launcher.mjs.77.tmp'), '');
    sweepTemporaries(dir);
    expect([...readdirSync(dir), ...readdirSync(join(dir, 'launcher'))].filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, 'upgrade-state.json'), 'utf8'))).toEqual({ state: 'idle' });
  });
  it('shares one exclusive lock with the agent and breaks a dead holder\'s lock', () => {
    const dir = install();
    expect(() => withLock(dir, () => withStateLock(dir, () => 1, { timeoutMs: 100 }))).toThrow(/held by another process/);
    expect(() => withStateLock(dir, () => withLock(dir, () => 1, { timeoutMs: 100 }))).toThrow(/held by another process/);
    // A lock left by a process that no longer exists.
    writeFileSync(join(dir, 'upgrade-state.lock'), '999999999');
    expect(withLock(dir, () => 'taken')).toBe('taken');
    expect(existsSync(join(dir, 'upgrade-state.lock'))).toBe(false);
  });
  it('declares a protocol the agent package can run with', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { magnusAgent: { minLauncher: number } };
    expect(pkg.magnusAgent.minLauncher).toBe(MIN_LAUNCHER_PROTOCOL);
    expect(LAUNCHER_PROTOCOL).toBeGreaterThanOrEqual(MIN_LAUNCHER_PROTOCOL);
    expect(declaredLauncherProtocol(join(import.meta.dirname, '..', '..', 'launcher', 'launcher.mjs'))).toBe(LAUNCHER_PROTOCOL);
  });
});
