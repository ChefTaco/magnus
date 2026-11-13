import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/env.js', async original => ({ ...await original<object>(), getNodeManagerSecret: () => 'node-agent-auth-fixture-shared-secret-32chars' }));
const { createFakeCredentialStore, fixtureAgentKey } = await import('./node-credential-test-fixture.js');
const fake = createFakeCredentialStore();
vi.mock('./node-credential-store.js', () => ({ nodeCredentialStore: fake.store }));
const auth = await import('./node-agent-auth.js');
const { serverSigningKey } = await import('./node-server-key.js');
const { pendingLegacyUse, resetLegacyUseState } = await import('./node-legacy-use.js');

beforeEach(() => { fake.reset(); auth.resetAgentAuthState(); resetLegacyUseState(); });

describe('server-to-agent shared secret and the evidence ratchet', () => {
  it('counts the shared secret it still sends to a node, and stops once the node pins the server key', () => {
    const url = 'https://node-a.example.com:4100/api/v1/files?path=%2Fetc';
    expect(auth.agentAuthHeaders({ nodeId: 'node-a' }, 'GET', url)['x-node-token']).toBeDefined();
    expect(pendingLegacyUse()).toEqual([expect.objectContaining({ nodeId: 'node-a', channel: 'outbound', count: 1, detail: 'GET /api/v1/files' })]);
    auth.noteAgentServerKeyPins('node-a', [serverSigningKey().keyId]);
    expect(auth.agentAuthHeaders({ nodeId: 'node-a' }, 'GET', url)['x-node-token']).toBeUndefined();
    expect(pendingLegacyUse()[0]!.count).toBe(1);
  });

  it('records what a key\'s agent says about signing evidence, on and off again', async () => {
    const key = fixtureAgentKey();
    fake.state.nodes.push({ id: 'node-a', name: 'node-a', hostname: 'node-a.example.com', ipAddress: '192.0.2.10', port: 4100, status: 'ONLINE' });
    await fake.store.bindFirst({ nodeId: 'node-a', keyId: key.keyId, publicKey: key.publicKey, boundFqdn: 'node-a.example.com' }, 'LEGACY_UPGRADE');
    auth.noteAgentEvidenceSigning(key.keyId, true);
    await vi.waitFor(() => expect(fake.state.credentials[0]!.evidenceSigning).toBe(true));
    // An agent downgraded to a version that does not sign evidence lifts the ratchet with its own signed heartbeat.
    auth.noteAgentEvidenceSigning(key.keyId, false);
    await vi.waitFor(() => expect(fake.state.credentials[0]!.evidenceSigning).toBe(false));
  });
});
