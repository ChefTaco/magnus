/** Opt-in root/systemd fixture: MAGNUS_NATIVE_TERMINAL_TEST_USER names a disposable restricted account. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { ManagedTerminals } from './managed-terminal.js';
import { HOST_FQDN } from '../env.js';

describe.skipIf(!process.env['MAGNUS_NATIVE_TERMINAL_TEST_USER'])('restricted managed terminal (real systemd)', () => {
  let root: string; let terminals: ManagedTerminals; let previousUmask: number;
  const previous = process.env['AGENT_INSTALL_DIR'];
  beforeAll(async () => {
    previousUmask = process.umask(0o077);
    root = await mkdtemp(join(tmpdir(), 'magnus-terminal-native-')); process.env['AGENT_INSTALL_DIR'] = root;
    terminals = new ManagedTerminals(process.env['MAGNUS_NATIVE_TERMINAL_TEST_USER']!, async (path, body: any) =>
      path === 'terminal-claim' ? { ...body.authority, nonce: body.nonce, admitted: true } : { state: 'released' });
  });
  afterAll(async () => { try { await terminals?.shutdown(); if (previous === undefined) delete process.env['AGENT_INSTALL_DIR'];
    else process.env['AGENT_INSTALL_DIR'] = previous; if (root) await rm(root, { recursive: true, force: true }); }
    finally { process.umask(previousUmask); } });
  const authority = () => ({ workId: randomUUID(), ownerId: randomUUID(), nodeId: 'fixture', nodeFqdn: HOST_FQDN,
    epoch: 1, barrierId: randomUUID(), operationSha256: 'a'.repeat(64), requestSha256: 'b'.repeat(64), fence: '1', deadline: Date.now() + 30000 });
  it('provides a PTY under umask 077, resizes it, confines host writes and kills background descendants before signing', async () => {
    const value = authority(); await terminals.action(value, { action: 'open', size: { cols: 100, rows: 30 } });
    const runtime = '/run/magnus-terminals';
    const directory = join(runtime, createHash('sha256').update(value.workId).digest('hex'));
    for (const path of [runtime, directory]) expect((await lstat(path)).mode & 0o777).toBe(0o711);
    expect((await lstat(join(directory, 'pty'))).mode & 0o777).toBe(0o600);
    await terminals.action(value, { action: 'resize', size: { cols: 111, rows: 44 } });
    await terminals.action(value, { action: 'input', data: "stty size; id -un; touch /etc/magnus-must-not-write; sleep 120 & printf '\\nBACKGROUND_STARTED\\n'\n" });
    let output = '';
    await expect.poll(async () => { const next = await terminals.action(value, { action: 'read' });
      output += Buffer.from(String(next['dataBase64']), 'base64').toString(); return output; }).toContain('\r\nBACKGROUND_STARTED\r\n');
    expect(output).toContain('44 111');
    expect(output).not.toMatch(/\/run\/magnus-terminals\/.*Permission denied/);
    expect(output).toContain(process.env['MAGNUS_NATIVE_TERMINAL_TEST_USER']);
    expect(output).toMatch(/Read-only file system|Permission denied/);
    const ended = await terminals.action(value, { action: 'close' });
    expect(ended).toMatchObject({ state: 'completed', receipt: { groupEmpty: true, boundary: 'restricted-terminal-process-v1' } });
    await expect(terminals.action(value, { action: 'open', size: { cols: 80, rows: 24 } })).rejects.toThrow('single use');
    const name = (await readdir(join(root, '.magnus/terminals')))[0]!;
    const journal = await readFile(join(root, '.magnus/terminals', name, 'intent.json'), 'utf8');
    expect(journal).not.toContain('stty size'); expect(journal).not.toContain('must-not-write');
  }, 20000);
  it('cancels a just-opened unit before issuing any cleanup receipt', async () => {
    const value = authority(); await terminals.action(value, { action: 'open', size: { cols: 80, rows: 24 } });
    expect(await terminals.action(value, { action: 'close' })).toMatchObject({ state: 'completed', receipt: { groupEmpty: true } });
  }, 15000);
  it('observes a normal shell exit without relying on gateway disconnection', async () => {
    const value = authority(); await terminals.action(value, { action: 'open', size: { cols: 80, rows: 24 } });
    await terminals.action(value, { action: 'input', data: 'exit\n' });
    await expect.poll(async () => (await terminals.action(value, { action: 'read' }))['state'], { timeout: 10000 }).toBe('completed');
  }, 15000);
});
