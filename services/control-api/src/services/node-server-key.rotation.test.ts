/** Server-key rotation (docs/NODE_CREDENTIALS.md, "Rotating the server key"): stage, promote, retire. */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandNodeAuth } from '../cli/node-auth.js';
import { generateSigningKey, nodeAudience, serverAudience, signNodeRequest, verifyNodeRequest, readNodeAuthHeaders, privateKeyFromPem } from '../security/node-request-auth.js';
import { signServerAuthorization, verifyServerAuthorization } from '../security/node-evidence.js';
import { allowServerKeyCreation, promoteNextServerKey, resetServerSigningKeyCache, retirePreviousServerKey, serverAudiences, serverKeyRotationState,
  serverPublicKeys, serverSigningKey, serverVerificationKeys, stageNextServerKey, SERVER_KEY_DEFAULT_GRACE_MS } from './node-server-key.js';
import { serverAuthorizationSignature, verifyServerAuthorizationFor } from './server-authorization.js';

const dir = mkdtempSync(join(tmpdir(), 'magnus-server-key-rotation-'));
let file: string;
let sequence = 0;
beforeEach(() => {
  file = join(dir, `key-${++sequence}`, 'server-signing-key.json');
  vi.stubEnv('NODE_AUTH_SERVER_KEY_PATH', file);
  resetServerSigningKeyCache();
  allowServerKeyCreation();
});
afterEach(() => { resetServerSigningKeyCache(); vi.unstubAllEnvs(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const payload = '{"domain":"magnus.command-reconciliation.v1","commandId":"cmd-1"}';
const noHmac = () => false;

describe('server-key rotation', () => {
  it('stages a next key that agents pin and the server answers to, without signing with it yet', () => {
    const active = serverSigningKey();
    const state = stageNextServerKey();
    expect(state.next).toMatchObject({ keyId: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(serverSigningKey().keyId).toBe(active.keyId);
    expect(serverPublicKeys().map(key => [key.keyId, key.status])).toEqual([[active.keyId, 'active'], [state.next!.keyId, 'next']]);
    expect(serverAudiences()).toEqual([serverAudience(active.keyId), serverAudience(state.next!.keyId)]);
    // Staging twice is refused: one rotation at a time.
    expect(() => stageNextServerKey()).toThrow(expect.objectContaining({ code: 'SERVER_KEY_NEXT_EXISTS' }));
    // A server older than rotation reads the same file: version 1, active and next with private keys.
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { version: number; active: { privateKeyPem: string }; next: { privateKeyPem: string } };
    expect(stored.version).toBe(1);
    expect(stored.active.privateKeyPem).toContain('PRIVATE KEY');
    expect(stored.next.privateKeyPem).toContain('PRIVATE KEY');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('promotes: the next key signs, the replaced key stays pinned and an accepted audience until its grace ends', () => {
    const old = serverSigningKey();
    const staged = stageNextServerKey().next!;
    const now = Date.now();
    const state = promoteNextServerKey({}, now);
    expect(serverSigningKey().keyId).toBe(staged.keyId);
    expect(state.previous).toMatchObject({ keyId: old.keyId, inGrace: true, retireAfter: new Date(now + SERVER_KEY_DEFAULT_GRACE_MS).toISOString() });
    expect(serverPublicKeys(now).map(key => [key.keyId, key.status])).toEqual([[staged.keyId, 'active'], [old.keyId, 'previous']]);
    // An agent that still signs for the old audience is accepted in the grace period, not after it.
    expect(serverAudiences(now)).toContain(serverAudience(old.keyId));
    expect(serverAudiences(now + SERVER_KEY_DEFAULT_GRACE_MS + 1)).toEqual([serverAudience(staged.keyId)]);
    // A second promotion waits for the first to be retired.
    stageNextServerKey();
    expect(() => promoteNextServerKey()).toThrow(expect.objectContaining({ code: 'SERVER_KEY_PREVIOUS_PENDING' }));
    expect(() => promoteNextServerKey({}, now)).toThrow();
  });

  it('retires after the grace, destroying the private key but keeping the public one for decisions it signed', () => {
    const old = serverSigningKey();
    stageNextServerKey();
    const now = Date.now();
    promoteNextServerKey({ graceMs: 60 * 60 * 1000 }, now);
    expect(() => retirePreviousServerKey({}, now)).toThrow(expect.objectContaining({ code: 'SERVER_KEY_GRACE_PENDING' }));
    const state = retirePreviousServerKey({}, now + 60 * 60 * 1000 + 1);
    expect(state.previous).toBeNull();
    expect(state.retired.map(entry => entry.keyId)).toEqual([old.keyId]);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { retired: Array<Record<string, unknown>> };
    expect(Object.keys(stored.retired[0]!).sort()).toEqual(['createdAt', 'keyId', 'publicKey', 'retiredAt']);
    // Never pinned, never an audience, but still a verification key.
    expect(serverPublicKeys().map(key => key.keyId)).not.toContain(old.keyId);
    expect(serverAudiences()).not.toContain(serverAudience(old.keyId));
    expect(serverVerificationKeys().find(key => key.keyId === old.keyId)).toMatchObject({ status: 'retired' });
    expect(() => retirePreviousServerKey()).toThrow(expect.objectContaining({ code: 'SERVER_KEY_NO_PREVIOUS' }));
  });

  it('keeps verifying a decision the server signed before a promotion and after the old key was retired', () => {
    vi.stubEnv('NODE_AUTH_MODE', 'enforce');
    const before = serverAuthorizationSignature('node-a', 'command-reconciliation', payload)!;
    stageNextServerKey();
    promoteNextServerKey();
    const after = serverAuthorizationSignature('node-a', 'command-reconciliation', payload)!;
    expect(after.keyId).not.toBe(before.keyId);
    expect(verifyServerAuthorizationFor('node-a', 'command-reconciliation', payload, before, noHmac)).toBe(true);
    expect(verifyServerAuthorizationFor('node-a', 'command-reconciliation', payload, after, noHmac)).toBe(true);
    retirePreviousServerKey({ force: true });
    expect(verifyServerAuthorizationFor('node-a', 'command-reconciliation', payload, before, noHmac)).toBe(true);
    // Bound to its node and payload as ever.
    expect(verifyServerAuthorizationFor('node-b', 'command-reconciliation', payload, before, noHmac)).toBe(false);
    expect(verifyServerAuthorizationFor('node-a', 'command-reconciliation', `${payload} `, before, noHmac)).toBe(false);
    // A key this server never had is not trusted.
    const stranger = generateSigningKey();
    expect(verifyServerAuthorizationFor('node-a', 'command-reconciliation', payload,
      signServerAuthorization(privateKeyFromPem(stranger.privateKeyPem), stranger.keyId, 'node-a', 'command-reconciliation', payload), noHmac)).toBe(false);
  });

  it('lets an agent that pinned both keys verify requests before and after the promotion', () => {
    stageNextServerKey();
    const pinned = serverPublicKeys();
    const verifyAsAgent = (headers: Record<string, string>) => {
      const read = readNodeAuthHeaders(name => headers[name]);
      if (!read || read === 'MALFORMED') return false;
      const key = pinned.find(entry => entry.keyId === read.keyId);
      return Boolean(key) && verifyNodeRequest({ headers: read, publicKey: key!.publicKey, expectedNodeId: 'node-a', audiences: [nodeAudience('node-a')],
        method: 'GET', pathWithQuery: '/api/v1/files', body: new Uint8Array() }).ok;
    };
    const sign = () => { const key = serverSigningKey(); return signNodeRequest({ privateKey: key.privateKey, keyId: key.keyId, nodeId: 'node-a',
      audience: nodeAudience('node-a'), method: 'GET', pathWithQuery: '/api/v1/files', body: '' }); };
    expect(verifyAsAgent(sign())).toBe(true);
    promoteNextServerKey();
    expect(verifyAsAgent(sign())).toBe(true);
    // A decision made with the new key verifies against the agent's pins.
    const signature = serverAuthorizationSignature('node-a', 'command-reconciliation', payload)!;
    const pin = pinned.find(entry => entry.keyId === signature.keyId)!;
    expect(verifyServerAuthorization('command-reconciliation', { signature, publicKey: pin.publicKey, expectedNodeId: 'node-a', payload })).toEqual({ ok: true });
  });

  it('picks up a rotation another process made on the file, within a second', () => {
    const active = serverSigningKey();
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const next = generateSigningKey();
    writeFileSync(`${file}`, `${JSON.stringify({ ...stored, next: { ...next, createdAt: new Date().toISOString() } })}\n`, { mode: 0o600 });
    // Within the check interval the cached copy answers; after it the change is seen.
    expect(serverPublicKeys(Date.now() + 1500).map(key => key.keyId)).toEqual([active.keyId, next.keyId]);
  });

  it('rotates from the command line, which needs --force to promote and says so', async () => {
    const lines: string[] = [];
    const out = (line: string) => { lines.push(line); };
    expect(await commandNodeAuth(['server-key', 'stage'], out)).toBe(0);
    expect(serverKeyRotationState().next).not.toBeNull();
    expect(await commandNodeAuth(['server-key', 'promote'], out)).toBe(2);
    expect(lines.at(-1)).toMatch(/needs --force/);
    expect(await commandNodeAuth(['server-key', 'promote', '--force', '--grace-hours', '2'], out)).toBe(0);
    expect(await commandNodeAuth(['server-key', 'retire'], out)).toBe(1);
    expect(lines.at(-1)).toMatch(/SERVER_KEY_GRACE_PENDING/);
    expect(await commandNodeAuth(['server-key', 'retire', '--force'], out)).toBe(0);
    expect(await commandNodeAuth(['server-key', 'status', '--format', 'json'], out)).toBe(0);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ next: null, previous: null, retired: [{ keyId: expect.any(String) }] });
    expect(lines.join('\n')).not.toContain('PRIVATE KEY');
    expect(await commandNodeAuth(['server-key', 'promote', '--force', '--grace-hours', '0'], out)).toBe(2);
  });
});
