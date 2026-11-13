/** In-memory stand-in for node-credential-store.ts, with the same first-writer-wins and one-time-token rules. Tests only. */
import { generateSigningKey, privateKeyFromPem, serverAudience, signEnrollmentProof, signNodeRequest, type EnrollmentPurpose } from '../security/node-request-auth.js';
import type { CredentialNode, CredentialRow, NewCredential, NodeCredentialOrigin } from './node-credential-store.js';

interface Token { id: string; tokenSha256: string; nodeId: string; expiresAt: Date; usedAt: Date | null; usedKeyId: string | null; createdBy: string }

export function createFakeCredentialStore() {
  const state = { nodes: [] as CredentialNode[], credentials: [] as CredentialRow[], tokens: [] as Token[], startedAt: new Date(), touched: [] as string[] };
  let sequence = 0;
  const add = (input: NewCredential, origin: NodeCredentialOrigin): void => {
    state.credentials.push({ id: `cred-${++sequence}`, ...input, status: 'ACTIVE', origin, createdAt: new Date(), lastUsedAt: null,
      retireAt: null, revokedAt: null, revokedBy: null });
  };
  const keyTaken = (keyId: string) => state.credentials.some(entry => entry.keyId === keyId);
  const store = {
    async credentialByKeyId(keyId: string) {
      const credential = state.credentials.find(entry => entry.keyId === keyId);
      const node = credential && state.nodes.find(entry => entry.id === credential.nodeId);
      return credential && node ? { credential, node } : null;
    },
    async credentialsOfNode(nodeId: string) { return state.credentials.filter(entry => entry.nodeId === nodeId); },
    async nodesWithCredentials(nodeIds: string[]) { return new Set(state.credentials.map(entry => entry.nodeId).filter(id => nodeIds.includes(id))); },
    async nodesClaimedBy(claims: { nodeId?: string; fqdn?: string }) {
      const fqdn = claims.fqdn?.toLowerCase();
      return state.nodes.filter(node => node.id === claims.nodeId || (fqdn !== undefined && (node.hostname.toLowerCase() === fqdn
        || node.name.toLowerCase() === fqdn || state.credentials.some(entry => entry.nodeId === node.id && entry.boundFqdn === fqdn))));
    },
    async otherNodeHasHostname(nodeId: string, fqdn: string) {
      return state.nodes.some(node => node.id !== nodeId && node.hostname.toLowerCase() === fqdn.toLowerCase());
    },
    async nodeById(nodeId: string) { return state.nodes.find(node => node.id === nodeId) ?? null; },
    async nodesForFqdn(aliases: string[], shortName: string) {
      return state.nodes.filter(node => node.status !== 'DECOMMISSIONED'
        && (aliases.includes(node.hostname) || aliases.includes(node.name) || node.name === shortName));
    },
    async nodesByAddress(address: string) { return state.nodes.filter(node => node.status !== 'DECOMMISSIONED' && node.ipAddress === address); },
    async bindFirst(input: NewCredential, origin: NodeCredentialOrigin) {
      const existing = state.credentials.filter(entry => entry.nodeId === input.nodeId);
      if (existing.some(entry => entry.keyId === input.keyId && entry.status === 'ACTIVE')) return 'same' as const;
      if (existing.length > 0) return 'exists' as const;
      if (keyTaken(input.keyId)) return 'key-in-use' as const;
      add(input, origin);
      return 'bound' as const;
    },
    async createEnrollmentToken(input: { nodeId: string; tokenSha256: string; expiresAt: Date; createdBy: string }) {
      state.tokens = state.tokens.filter(token => token.nodeId !== input.nodeId || token.usedAt !== null);
      state.tokens.push({ id: `token-${++sequence}`, ...input, usedAt: null, usedKeyId: null });
    },
    async bindWithToken(input: { tokenSha256: string; keyId: string; publicKey: string; boundFqdn: string; now: Date }) {
      const token = state.tokens.find(entry => entry.tokenSha256 === input.tokenSha256);
      if (!token) return { outcome: 'invalid' as const };
      const ids = { nodeId: token.nodeId, tokenId: token.id };
      if (token.usedAt) return { outcome: token.usedKeyId === input.keyId
        && state.credentials.some(entry => entry.keyId === input.keyId && entry.status === 'ACTIVE') ? 'same' as const : 'used' as const, ...ids };
      if (token.expiresAt.getTime() <= input.now.getTime()) return { outcome: 'expired' as const, ...ids };
      if (keyTaken(input.keyId)) return { outcome: 'key-in-use' as const };
      token.usedAt = input.now; token.usedKeyId = input.keyId;
      for (const entry of state.credentials) if (entry.nodeId === token.nodeId && entry.status !== 'REVOKED') {
        entry.status = 'REVOKED'; entry.revokedAt = input.now; entry.revokedBy = `enrollment-token:${token.id}`;
      }
      add({ nodeId: token.nodeId, keyId: input.keyId, publicKey: input.publicKey, boundFqdn: input.boundFqdn }, 'ENROLLMENT_TOKEN');
      return { outcome: 'bound' as const, ...ids };
    },
    async rotate(input: NewCredential & { currentKeyId: string; retireAt: Date }) {
      const active = state.credentials.find(entry => entry.nodeId === input.nodeId && entry.status === 'ACTIVE');
      if (active?.keyId === input.keyId) return 'same' as const;
      if (!active || active.keyId !== input.currentKeyId) return 'stale' as const;
      if (keyTaken(input.keyId)) return 'key-in-use' as const;
      active.status = 'RETIRING'; active.retireAt = input.retireAt;
      add({ nodeId: input.nodeId, keyId: input.keyId, publicKey: input.publicKey, boundFqdn: input.boundFqdn }, 'ROTATION');
      return 'rotated' as const;
    },
    async revoke(nodeId: string, keyId: string | null, revokedBy: string, now: Date) {
      const matching = state.credentials.filter(entry => entry.nodeId === nodeId && entry.status !== 'REVOKED' && (!keyId || entry.keyId === keyId));
      for (const entry of matching) { entry.status = 'REVOKED'; entry.revokedAt = now; entry.revokedBy = revokedBy; }
      return matching.length;
    },
    async reset(nodeId: string) {
      const before = state.credentials.length;
      state.credentials = state.credentials.filter(entry => entry.nodeId !== nodeId);
      state.tokens = state.tokens.filter(token => token.nodeId !== nodeId);
      return before - state.credentials.length;
    },
    async touch(keyId: string, at: Date) {
      state.touched.push(keyId);
      const credential = state.credentials.find(entry => entry.keyId === keyId);
      if (credential) credential.lastUsedAt = at;
    },
    async legacyUpgradeStartedAt() { return state.startedAt; },
    async summaries(nodeIds: string[]) {
      return new Map(nodeIds.map(id => [id, state.credentials.filter(entry => entry.nodeId === id)] as const).filter(([, rows]) => rows.length > 0));
    },
  };
  return { state, store, reset(): void { state.nodes = []; state.credentials = []; state.tokens = []; state.startedAt = new Date(); state.touched = []; } };
}

export function fixtureNode(id: string, hostname: string, ipAddress: string, overrides: Partial<CredentialNode> = {}): CredentialNode {
  return { id, name: hostname, hostname, ipAddress, port: 4100, status: 'ONLINE', ...overrides };
}

/** A node key as an agent holds it, with helpers to sign what an agent sends. */
export function fixtureAgentKey() {
  const key = generateSigningKey();
  const privateKey = privateKeyFromPem(key.privateKeyPem);
  return {
    keyId: key.keyId, publicKey: key.publicKey,
    proof: (purpose: EnrollmentPurpose, fqdn: string, binding: string, now = Date.now()) =>
      signEnrollmentProof(privateKey, { purpose, publicKey: key.publicKey, fqdn, binding }, now),
    sign: (input: { nodeId: string; serverKeyId: string; method?: string; path: string; body?: string; now?: number; nonce?: string }) =>
      signNodeRequest({ privateKey, keyId: key.keyId, nodeId: input.nodeId, audience: serverAudience(input.serverKeyId),
        method: input.method ?? 'POST', pathWithQuery: input.path, body: input.body ?? '',
        ...(input.now === undefined ? {} : { now: input.now }), ...(input.nonce === undefined ? {} : { nonce: input.nonce }) }),
  };
}
