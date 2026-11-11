import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { agentUpgradePreflightSchema } from '@hivemagnus/magnus-contracts';
import type { LedgerHealth } from '../executors/command-ledger.js';
import { heartbeatDrift, upgradePreflight } from './preflight.js';

const health: LedgerHealth = { readable: true, activeLock: null, nonTerminalReceipts: 0, unresolvedReceipts: 0, truncated: false, fenceHighWater: { 'node:n1': '42' }, error: null };
const ledger = (overrides: Partial<LedgerHealth> = {}, marker: { version: 1; nodeId: string; nodeFqdn: string } | null = null) => ({
  health: vi.fn(async () => ({ ...health, ...overrides })), enrollmentMarker: vi.fn(async () => ({ state: marker ? 'present' as const : 'absent' as const, marker })) });

function installation(complete = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'magnus-preflight-'));
  mkdirSync(join(dir, 'versions', '1.1.7', ...(complete ? ['node_modules', '@hivemagnus', 'magnus-agent', 'dist'] : [])), { recursive: true });
  if (complete) writeFileSync(join(dir, 'versions', '1.1.7', 'node_modules', '@hivemagnus', 'magnus-agent', 'dist', 'index.js'), '');
  symlinkSync(join('versions', '1.1.7'), join(dir, 'current'), 'dir');
  return dir;
}
const env = (dir: string) => ({ AGENT_INSTALL_DIR: dir, MAGNUS_AGENT_LAUNCHER: '1', MAGNUS_AGENT_LAUNCHER_PROTOCOL: '1', MAGNUS_AGENT_NPM: '/usr/bin/npm', PATH: '/usr/bin' }) as NodeJS.ProcessEnv;

describe('agent upgrade preflight', () => {
  it.each(['24.22.2', '26.13.0'])('rejects a target upgrade on vulnerable runtime %s', async nodeVersion => {
    const report = await upgradePreflight({ version: '1.1.7', target: '1.1.8', engines: '^24.22.3 || ^26.13.1',
      ledger: ledger(), env: env(installation()), nodeVersion });
    expect(report.engines).toMatchObject({ compatible: false,
      problem: expect.stringContaining('requires Node.js ^24.22.3 || ^26.13.1') });
  });

  it('reports the real path and changes nothing', async () => {
    const dir = installation();
    const report = await upgradePreflight({ version: '1.1.7', target: '1.1.8', engines: '^24.22.3 || ^26.13.1', ledger: ledger({}, { version: 1, nodeId: 'n1', nodeFqdn: 'node-1.example.com' }), env: env(dir), nodeVersion: '24.22.3' });
    expect(report).toMatchObject({ preflightProtocol: 1, version: '1.1.7', target: '1.1.8', layout: 'versioned', launcherProtocol: 1, writable: { ok: true, blocked: [] },
      fromVersionComplete: true, fenceHighWater: { 'node:n1': '42' }, managedEnrollment: { nodeId: 'n1' }, engines: { node: '24.22.3', compatible: true, problem: null }, ledger: { readable: true, activeLock: null } });
    expect(agentUpgradePreflightSchema.safeParse(report).success).toBe(true);
    expect(report.disk?.requiredBytes).toBeGreaterThan(0);
  });

  it('names what would stop a real upgrade', async () => {
    const dir = installation(false);
    const report = await upgradePreflight({ version: '1.1.7', target: '2.0.0', engines: '^99.0.0', ledger: ledger({ activeLock: { commandId: 'c1', receipt: 'unknown' }, unresolvedReceipts: 1 }), env: env(dir), nodeVersion: '24.22.3' });
    expect(report.fromVersionComplete).toBe(false);
    expect(report.engines).toMatchObject({ compatible: false, problem: expect.stringMatching(/requires Node.js \^99/) });
    expect(report.ledger).toMatchObject({ activeLock: { commandId: 'c1', receipt: 'unknown' }, unresolvedReceipts: 1 });
  });

  it('says nothing about engines it was not given', async () => {
    const report = await upgradePreflight({ version: '1.1.7', ledger: ledger(), env: env(installation()), nodeVersion: '24.22.3' });
    expect(report.engines).toMatchObject({ range: null, compatible: null });
  });

  it('adds drift evidence to heartbeats from a cached scan', async () => {
    const reader = ledger();
    const dir = installation();
    heartbeatDrift(reader, env(dir));
    await vi.waitFor(() => expect(reader.health).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));
    const drift = heartbeatDrift(reader, env(dir));
    expect(drift).toMatchObject({ fenceHighWater: { 'node:n1': '42' }, ledger: { readable: true }, npm: { present: true } });
    expect(reader.health).toHaveBeenCalledTimes(1);
  });
});
