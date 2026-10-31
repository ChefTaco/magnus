import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MutationBarrier } from './mutation-barrier.js';

let root: string;
let barrier: MutationBarrier;
const identity = { nodeId: 'fixture', nodeFqdn: 'fixture.lab', epoch: 1, barrierId: randomUUID() };
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mutation-barrier-')); barrier = new MutationBarrier(root, identity.nodeFqdn); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('durable mutation drain barrier', () => {
  it('does not create state during an unavailable forensic read', async () => {
    await expect(barrier.unknownInventory()).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
  it('reports pre-drain unknowns without claiming an admission fence or mutating the row', async () => {
    const token = await barrier.begin('POST', '/codex/update');
    await barrier.finish(token, 'unknown');
    const before = await readFile(join(root, 'request-' + token.id + '.json'));
    const inventory = await new MutationBarrier(root, identity.nodeFqdn).unknownInventory();
    expect(inventory.drain).toBeNull();
    expect(inventory.rows).toMatchObject([{ id: token.id, state: 'unknown' }]);
    expect(await readFile(join(root, 'request-' + token.id + '.json'))).toEqual(before);
  });
  it('blocks new admissions while allowing the original synchronous handler to settle', async () => {
    const token = await barrier.begin('POST', '/files/write');
    await barrier.drain(identity);
    expect(await barrier.snapshot(identity)).toMatchObject({ activeCount: 1, unknownCount: 0 });
    await expect(barrier.begin('POST', '/files/write')).rejects.toThrow('draining');
    await barrier.finish(token, 'completed');
    expect(await barrier.snapshot(identity)).toMatchObject({ activeCount: 0, unknownCount: 0 });
    await expect(new MutationBarrier(root, identity.nodeFqdn).begin('POST', '/files/write')).rejects.toThrow('draining');
  });
  it('retains an uncertain response and never treats a process restart as completion', async () => {
    const token = await barrier.begin('POST', '/codex/device-auth');
    await barrier.finish(token, 'unknown');
    const restarted = new MutationBarrier(root, identity.nodeFqdn);
    await restarted.drain(identity);
    expect(await restarted.snapshot(identity)).toMatchObject({ activeCount: 0, unknownCount: 1 });
    await expect(restarted.finish(token, 'completed')).rejects.toThrow('owner differs');
    const inventory = await restarted.unknownInventory();
    expect(inventory).toMatchObject({ version: 1, nodeFqdn: identity.nodeFqdn, drain: identity,
      rows: [{ id: token.id, state: 'unknown', commandId: null, requestSha256: null }] });
    expect(inventory.inventorySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(inventory)).not.toContain(token.nonce);
    expect(JSON.stringify(inventory)).not.toContain('/codex/device-auth');
  });
  it('survives the admitting process exiting without any completion receipt', async () => {
    const modulePath = new URL('./mutation-barrier.ts', import.meta.url).href;
    await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `const {MutationBarrier}=await import(${JSON.stringify(modulePath)});await new MutationBarrier(process.argv[1],'fixture.lab').begin('POST','/commands/execute');`, root]);
    await barrier.drain(identity);
    expect(await barrier.snapshot(identity)).toMatchObject({ activeCount: 0, unknownCount: 1 });
  });
  it('serializes independent-process admission against drain without losing a claim', async () => {
    const modulePath = new URL('./mutation-barrier.ts', import.meta.url).href;
    const child = promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `const {MutationBarrier}=await import(${JSON.stringify(modulePath)});try{await new MutationBarrier(process.argv[1],'fixture.lab').begin('POST','/files/write');console.log('accepted');}catch{console.log('denied');}`, root]);
    await barrier.drain(identity);
    const result = await child;
    expect(await barrier.snapshot(identity)).toMatchObject({ activeCount: 0, unknownCount: result.stdout.trim() === 'accepted' ? 1 : 0 });
    expect(['accepted', 'denied']).toContain(result.stdout.trim());
  });
  it('rejects stale epochs, changed node identity and reused barrier identities', async () => {
    await barrier.drain({ ...identity, epoch: 2 });
    await expect(barrier.drain(identity)).rejects.toThrow('Stale');
    await expect(barrier.drain({ ...identity, epoch: 2, barrierId: randomUUID() })).rejects.toThrow('conflicting');
    await expect(barrier.drain({ ...identity, epoch: 3, nodeId: 'other' })).rejects.toThrow('conflicting');
    await expect(barrier.drain({ ...identity, epoch: 3, nodeFqdn: 'other.lab' })).rejects.toThrow('target differs');
  });
  it('refuses unsafe/corrupt retained records rather than emitting a zero-work snapshot', async () => {
    const token = await barrier.begin('POST', '/files/write');
    await barrier.drain(identity);
    const file = join(root, 'request-' + token.id + '.json');
    await writeFile(file, '{', { mode: 0o600 });
    await expect(barrier.snapshot(identity)).rejects.toThrow();
    await expect(barrier.unknownInventory()).rejects.toThrow();
    await rm(file); await symlink('/etc/passwd', file);
    await expect(barrier.snapshot(identity)).rejects.toThrow();
    await expect(barrier.unknownInventory()).rejects.toThrow();
  });
  it('stores route digests and ownership only, and binds completion to the live token', async () => {
    const token = await barrier.begin('POST', '/private-route');
    await expect(barrier.finish({ ...token, nonce: randomUUID() }, 'completed')).rejects.toThrow('owner differs');
    for (const name of await readdir(root)) expect(await readFile(join(root, name), 'utf8')).not.toContain('/private-route');
    await barrier.finish(token, 'completed');
  });
});
