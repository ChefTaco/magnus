/** Public operation fixtures: no shell, SFTP transfer or remote side effect occurs. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ statuses: [] as Array<number | null | undefined>, commands: [] as string[], uploads: 0, owned: false, admitted: [] as string[], deny: false }));
vi.mock('./managed-ssh-admission.js', () => ({ withApiSshOwnership: vi.fn(async (_host: string, kind: string, operation: () => Promise<unknown>) => {
  if (transport.deny) throw new Error('fixture drain denied');
  transport.admitted.push(kind); transport.owned = true;
  try { return await operation(); } finally { transport.owned = false; }
}) }));
vi.mock('node:child_process', () => ({ execSync: vi.fn(() => Buffer.alloc(0)) }));
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  existsSync: vi.fn(() => true), readdirSync: vi.fn(() => ['fixture-agent.tgz']),
  statSync: vi.fn(() => ({ size: 100 })), unlinkSync: vi.fn(),
}));
vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');
  return { Client: class extends EventEmitter {
    connect() { expect(transport.owned).toBe(true); queueMicrotask(() => this.emit('ready')); return this; }
    end() { return this; }
    sftp(callback: (error: null, value: unknown) => void) {
      expect(transport.owned).toBe(true);
      callback(null, { end() {}, fastPut(_local: string, _remote: string, _options: unknown, done: (error: null) => void) {
        transport.uploads++; done(null);
      } });
    }
    exec(command: string, callback: (error: null, value: unknown) => void) {
      expect(transport.owned).toBe(true); transport.commands.push(command);
      const stream = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
      callback(null, stream);
      queueMicrotask(() => {
        // Apparent success text cannot stand in for a missing/nonzero exit status.
        stream.emit('data', Buffer.from('MKDIR_OK\nSUCCESS\nINSTALLED_VERSION=fixture\nPASSWORD=private-fixture-value\n'));
        stream.emit('close', transport.statuses.shift());
      });
    }
  } };
});
import { deployNodeAgent, upgradeNodeAgent } from './deploy-service.js';
import { deployControlNode } from './deploy-control-node-service.js';
import { migrateNodeAgent } from './migrate-node-service.js';
const target = { hostname: 'isolated.fixture', username: 'fixture', password: 'fixture-only',
  controlApiUrl: 'https://control.fixture:4000', nodeManagerSecret: 'fixture-node-secret-more-than-thirty-two-characters' };
beforeEach(() => { transport.statuses=[];transport.commands=[];transport.uploads=0;transport.admitted=[];transport.owned=false;transport.deny=false; });

describe('deployment and migration SSH exit evidence', () => {
  it('rejects every deployment and migration before SSH or SFTP when admission denies', async () => {
    transport.deny = true;
    for (const operation of [deployNodeAgent, upgradeNodeAgent, deployControlNode]) {
      await expect(operation(target)).rejects.toThrow('fixture drain denied');
    }
    await expect(migrateNodeAgent({ ...target, targetControlApiUrl: target.controlApiUrl, targetSecret: target.nodeManagerSecret })).rejects.toThrow('fixture drain denied');
    expect(transport.commands).toEqual([]); expect(transport.uploads).toBe(0);
  });
  it.each([['deploy', deployNodeAgent], ['upgrade', upgradeNodeAgent]] as const)('%s cannot succeed or retry when exit status is missing', async (_name, operation) => {
    transport.statuses=[null];const progress=vi.fn();const result=await operation(target,progress);
    expect(result.success).toBe(false);expect(result.message).toContain('outcome unknown');
    expect(result.message).toContain('Reconcile remote effects');expect(result.message).not.toContain('private-fixture-value');
    expect(transport.commands).toHaveLength(1);expect(transport.uploads).toBe(1);
    expect(progress.mock.calls.some(([p]) => ['install','upgrade'].includes(p.step) && p.status==='done')).toBe(false);
  });
  it('migration cannot promote SUCCESS output without an exit-status frame', async () => {
    transport.statuses=[undefined];const result=await migrateNodeAgent({ ...target,targetControlApiUrl:target.controlApiUrl,targetSecret:target.nodeManagerSecret });
    expect(result).toMatchObject({ success:false });expect(result.message).toContain('outcome unknown');
    expect(result.message).not.toContain('private-fixture-value');expect(transport.commands).toHaveLength(1);
  });
  it('uncertain directory preparation stops before upload or deployment', async () => {
    transport.statuses=[null];const result=await deployControlNode(target);
    expect(result.success).toBe(false);expect(result.message).toContain('outcome unknown');
    expect(transport.commands).toHaveLength(1);expect(transport.uploads).toBe(0);
  });
  it('explicit failed directory preparation also stops despite a success marker', async () => {
    transport.statuses=[7];const result=await deployControlNode(target);
    expect(result.success).toBe(false);expect(transport.commands).toHaveLength(1);expect(transport.uploads).toBe(0);
  });
  it('control-node deployment remains uncertain after upload when its final status is missing', async () => {
    transport.statuses=[0,null];const progress=vi.fn();const result=await deployControlNode(target,progress);
    expect(result.success).toBe(false);expect(result.message).toContain('outcome unknown');
    expect(result.message).not.toContain('private-fixture-value');expect(transport.commands).toHaveLength(2);expect(transport.uploads).toBe(1);
    expect(progress.mock.calls.some(([p]) => p.step==='deploy' && p.status==='done')).toBe(false);
  });
  it('preserves explicit success across all public operations', async () => {
    for (const operation of [deployNodeAgent,upgradeNodeAgent]) {
      transport.statuses=[0];expect((await operation(target)).success).toBe(true);
    }
    transport.statuses=[0];expect((await migrateNodeAgent({ ...target,targetControlApiUrl:target.controlApiUrl,targetSecret:target.nodeManagerSecret })).success).toBe(true);
    transport.statuses=[0,0];expect((await deployControlNode(target)).success).toBe(true);
    expect(transport.admitted).toEqual(['agent-deploy', 'agent-upgrade', 'agent-migrate', 'control-deploy']);
  });
});
