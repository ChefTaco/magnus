/**
 * The console drain finding this server stores for itself in absent mode
 * (RESOURCE_ENROLLMENT_DASHBOARD_PARTICIPANT=absent): signed with the server key from 3.0.2, while a
 * finding 3.0.1 stored with the shared RESULT_SIGNING_SECRET keeps verifying, also from
 * RESULT_SIGNING_PREVIOUS_SECRET (docs/NODE_CREDENTIALS.md, "Retiring the shared key").
 */
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const keys = vi.hoisted(() => ({ current: '', previous: '' }));
vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  get RESULT_SIGNING_SECRET() { return keys.current; }, get RESULT_SIGNING_PREVIOUS_SECRET() { return keys.previous; } }));

const { enrollmentSigningPayload, verifiedDashboardReceipt } = await import('./resource-enrollment.js');
const { signServerOwnEvidence, serverOwnEvidenceSigningInput, verifyServerOwnEvidence, SERVER_OWN_EVIDENCE_PROTOCOL } = await import('./server-own-evidence.js');
const { allowServerKeyCreation, promoteNextServerKey, resetServerSigningKeyCache, retirePreviousServerKey, serverSigningKey,
  serverVerificationKeys, stageNextServerKey } = await import('./node-server-key.js');
const { verifyServerAuthorization } = await import('../security/node-evidence.js');

const sharedResultKey = 'shared-result-signing-fixture-at-least-32-characters';
const dashboardKey = 'dashboard-participant-fixture-at-least-32-characters';
const dir = mkdtempSync(join(tmpdir(), 'magnus-dashboard-receipt-'));
let sequence = 0;

function unsignedReceipt(nodeId = 'node-1') {
  return { version: 1 as const, participant: 'dashboard' as const, nodeId, nodeFqdn: `${nodeId}.example.com`, epoch: 3,
    barrierId: randomUUID(), challengeId: randomUUID(), expiresAt: Date.now() + 30_000, status: 'drained' as const,
    activeCount: 0, unknownCount: 0, evidenceSha256: 'a'.repeat(64) };
}
/** What 3.0.2 stores. */
function serverSigned(unsigned = unsignedReceipt()) {
  return { ...unsigned, serverSignature: signServerOwnEvidence('console-drain-receipt', unsigned.nodeId, enrollmentSigningPayload(unsigned)) };
}
/** What 3.0.1 stored: an HMAC with the key passed. */
function hmacSigned(key: string, unsigned = unsignedReceipt()) {
  return { ...unsigned, signature: createHmac('sha256', key).update(enrollmentSigningPayload(unsigned)).digest('hex') };
}

beforeEach(() => {
  vi.stubEnv('NODE_AUTH_SERVER_KEY_PATH', join(dir, `key-${++sequence}`, 'server-signing-key.json'));
  vi.stubEnv('RESOURCE_ENROLLMENT_DASHBOARD_PARTICIPANT', 'absent');
  resetServerSigningKeyCache();
  allowServerKeyCreation();
  keys.current = ''; keys.previous = '';
});
afterEach(() => { resetServerSigningKeyCache(); vi.unstubAllEnvs(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('console drain findings in absent mode', () => {
  it('signs a new finding with the server key and no shared key, and verifies it exactly', () => {
    const receipt = serverSigned();
    expect(receipt).not.toHaveProperty('signature');
    expect(receipt.serverSignature).toMatchObject({ alg: 'ed25519', v: 1, nodeId: 'node-1', keyId: serverSigningKey().keyId });
    const { serverSignature: _signature, ...unsigned } = receipt;
    expect(verifiedDashboardReceipt('node-1', receipt)).toEqual(unsigned);
    // Any change to what it covers, another node, or a signature moved to another key is refused.
    expect(verifiedDashboardReceipt('node-1', { ...receipt, evidenceSha256: 'b'.repeat(64) })).toBeNull();
    expect(verifiedDashboardReceipt('node-1', { ...receipt, epoch: 4 })).toBeNull();
    expect(verifiedDashboardReceipt('node-2', receipt)).toBeNull();
    expect(verifiedDashboardReceipt('node-1', { ...receipt, serverSignature: { ...receipt.serverSignature, keyId: 'c'.repeat(64) } })).toBeNull();
    // It never carries nonzero counts or another participant, and never a second signature.
    expect(verifiedDashboardReceipt('node-1', { ...receipt, signature: 'd'.repeat(64) })).toBeNull();
    expect(verifiedDashboardReceipt('node-1', serverSigned({ ...unsignedReceipt(), unknownCount: 1 } as never))).toBeNull();
  });

  it('keeps verifying a finding after the server key is rotated and the signing key retired', () => {
    const receipt = serverSigned();
    const signedWith = serverSigningKey().keyId;
    stageNextServerKey();
    promoteNextServerKey();
    expect(serverSigningKey().keyId).not.toBe(signedWith);
    retirePreviousServerKey({ force: true });
    expect(serverVerificationKeys().find(key => key.keyId === signedWith)?.status).toBe('retired');
    expect(verifiedDashboardReceipt('node-1', receipt)).not.toBeNull();
    // A new finding names the new key.
    expect(serverSigned().serverSignature.keyId).toBe(serverSigningKey().keyId);
  });

  it('is not valid under a server key this server never held', () => {
    const receipt = serverSigned();
    vi.stubEnv('NODE_AUTH_SERVER_KEY_PATH', join(dir, `key-${++sequence}`, 'server-signing-key.json'));
    resetServerSigningKeyCache();
    expect(verifiedDashboardReceipt('node-1', receipt)).toBeNull();
  });

  it('verifies a finding 3.0.1 stored with RESULT_SIGNING_SECRET, also once that key moved to RESULT_SIGNING_PREVIOUS_SECRET', () => {
    const legacy = hmacSigned(sharedResultKey);
    keys.current = sharedResultKey;
    expect(verifiedDashboardReceipt('node-1', legacy)).not.toBeNull();
    keys.current = ''; keys.previous = sharedResultKey;
    expect(verifiedDashboardReceipt('node-1', legacy)).not.toBeNull();
    expect(verifiedDashboardReceipt('node-1', { ...legacy, evidenceSha256: 'b'.repeat(64) })).toBeNull();
    expect(verifiedDashboardReceipt('node-2', legacy)).toBeNull();
    // A node signature has no place on the server's own finding.
    expect(verifiedDashboardReceipt('node-1', { ...legacy, nodeSignature: serverSigned().serverSignature })).toBeNull();
    keys.previous = '';
    expect(verifiedDashboardReceipt('node-1', legacy)).toBeNull();
    keys.current = 'another-result-signing-fixture-at-least-32-chars';
    expect(verifiedDashboardReceipt('node-1', legacy)).toBeNull();
  });

  it('accepts neither kind once a real console participant is configured, only its own HMAC', () => {
    keys.current = sharedResultKey;
    const own = serverSigned(); const legacy = hmacSigned(sharedResultKey);
    vi.stubEnv('RESOURCE_ENROLLMENT_DASHBOARD_PARTICIPANT', '');
    vi.stubEnv('RESOURCE_ENROLLMENT_DASHBOARD_SECRET', dashboardKey);
    expect(verifiedDashboardReceipt('node-1', own)).toBeNull();
    expect(verifiedDashboardReceipt('node-1', legacy)).toBeNull();
    expect(verifiedDashboardReceipt('node-1', hmacSigned(dashboardKey))).not.toBeNull();
  });
});

describe('server-own evidence', () => {
  it('has its own protocol line, so it never passes as a decision for an agent', () => {
    const payload = enrollmentSigningPayload(unsignedReceipt());
    const signature = signServerOwnEvidence('console-drain-receipt', 'node-1', payload);
    expect(serverOwnEvidenceSigningInput('console-drain-receipt', 'node-1', signature.keyId, payload).split('\n')[0]).toBe(SERVER_OWN_EVIDENCE_PROTOCOL);
    expect(verifyServerOwnEvidence('console-drain-receipt', 'node-1', payload, signature)).toBe(true);
    const active = serverVerificationKeys()[0]!;
    expect(verifyServerAuthorization('command-reconciliation', { signature, publicKey: active.publicKey, expectedNodeId: 'node-1', payload }))
      .toEqual({ ok: false, reason: 'SIGNATURE' });
    expect(verifyServerOwnEvidence('console-drain-receipt', 'node-1', payload, 'not a signature')).toBe(false);
    expect(verifyServerOwnEvidence('console-drain-receipt', 'node-1', payload, undefined)).toBe(false);
  });

  it('answers 503 SERVER_KEY_UNAVAILABLE when the server key cannot be read', () => {
    vi.stubEnv('NODE_AUTH_SERVER_KEY_PATH', join(dir, 'missing', 'server-signing-key.json'));
    resetServerSigningKeyCache();
    // A command-line process may not create the key; nothing else is signed in its place.
    vi.resetModules();
    return import('./server-own-evidence.js').then(fresh => {
      expect(() => fresh.signServerOwnEvidence('console-drain-receipt', 'node-1', '{}'))
        .toThrow(expect.objectContaining({ status: 503, code: 'SERVER_KEY_UNAVAILABLE' }));
    });
  });
});
