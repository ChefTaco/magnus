import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandResultSigningPayload } from '../security/node-evidence.js';
import type { CredentialRow } from './node-credential-store.js';

const audits = vi.hoisted(() => [] as Array<{ action: string; details: Record<string, unknown> }>);
vi.mock('./audit-service.js', () => ({ logAuditEvent: async (event: { action: string; details: Record<string, unknown> }) => { audits.push(event); } }));
const { createFakeCredentialStore, fixtureAgentKey } = await import('./node-credential-test-fixture.js');
const fake = createFakeCredentialStore();
vi.mock('./node-credential-store.js', () => ({ nodeCredentialStore: fake.store }));
const { evidencePolicyFor, nodeEvidencePolicy, resetEvidencePolicyState } = await import('./node-evidence-policy.js');
const { pendingLegacyUse, resetLegacyUseState } = await import('./node-legacy-use.js');

const result = { commandId: 'cmd-1', exitCode: 0, stdout: 'ok', stderr: '', durationMs: 3, truncated: false };
const payload = commandResultSigningPayload(result);
const hmacOk = () => true;
const hmacBad = () => false;

function row(nodeId: string, agent: { keyId: string; publicKey: string }, patch: Partial<CredentialRow> = {}): CredentialRow {
  return { id: `cred-${agent.keyId.slice(0, 6)}`, nodeId, keyId: agent.keyId, publicKey: agent.publicKey, status: 'ACTIVE', origin: 'LEGACY_UPGRADE',
    boundFqdn: `${nodeId}.example.com`, createdAt: new Date(), lastUsedAt: null, retireAt: null, revokedAt: null, revokedBy: null,
    evidenceSigning: false, evidenceSigningAt: null, ...patch };
}

beforeEach(() => { fake.reset(); audits.length = 0; resetEvidencePolicyState(); resetLegacyUseState(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('node evidence policy', () => {
  it('accepts evidence signed by the node key, and only for that node', () => {
    const agent = fixtureAgentKey();
    const signature = agent.evidence('node-a', 'command-result', payload);
    const policy = evidencePolicyFor('node-a', [row('node-a', agent)]);
    expect(policy.check('command-result', payload, signature, hmacBad)).toEqual({ ok: true, method: 'ed25519' });
    // The same signature presented as another node's evidence.
    expect(evidencePolicyFor('node-b', [row('node-b', agent)]).check('command-result', payload, signature, hmacOk))
      .toEqual({ ok: false, reason: 'WRONG_NODE' });
    // Another kind, a changed payload, a replayed signature for another command: refused, and a valid HMAC does not rescue it.
    expect(policy.check('command-refusal', payload, signature, hmacOk)).toEqual({ ok: false, reason: 'NODE_SIGNATURE_INVALID' });
    expect(policy.check('command-result', commandResultSigningPayload({ ...result, exitCode: 1 }), signature, hmacOk))
      .toEqual({ ok: false, reason: 'NODE_SIGNATURE_INVALID' });
    expect(policy.check('command-result', commandResultSigningPayload({ ...result, commandId: 'cmd-2' }), signature, hmacOk))
      .toEqual({ ok: false, reason: 'NODE_SIGNATURE_INVALID' });
    expect(policy.check('command-result', payload, { ...signature, sig: 'x' }, hmacOk)).toEqual({ ok: false, reason: 'NODE_SIGNATURE_INVALID' });
    expect(audits.map(event => event.details['reason'])).toEqual(expect.arrayContaining(['WRONG_NODE', 'NODE_SIGNATURE_INVALID']));
  });

  it('refuses a revoked key and a retired key after its grace period', () => {
    const agent = fixtureAgentKey();
    const signature = agent.evidence('node-a', 'command-result', payload);
    expect(evidencePolicyFor('node-a', [row('node-a', agent, { status: 'REVOKED' })]).check('command-result', payload, signature, hmacOk))
      .toEqual({ ok: false, reason: 'KEY_NOT_VALID' });
    expect(evidencePolicyFor('node-a', [row('node-a', agent, { status: 'RETIRING', retireAt: new Date(Date.now() - 1) })]).verify('command-result', payload, signature, hmacOk))
      .toBe(false);
    expect(evidencePolicyFor('node-a', [row('node-a', agent, { status: 'RETIRING', retireAt: new Date(Date.now() + 60_000) })]).verify('command-result', payload, signature, hmacBad))
      .toBe(true);
  });

  it('falls back to the HMAC for a node whose agent does not sign evidence, and counts it as legacy use', () => {
    const agent = fixtureAgentKey();
    const keyless = evidencePolicyFor('node-a', []);
    expect(keyless.check('command-result', payload, undefined, hmacOk)).toEqual({ ok: true, method: 'hmac' });
    expect(keyless.check('command-result', payload, undefined, hmacBad)).toEqual({ ok: false, reason: 'HMAC_INVALID' });
    // A phase-1 agent: it has a key but does not sign evidence yet.
    expect(evidencePolicyFor('node-a', [row('node-a', agent)]).check('command-result', payload, undefined, hmacOk)).toEqual({ ok: true, method: 'hmac' });
    // A signature by a key this server does not know (restored records) is judged by the HMAC rules.
    const stranger = fixtureAgentKey();
    expect(evidencePolicyFor('node-a', [row('node-a', agent)]).check('command-result', payload, stranger.evidence('node-a', 'command-result', payload), hmacOk))
      .toEqual({ ok: true, method: 'hmac' });
    expect(pendingLegacyUse()).toEqual([expect.objectContaining({ nodeId: 'node-a', channel: 'evidence', count: 3, detail: 'command-result' })]);
  });

  it('refuses HMAC-only evidence for a node whose agent signs its evidence (the ratchet)', () => {
    const agent = fixtureAgentKey();
    const policy = evidencePolicyFor('node-a', [row('node-a', agent, { evidenceSigning: true })]);
    expect(policy.requiresNodeSignature).toBe(true);
    expect(policy.check('command-result', payload, undefined, hmacOk)).toEqual({ ok: false, reason: 'HMAC_REFUSED' });
    const stranger = fixtureAgentKey();
    expect(policy.check('command-result', payload, stranger.evidence('node-a', 'command-result', payload), hmacOk)).toEqual({ ok: false, reason: 'HMAC_REFUSED' });
    expect(policy.verify('command-result', payload, agent.evidence('node-a', 'command-result', payload), hmacBad)).toBe(true);
    // Only a usable key holds the ratchet: a revoked one does not keep refusing a re-enrolled node's HMAC.
    expect(evidencePolicyFor('node-a', [row('node-a', agent, { evidenceSigning: true, status: 'REVOKED' })]).verify('command-result', payload, undefined, hmacOk)).toBe(true);
    expect(pendingLegacyUse()).toEqual([expect.objectContaining({ count: 1 })]);
  });

  it('accepts only node signatures in enforce mode', () => {
    vi.stubEnv('NODE_AUTH_MODE', 'enforce');
    const agent = fixtureAgentKey();
    expect(evidencePolicyFor('node-a', []).check('command-result', payload, undefined, hmacOk)).toEqual({ ok: false, reason: 'HMAC_REFUSED' });
    expect(evidencePolicyFor('node-a', [row('node-a', agent)]).check('command-result', payload, undefined, hmacOk)).toEqual({ ok: false, reason: 'HMAC_REFUSED' });
    expect(evidencePolicyFor('node-a', [row('node-a', agent)]).verify('command-result', payload, agent.evidence('node-a', 'command-result', payload), hmacBad)).toBe(true);
    expect(evidencePolicyFor(null, []).verify('command-result', payload, undefined, hmacOk)).toBe(false);
  });

  it('loads the node rows from the credential store and audits legacy use in warn mode once a day', async () => {
    vi.stubEnv('NODE_AUTH_MODE', 'warn');
    const agent = fixtureAgentKey();
    fake.state.credentials.push(row('node-a', agent));
    const policy = await nodeEvidencePolicy('node-a');
    expect(policy.verify('command-result', payload, agent.evidence('node-a', 'command-result', payload), hmacBad)).toBe(true);
    expect(policy.verify('command-result', payload, undefined, hmacOk)).toBe(true);
    expect(policy.verify('command-result', payload, undefined, hmacOk)).toBe(true);
    await vi.waitFor(() => expect(audits.filter(event => event.action === 'node.credential.legacy_use')).toHaveLength(1));
    expect(audits[0]).toMatchObject({ details: { channel: 'evidence', detail: 'command-result', mode: 'warn' } });
  });
});
