import { describe, expect, it } from 'vitest';
import type { AgentUpgradePreflight } from '@hivemagnus/magnus-contracts';
import { evaluatePreflight, mapLimit, preflightStatus } from './agent-upgrade-preflight.js';

const report = (extra: Partial<AgentUpgradePreflight> = {}): AgentUpgradePreflight => ({ preflightProtocol: 1, version: '1.1.7', layout: 'versioned', launcherProtocol: 1, enabled: true,
  writable: { ok: true, blocked: [] }, disk: { freeBytes: 10 ** 10, requiredBytes: 10 ** 8, low: false }, npm: { present: true, version: '11.0.0' }, fromVersionComplete: true,
  ledger: { readable: true, activeLock: null, nonTerminalReceipts: 0, unresolvedReceipts: 0 }, fenceHighWater: {}, ...extra });
const context = { nodeId: 'n1', hostname: 'node-1.example.com', managed: true, generations: {} };
const codes = (extra: Partial<AgentUpgradePreflight>, over: Partial<typeof context> = {}) => evaluatePreflight(report(extra), { ...context, ...over }).map(problem => [problem.code, problem.blocking]);

describe('holding a preflight report against what an upgrade needs', () => {
  it('passes a healthy node', () => {
    expect(evaluatePreflight(report(), context)).toEqual([]);
    expect(preflightStatus([])).toBe('ok');
  });

  it('proves nothing from a field an agent left out', () => {
    expect(evaluatePreflight({ preflightProtocol: 1, version: '1.1.7' }, context)).toEqual([]);
  });

  it('blocks on what would stop a real upgrade', () => {
    expect(codes({ writable: { ok: false, blocked: ['versions'] } })).toEqual([['PREFLIGHT_NOT_WRITABLE', true]]);
    expect(codes({ disk: { freeBytes: 1, requiredBytes: 2, low: true } })).toEqual([['PREFLIGHT_DISK_LOW', true]]);
    expect(codes({ npm: { present: false, problem: 'npm was not found' } })).toEqual([['PREFLIGHT_NPM', true]]);
    expect(codes({ fromVersionComplete: false })).toEqual([['PREFLIGHT_FROM_INCOMPLETE', true]]);
    expect(codes({ engines: { node: '20.0.0', range: '^24', compatible: false, problem: 'x' } })).toEqual([['PREFLIGHT_ENGINE', true]]);
    expect(codes({ managedEnrollment: { nodeId: 'other', nodeFqdn: 'node-1.example.com' } })).toEqual([['ENROLLMENT_MARKER_MISMATCH', true]]);
  });

  it('weighs ledger state by whether the node\'s requests pass through the ledger', () => {
    const lock = { ledger: { readable: true, activeLock: { commandId: 'c', receipt: 'unknown' } } };
    expect(codes(lock)).toEqual([['LEDGER_UNRESOLVED', true]]);
    expect(codes(lock, { managed: false })).toEqual([['LEDGER_UNRESOLVED', false]]);
    expect(codes({ ledger: { readable: false, error: 'nope' } })).toEqual([['LEDGER_UNAVAILABLE', true]]);
    // A claim without a receipt never started, and the next holder clears it.
    expect(codes({ ledger: { readable: true, activeLock: { commandId: 'c', receipt: 'none' } } })).toEqual([]);
    expect(codes({ ledger: { readable: true, activeLock: null, unresolvedReceipts: 2 } })).toEqual([['LEDGER_UNRESOLVED', false]]);
  });

  it('reports a fence ahead of the server as repairable, and one above the cap as blocking', () => {
    expect(codes({ fenceHighWater: { 'node:n1': '5' } }, { generations: { 'node:n1': 2n } })).toEqual([['FENCE_AHEAD', false]]);
    expect(codes({ fenceHighWater: { 'node:n1': '5' } }, { generations: { 'node:n1': 5n } })).toEqual([]);
    expect(codes({ fenceHighWater: { 'node:n1': '9000000000000000000' } })).toEqual([['FENCE_OVERFLOW', true]]);
    expect(codes({ fenceHighWater: { 'node:other': '5' } })).toEqual([]);
  });

  it('bounds its concurrency and keeps the order', async () => {
    let running = 0;
    let peak = 0;
    const results = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async value => {
      peak = Math.max(peak, ++running);
      await new Promise(resolve => setTimeout(resolve, 1));
      running--;
      return value * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });
});
