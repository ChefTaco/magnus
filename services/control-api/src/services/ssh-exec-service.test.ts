import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server, utils, type Client } from 'ssh2';
import { execRemote, runRemoteCommand, SshCommandOutcomeUnknownError } from './ssh-exec-service.js';
import { sshHostVerification } from './ssh-host-verification.js';

vi.mock('./managed-ssh-admission.js', () => ({ withApiSshOwnership: vi.fn(async (_host: string, _kind: string, operation: () => Promise<unknown>) => operation()) }));

describe('SSH finite execution evidence', () => {
  it.each([null, undefined, NaN, -1, 0x100000000])('rejects missing/invalid status %s without exposing command output', async status => {
    const stream = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
    const conn = { exec: (_command: string, callback: (error: null, channel: typeof stream) => void) => callback(null, stream) } as unknown as Client;
    const pending = execRemote(conn, 'private-command');
    stream.emit('data', Buffer.from('PASSWORD=private-fixture-value'));
    stream.emit('close', status, 'TERM');
    const error = await pending.catch(value => value);
    expect(error).toBeInstanceOf(SshCommandOutcomeUnknownError);
    expect(error).toMatchObject({ code: 'SSH_COMMAND_OUTCOME_UNKNOWN', outcome: 'unknown', retryable: false });
    expect(String(error)).toContain('Reconcile remote effects before retrying');
    expect(JSON.stringify(error) + String(error)).not.toContain('private-fixture-value');
  });
});

describe('real loopback SSH channel completion', () => {
  let server: Server;
  let port: number;
  let pinsFile: string;
  let fingerprint: string;
  let authenticationAttempts = 0;
  const temporary = mkdtempSync(join(tmpdir(), 'magnus-ssh-pins-'));
  const accepted: string[] = [];
  const clients = new Set<{ end(): void }>();
  beforeAll(async () => {
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
    const parsed = utils.parseKey(key);
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid fixture key');
    fingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
    server = new Server({ hostKeys: [key] }, client => {
      clients.add(client); client.on('close', () => clients.delete(client));
      client.on('error', () => undefined);
      client.on('authentication', context => { authenticationAttempts++; context.accept(); });
      client.on('ready', () => client.on('session', accept => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          accepted.push(info.command);
          const stream = acceptExec();
          stream.write('observed\nPASSWORD=private-fixture-value\n');
          if (info.command === 'success') stream.exit(0);
          if (info.command === 'failure') stream.exit(7);
          // No exit-status frame: real SSH can close a channel without one.
          stream.end();
        });
      }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    pinsFile = join(temporary, 'pins.json');
    writeFileSync(pinsFile, JSON.stringify({ [`127.0.0.1:${port}`]: [fingerprint] }));
    vi.stubEnv('SSH_HOST_KEY_PINS_FILE', pinsFile);
  });
  afterAll(async () => {
    for (const client of clients) client.end();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs();
    rmSync(temporary, { recursive: true, force: true });
  });
  const run = (command: string) => runRemoteCommand({ hostname: '127.0.0.1', username: 'isolated-fixture', port }, command, { readyTimeoutMs: 2000 });
  it('preserves explicit zero and nonzero remote statuses', async () => {
    const success = await run('success');
    expect(success.code).toBe(0);
    expect(success.redactedStdout).not.toContain('private-fixture-value');
    expect((await run('failure')).code).toBe(7);
  });
  it('rejects a real channel close without exit status and does not retry the command', async () => {
    const before = accepted.length;
    await expect(run('missing-exit')).rejects.toMatchObject({ code: 'SSH_COMMAND_OUTCOME_UNKNOWN', outcome: 'unknown', retryable: false });
    expect(accepted.slice(before)).toEqual(['missing-exit']);
  });
  it('rejects a changed host key before sending authentication or executing a command', async () => {
    const before = authenticationAttempts;
    const commands = accepted.length;
    writeFileSync(pinsFile, JSON.stringify({ [`127.0.0.1:${port}`]: [`SHA256:${'A'.repeat(43)}`] }));
    try { await expect(run('must-not-execute')).rejects.toThrow(/verification failed/i); }
    finally { writeFileSync(pinsFile, JSON.stringify({ [`127.0.0.1:${port}`]: [fingerprint] })); }
    expect(authenticationAttempts).toBe(before);
    expect(accepted).toHaveLength(commands);
  });
  it('fails closed for missing configuration, malformed files and unknown destinations', () => {
    expect(() => sshHostVerification('other.example', port)).toThrow('No trusted');
    expect(() => sshHostVerification('127.0.0.1', port + 1)).toThrow('No trusted');
    vi.stubEnv('SSH_HOST_KEY_PINS_FILE', '');
    expect(() => sshHostVerification('127.0.0.1', port)).toThrow('required');
    vi.stubEnv('SSH_HOST_KEY_PINS_FILE', pinsFile);
    writeFileSync(pinsFile, '{}not-json');
    try { expect(() => sshHostVerification('127.0.0.1', port)).toThrow('invalid'); }
    finally { writeFileSync(pinsFile, JSON.stringify({ [`127.0.0.1:${port}`]: [fingerprint] })); }
  });
});
