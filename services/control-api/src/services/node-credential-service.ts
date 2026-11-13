/**
 * Per-node credentials: binding a node's first key (enrollment token or the legacy upgrade),
 * rotation, revocation, and the rule that closes a node to the shared secret once it has a key.
 * See docs/NODE_CREDENTIALS.md.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { compareVersions, isVersion } from '@hivemagnus/magnus-contracts';
import { HttpError } from '../middleware/error-handler.js';
import { keyFingerprint, keyIdOfSpki, NonceCache, verifyEnrollmentProof, type EnrollmentPurpose } from '../security/node-request-auth.js';
import { isLoopbackOrUnroutableIp, normalizeIpAddress } from '../utils/ip.js';
import { logAuditEvent } from './audit-service.js';
import { ENROLLMENT_TOKEN_DEFAULT_TTL_SECONDS, ENROLLMENT_TOKEN_MAX_TTL_SECONDS, legacyUpgradeDeadline, nodeAuthMode,
  ROTATION_GRACE_MS } from './node-auth-config.js';
import { nodeCredentialStore, type CredentialNode, type CredentialRow, type LegacyUseRow, type PendingBindingRow } from './node-credential-store.js';
import { serverPublicKeys, type ServerPublicKey } from './node-server-key.js';
import { createNotification } from './notification-service.js';

const proofNonces = new NonceCache();
// Deliberately loose (underscores occur in real host names); it only has to be a single safe token.
const FQDN = /^[a-z0-9](?:[a-z0-9._-]{0,251}[a-z0-9])?$/;

export interface EnrollmentProof { timestamp: string; nonce: string; signature: string }
export interface BindingResult {
  nodeId: string;
  nodeName: string;
  keyId: string;
  /** The server keys the agent pins: it signs for the active one and verifies inbound requests with them. */
  serverKeys: ServerPublicKey[];
  mode: string;
}

/** The names an agent reporting `fqdn` may be recorded under (the heartbeat uses the same set). */
export function nodeFqdnAliases(fqdn: string, env: NodeJS.ProcessEnv = process.env): { aliases: string[]; shortName: string } {
  const shortName = fqdn.split('.')[0] || fqdn;
  const dnsSuffix = env['MAGNUS_NODE_DNS_SUFFIX']?.trim().replace(/^\.+|\.+$/g, '');
  return { aliases: [fqdn, shortName, ...(dnsSuffix ? [`${shortName}.${dnsSuffix}`] : [])], shortName };
}

/** Whether a signed caller's FQDN claim names the node its key belongs to. */
export function fqdnClaimMatchesNode(fqdn: string, node: { hostname: string; name: string }, boundFqdn: string): boolean {
  const claimed = fqdn.trim().toLowerCase();
  if (!claimed) return false;
  if (boundFqdn && claimed === boundFqdn.toLowerCase()) return true;
  const { aliases, shortName } = nodeFqdnAliases(claimed);
  const names = [node.hostname.toLowerCase(), node.name.toLowerCase()];
  return names.some(name => aliases.includes(name)) || node.name.toLowerCase() === shortName;
}

function normalizedFqdn(value: string): string {
  const fqdn = value.trim().toLowerCase();
  if (!FQDN.test(fqdn)) throw new HttpError(400, 'VALIDATION_ERROR', 'fqdn must be a host name');
  return fqdn;
}

function proofOrRefuse(purpose: EnrollmentPurpose, publicKey: string, fqdn: string, binding: string, proof: EnrollmentProof): string {
  let keyId: string;
  try { keyId = keyIdOfSpki(publicKey); }
  catch { throw new HttpError(400, 'NODE_KEY_INVALID', 'publicKey must be a base64 Ed25519 SPKI'); }
  const verified = verifyEnrollmentProof({ purpose, publicKey, fqdn, binding, ...proof });
  if (!verified.ok) throw new HttpError(verified.reason === 'SKEW' ? 401 : 400,
    verified.reason === 'SKEW' ? 'NODE_AUTH_SKEW' : 'NODE_KEY_PROOF_INVALID',
    verified.reason === 'SKEW' ? 'The proof timestamp is outside the accepted clock window' : 'The proof of possession does not verify');
  if (!proofNonces.claim(keyId, proof.nonce)) throw new HttpError(401, 'NODE_AUTH_REPLAY', 'This proof was already used');
  return keyId;
}

async function notify(node: { id: string; name: string }, severity: 'info' | 'warning' | 'critical', event: string, title: string, message: string,
  metadata: Record<string, unknown> = {}): Promise<void> {
  await createNotification({ type: 'node.credential', severity, title, message, nodeId: node.id, nodeName: node.name,
    sourceRef: event, metadata: { event, ...metadata } }).catch((error: unknown) => {
    console.warn(`[node-auth] could not record a notification for ${node.name}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

const refusalAudits = new Map<string, number>();
/**
 * Audit a refusal once per node and reason in a period: an agent that retries for weeks (a binding
 * refused every hour, a mismatched heartbeat every 30 seconds) must not flood the chain or the inbox.
 * A refused binding is reported daily, a signed request that names another node hourly.
 */
async function auditRefusal(action: 'node.credential.bind_refused' | 'node.credential.identity_mismatch', node: { id: string; name: string } | null,
  reason: string, details: Record<string, unknown>, now = Date.now()): Promise<boolean> {
  const id = `${action}:${node?.id ?? '-'}:${reason}`;
  const period = action === 'node.credential.bind_refused' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  if ((refusalAudits.get(id) ?? 0) > now - period) return false;
  if (refusalAudits.size > 5000) refusalAudits.clear();
  refusalAudits.set(id, now);
  await logAuditEvent({ action, actorType: 'agent', actorId: node ? `node:${node.id}` : 'node:unknown', targetType: 'node',
    targetId: node?.id ?? 'unknown', details: { reason, ...details } });
  return true;
}

/** Report a signed caller whose body names another node. Throttled; returns nothing the caller needs. */
export async function reportIdentityMismatch(node: { id: string; name: string }, keyId: string, claim: Record<string, unknown>): Promise<void> {
  if (await auditRefusal('node.credential.identity_mismatch', node, 'claim', { keyFingerprint: keyFingerprint(keyId), ...claim }))
    await notify(node, 'warning', 'identity-mismatch', `${node.name} presented another node's identity`,
      `A request signed with the key of ${node.name} named a different node and was refused. If the host was renamed, update the node's host name; if a disk image was cloned, enroll the copy with its own token.`, claim);
}

let windowStartedAt: Date | null = null;
export async function legacyUpgradeWindow(now = new Date()): Promise<{ open: boolean; until: string }> {
  // Recorded once per installation; the first server start with node credentials opens the window.
  windowStartedAt ??= await nodeCredentialStore.legacyUpgradeStartedAt();
  const until = legacyUpgradeDeadline(windowStartedAt);
  return { open: nodeAuthMode() !== 'enforce' && now.getTime() < until.getTime(), until: until.toISOString() };
}

async function recordedAddresses(recorded: string): Promise<string[]> {
  const value = normalizeIpAddress(recorded).replace(/^\[|\]$/g, '');
  if (isIP(value) !== 0) return [value];
  try { return (await dns.lookup(value, { all: true })).map(entry => normalizeIpAddress(entry.address)); }
  catch { return []; }
}

function localAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap(entries => entries ?? []).map(entry => normalizeIpAddress(entry.address));
}

/**
 * Whether the socket peer is the address the inventory records for the node. A loopback peer is a
 * process on this host, so it matches only a node recorded at one of this host's own addresses.
 */
export async function peerMatchesNode(peerAddress: string, recorded: string,
  resolve: (recorded: string) => Promise<string[]> = recordedAddresses, local: () => string[] = localAddresses): Promise<boolean> {
  const peer = normalizeIpAddress(peerAddress);
  if (!peer || isIP(peer) === 0) return false;
  const addresses = await resolve(recorded);
  if (addresses.includes(peer)) return true;
  if (!isLoopbackOrUnroutableIp(peer) || peer === '0.0.0.0' || peer === '::') return false;
  const own = local();
  return addresses.some(address => (isLoopbackOrUnroutableIp(address) && address !== '0.0.0.0' && address !== '::') || own.includes(address));
}

async function resolveUpgradeNode(reported: string, peerAddress: string): Promise<CredentialNode> {
  // The heartbeat matches the name exactly as the agent reports it, so both spellings are tried.
  const exact = nodeFqdnAliases(reported.trim());
  const lower = nodeFqdnAliases(reported.trim().toLowerCase());
  let candidates = await nodeCredentialStore.nodesForFqdn([...new Set([...exact.aliases, ...lower.aliases])], exact.shortName);
  // The heartbeat falls back to the caller's address for nodes recorded under another name.
  if (candidates.length === 0 && isIP(normalizeIpAddress(peerAddress)) !== 0)
    candidates = await nodeCredentialStore.nodesByAddress(normalizeIpAddress(peerAddress));
  if (candidates.length === 0) throw new HttpError(404, 'NODE_NOT_FOUND', 'No inventory node matches this agent yet; it is added by its first heartbeat');
  if (candidates.length > 1) throw new HttpError(409, 'NODE_AMBIGUOUS', 'More than one inventory node matches this agent; remove the duplicate or enroll with a token');
  return candidates[0]!;
}

function binding(node: CredentialNode, keyId: string): BindingResult {
  return { nodeId: node.id, nodeName: node.name, keyId, serverKeys: serverPublicKeys(), mode: nodeAuthMode() };
}

/**
 * Hands-off migration: an agent that holds the shared secret binds the first key of the node it
 * already is. Refused unless the node exists, has no credential yet, the caller's socket address is
 * the node's recorded address, and the upgrade window is open.
 */
/**
 * The binding of a key an administrator already approved (or that is already bound): its holder
 * learns its node id and the server keys, whatever the window and peer rules say.
 */
async function alreadyBound(fqdn: string, keyId: string): Promise<BindingResult | null> {
  const found = await nodeCredentialStore.credentialByKeyId(keyId);
  if (!found || found.credential.status !== 'ACTIVE' || !fqdnClaimMatchesNode(fqdn, found.node, found.credential.boundFqdn)) return null;
  return binding(found.node, keyId);
}

export async function legacyUpgrade(input: { fqdn: string; publicKey: string; proof: EnrollmentProof; peerAddress: string }): Promise<BindingResult> {
  const window = await legacyUpgradeWindow();
  if (!window.open) {
    // A binding an administrator approved after the window closed must still reach its agent.
    if (nodeAuthMode() !== 'enforce') {
      try {
        const fqdn = normalizedFqdn(input.fqdn);
        const bound = await alreadyBound(fqdn, proofOrRefuse('legacy-upgrade', input.publicKey, fqdn, '-', input.proof));
        if (bound) return bound;
      } catch { /* refused as closed below */ }
    }
    throw new HttpError(410, 'LEGACY_UPGRADE_CLOSED', `The automatic upgrade of existing nodes closed on ${window.until}; enroll this node with a token`);
  }
  const fqdn = normalizedFqdn(input.fqdn);
  const keyId = proofOrRefuse('legacy-upgrade', input.publicKey, fqdn, '-', input.proof);
  const node = await resolveUpgradeNode(input.fqdn, input.peerAddress);
  const peer = normalizeIpAddress(input.peerAddress);
  // Already bound to this very key (an administrator approved its pending binding): answer the binding.
  if ((await nodeCredentialStore.credentialsOfNode(node.id)).some(row => row.keyId === keyId && row.status === 'ACTIVE')) return binding(node, keyId);
  if (!await peerMatchesNode(peer, node.ipAddress)) {
    // Kept for an administrator, who can approve it after comparing fingerprints (docs/NODE_CREDENTIALS.md).
    const pending = await nodeCredentialStore.recordPendingBinding({ nodeId: node.id, keyId, publicKey: input.publicKey, fqdn, peerAddress: peer,
      recordedAddress: node.ipAddress, now: new Date() }).catch((error: unknown) => {
      console.warn(`[node-auth] could not record a pending binding for ${node.name}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (pending?.created) await logAuditEvent({ action: 'node.credential.binding_pending', actorType: 'agent', actorId: `node:${node.id}`, targetType: 'node',
      targetId: node.id, details: { pendingBindingId: pending.row.id, keyFingerprint: keyFingerprint(keyId), peerAddress: peer, recordedAddress: node.ipAddress } });
    if (await auditRefusal('node.credential.bind_refused', node, 'PEER_ADDRESS_MISMATCH', { peerAddress: peer, recordedAddress: node.ipAddress,
      keyFingerprint: keyFingerprint(keyId) }))
      await notify(node, 'warning', 'bind-refused-peer', `${node.name} could not bind its node key`,
        `An agent reporting ${fqdn} asked to bind the key ${keyFingerprint(keyId)} from ${peer || 'an unknown address'}, but ${node.name} is recorded at ${node.ipAddress}. If this is the same host, compare the fingerprint with \`magnus-agent identity show\` and approve the pending binding, repair the node's address, or enroll it with a token.`,
        { peerAddress: peer, ...(pending ? { pendingBindingId: pending.row.id } : {}) });
    throw new HttpError(403, 'PEER_ADDRESS_MISMATCH', 'The caller address is not the address recorded for this node; an administrator can approve the pending binding');
  }
  const outcome = await nodeCredentialStore.bindFirst({ nodeId: node.id, keyId, publicKey: input.publicKey, boundFqdn: fqdn }, 'LEGACY_UPGRADE');
  if (outcome === 'exists' || outcome === 'key-in-use') {
    const reason = outcome === 'exists' ? 'NODE_CREDENTIAL_EXISTS' : 'NODE_KEY_IN_USE';
    if (await auditRefusal('node.credential.bind_refused', node, reason, { peerAddress: peer, keyFingerprint: keyFingerprint(keyId) }))
      await notify(node, 'critical', 'bind-refused-conflict', `A second agent tried to bind ${node.name}`,
        outcome === 'exists'
          ? `${node.name} already has a node key, and another agent (key ${keyFingerprint(keyId)}, from ${peer}) asked to bind one. If the first binding was not this host, revoke it and enroll the node with a token.`
          : `The key ${keyFingerprint(keyId)} already belongs to another node. A cloned host must be enrolled with its own token.`,
        { peerAddress: peer, keyFingerprint: keyFingerprint(keyId) });
    throw new HttpError(409, reason, outcome === 'exists'
      ? 'This node already has a credential; an administrator must revoke or reset it, or issue an enrollment token'
      : 'This key is already bound to another node');
  }
  if (outcome === 'bound') {
    await logAuditEvent({ action: 'node.credential.bind', actorType: 'agent', actorId: `node:${node.id}`, targetType: 'node', targetId: node.id,
      details: { origin: 'LEGACY_UPGRADE', keyFingerprint: keyFingerprint(keyId), keyId, fqdn, peerAddress: peer } });
    await notify(node, 'info', `bound:${keyId.slice(0, 16)}`, `${node.name} now has its own node key`,
      `${node.name} bound the key ${keyFingerprint(keyId)} from ${peer}. The shared node secret can no longer speak for this node. Compare the fingerprint with \`magnus-agent identity show\` on the host if you want to confirm it.`,
      { origin: 'LEGACY_UPGRADE', keyFingerprint: keyFingerprint(keyId) });
  }
  return binding(node, keyId);
}

export async function issueEnrollmentToken(nodeId: string, actorId: string, ttlSeconds = ENROLLMENT_TOKEN_DEFAULT_TTL_SECONDS):
  Promise<{ token: string; expiresAt: string }> {
  const node = await nodeCredentialStore.nodeById(nodeId);
  if (!node) throw new HttpError(404, 'NOT_FOUND', 'Node not found');
  const ttl = Math.min(Math.max(Math.trunc(ttlSeconds), 60), ENROLLMENT_TOKEN_MAX_TTL_SECONDS);
  const token = `mne_${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  await nodeCredentialStore.createEnrollmentToken({ nodeId, tokenSha256: createHash('sha256').update(token).digest('hex'), expiresAt, createdBy: actorId });
  await logAuditEvent({ action: 'node.enrollment_token.issue', actorId, targetType: 'node', targetId: nodeId,
    details: { expiresAt: expiresAt.toISOString() } });
  return { token, expiresAt: expiresAt.toISOString() };
}

/** A one-time token from an administrator binds a key and replaces whatever the node had. */
export async function enrollWithToken(input: { token: string; fqdn: string; publicKey: string; proof: EnrollmentProof; peerAddress: string }): Promise<BindingResult> {
  const fqdn = normalizedFqdn(input.fqdn);
  const tokenSha256 = createHash('sha256').update(input.token).digest('hex');
  const keyId = proofOrRefuse('enroll', input.publicKey, fqdn, tokenSha256, input.proof);
  const result = await nodeCredentialStore.bindWithToken({ tokenSha256, keyId, publicKey: input.publicKey, boundFqdn: fqdn, now: new Date() });
  const node = result.nodeId ? await nodeCredentialStore.nodeById(result.nodeId) : null;
  if (result.outcome === 'invalid' || !node) throw new HttpError(401, 'ENROLLMENT_TOKEN_INVALID', 'The enrollment token is not valid');
  if (result.outcome === 'expired') throw new HttpError(401, 'ENROLLMENT_TOKEN_EXPIRED', 'The enrollment token has expired');
  if (result.outcome === 'used' || result.outcome === 'key-in-use') {
    await auditRefusal('node.credential.bind_refused', node, result.outcome === 'used' ? 'ENROLLMENT_TOKEN_USED' : 'NODE_KEY_IN_USE',
      { keyFingerprint: keyFingerprint(keyId), peerAddress: normalizeIpAddress(input.peerAddress) });
    throw new HttpError(409, result.outcome === 'used' ? 'ENROLLMENT_TOKEN_USED' : 'NODE_KEY_IN_USE',
      result.outcome === 'used' ? 'The enrollment token was already used' : 'This key is already bound; generate a new one');
  }
  if (result.outcome === 'bound') {
    await logAuditEvent({ action: 'node.credential.bind', actorType: 'agent', actorId: `node:${node.id}`, targetType: 'node', targetId: node.id,
      details: { origin: 'ENROLLMENT_TOKEN', keyFingerprint: keyFingerprint(keyId), keyId, fqdn, enrollmentTokenId: result.tokenId,
        peerAddress: normalizeIpAddress(input.peerAddress) } });
    await notify(node, 'info', `bound:${keyId.slice(0, 16)}`, `${node.name} enrolled with a node key`,
      `${node.name} was enrolled with a one-time token and now uses the key ${keyFingerprint(keyId)}.`,
      { origin: 'ENROLLMENT_TOKEN', keyFingerprint: keyFingerprint(keyId) });
  }
  return binding(node, keyId);
}

/** The node replaces its own key; the request is signed with the key being replaced. */
export async function rotateCredential(input: { node: CredentialNode; currentKeyId: string; boundFqdn: string; fqdn: string; publicKey: string; proof: EnrollmentProof }): Promise<BindingResult & { retiresAt: string }> {
  const keyId = proofOrRefuse('rotate', input.publicKey, normalizedFqdn(input.fqdn), input.node.id, input.proof);
  const fqdn = input.boundFqdn || normalizedFqdn(input.fqdn);
  const retireAt = new Date(Date.now() + ROTATION_GRACE_MS);
  const outcome = await nodeCredentialStore.rotate({ nodeId: input.node.id, currentKeyId: input.currentKeyId, keyId, publicKey: input.publicKey,
    boundFqdn: fqdn, retireAt });
  if (outcome === 'stale') throw new HttpError(409, 'NODE_CREDENTIAL_NOT_ACTIVE', 'Only the active key can be rotated');
  if (outcome === 'key-in-use') throw new HttpError(409, 'NODE_KEY_IN_USE', 'This key is already bound; generate a new one');
  if (outcome === 'rotated') {
    await logAuditEvent({ action: 'node.credential.rotate', actorType: 'agent', actorId: `node:${input.node.id}`, targetType: 'node',
      targetId: input.node.id, details: { keyFingerprint: keyFingerprint(keyId), keyId, previousKeyFingerprint: keyFingerprint(input.currentKeyId),
        retiresAt: retireAt.toISOString() } });
    await notify(input.node, 'info', `bound:${keyId.slice(0, 16)}`, `${input.node.name} rotated its node key`,
      `${input.node.name} replaced the key ${keyFingerprint(input.currentKeyId)} with ${keyFingerprint(keyId)}; the old key stays valid until ${retireAt.toISOString()}.`,
      { origin: 'ROTATION', keyFingerprint: keyFingerprint(keyId) });
  }
  return { ...binding(input.node, keyId), retiresAt: retireAt.toISOString() };
}

/** What a revoke leaves behind, so a console can explain it. */
export interface NodeCredentialRevokeResult {
  revoked: number;
  /** The node's `nodeCredential.state` after the change. */
  state: 'active' | 'revoked';
  /** No ACTIVE key is left: the agent is refused with 401 NODE_CREDENTIAL_REVOKED until it is enrolled with a new token. */
  agentRefused: boolean;
  /** Always false: a node with keys, revoked or not, stays closed to the shared node secret. */
  sharedSecretAccepted: false;
  /** A reset to the shared secret is another way back (not in enforce mode). */
  resetAvailable: boolean;
  detail: string;
}

/** What a reset leaves behind. */
export interface NodeCredentialResetResult {
  removed: number;
  state: 'none';
  /** Always true: the node is accepted with the shared node secret again. */
  sharedSecretAccepted: true;
  /** While the upgrade window is open, an agent of 2.10.0 or later binds a new key by itself. */
  legacyUpgradeOpen: boolean;
  detail: string;
}

/** Free text an administrator gives for a revoke or reset; recorded in the audit event only. */
export const NODE_CREDENTIAL_REASON_MAX = 500;

export async function revokeNodeCredentials(nodeId: string, keyId: string | null, actorId: string, reason: string | null = null): Promise<NodeCredentialRevokeResult> {
  const node = await nodeCredentialStore.nodeById(nodeId);
  if (!node) throw new HttpError(404, 'NOT_FOUND', 'Node not found');
  const revoked = await nodeCredentialStore.revoke(nodeId, keyId, actorId, new Date());
  if (revoked === 0) throw new HttpError(404, 'NODE_CREDENTIAL_NOT_FOUND', 'No valid credential matches');
  const agentRefused = !(await nodeCredentialStore.credentialsOfNode(nodeId)).some(entry => entry.status === 'ACTIVE');
  const resetAvailable = nodeAuthMode() !== 'enforce';
  await logAuditEvent({ action: 'node.credential.revoke', actorId, targetType: 'node', targetId: nodeId,
    details: { revoked, ...(keyId ? { keyFingerprint: keyFingerprint(keyId), keyId } : { all: true }), agentRefused, ...(reason ? { reason } : {}) } });
  await notify(node, 'warning', `revoked:${Date.now()}`, `Node key of ${node.name} revoked`,
    `An administrator revoked ${keyId ? `the key ${keyFingerprint(keyId)}` : 'every key'} of ${node.name}. ${agentRefused
      ? 'Its agent is refused until it is enrolled with a new token.' : 'Its active key still works.'}`);
  return { revoked, state: agentRefused ? 'revoked' : 'active', agentRefused, sharedSecretAccepted: false, resetAvailable,
    detail: agentRefused
      ? `The agent of ${node.name} is refused (401 NODE_CREDENTIAL_REVOKED), and the node stays closed to the shared node secret. Issue an enrollment token and run \`magnus-agent enroll\` on the node${resetAvailable ? ', or reset its credentials to return it to the shared secret' : ''}.`
      : `${node.name} still has an active key, and its agent keeps working with it.` };
}

/** Rollback: forget the node's credentials so it is a shared-secret node again. Not available in enforce mode. */
export async function resetNodeCredentials(nodeId: string, actorId: string, reason: string | null = null): Promise<NodeCredentialResetResult> {
  if (nodeAuthMode() === 'enforce') throw new HttpError(409, 'NODE_AUTH_ENFORCED', 'Credentials cannot be reset to the shared secret while NODE_AUTH_MODE=enforce');
  const node = await nodeCredentialStore.nodeById(nodeId);
  if (!node) throw new HttpError(404, 'NOT_FOUND', 'Node not found');
  const removed = await nodeCredentialStore.reset(nodeId);
  const { open } = await legacyUpgradeWindow();
  await logAuditEvent({ action: 'node.credential.reset', actorId, targetType: 'node', targetId: nodeId,
    details: { removed, legacyUpgradeOpen: open, ...(reason ? { reason } : {}) } });
  await notify(node, 'warning', `reset:${Date.now()}`, `Node credentials of ${node.name} reset`,
    `An administrator removed the node keys of ${node.name}. It is accepted with the shared node secret again and may bind a new key while the upgrade window is open.`);
  return { removed, state: 'none', sharedSecretAccepted: true, legacyUpgradeOpen: open,
    detail: `${node.name} is accepted with the shared node secret again. ${open
      ? 'While the upgrade window is open, an agent of 2.10.0 or later binds a key again by itself; an older agent stays on the shared secret.'
      : 'The upgrade window is closed, so its agent does not bind a key again by itself: it stays on the shared secret until it is enrolled with a token.'}` };
}

const PENDING_BINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PendingBindingView {
  id: string; nodeId: string; nodeName: string | null; keyId: string; keyFingerprint: string; fqdn: string; peerAddress: string; recordedAddress: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED'; attempts: number; createdAt: string; lastSeenAt: string;
  decidedAt: string | null; decidedBy: string | null; decisionReason: string | null;
}

function pendingView(row: PendingBindingRow, names: Map<string, string>, now = Date.now()): PendingBindingView {
  const expired = row.status === 'PENDING' && now - row.lastSeenAt.getTime() > PENDING_BINDING_TTL_MS;
  return { id: row.id, nodeId: row.nodeId, nodeName: names.get(row.nodeId) ?? null, keyId: row.keyId, keyFingerprint: keyFingerprint(row.keyId),
    fqdn: row.fqdn, peerAddress: row.peerAddress, recordedAddress: row.recordedAddress, status: expired ? 'EXPIRED' : row.status, attempts: row.attempts,
    createdAt: row.createdAt.toISOString(), lastSeenAt: row.lastSeenAt.toISOString(), decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedBy: row.decidedBy, decisionReason: row.decisionReason };
}

/** Pending, approved and rejected requests (newest first, at most 200). */
export async function listPendingBindings(filter: { status?: 'PENDING' | 'APPROVED' | 'REJECTED'; nodeId?: string } = {}): Promise<PendingBindingView[]> {
  const rows = await nodeCredentialStore.pendingBindings(filter);
  const names = new Map<string, string>();
  for (const nodeId of new Set(rows.map(row => row.nodeId))) {
    const node = await nodeCredentialStore.nodeById(nodeId);
    if (node) names.set(nodeId, node.name);
  }
  return rows.map(row => pendingView(row, names));
}

/**
 * Approve a binding refused for its address: the key becomes the node's first credential, exactly as
 * if the automatic upgrade had accepted it, and the agent learns it on its next attempt. Refused when
 * the node has a key by now, when the request is older than seven days, or in enforce mode.
 */
export async function approvePendingBinding(id: string, actorId: string): Promise<PendingBindingView> {
  if (nodeAuthMode() === 'enforce') throw new HttpError(409, 'NODE_AUTH_ENFORCED', 'Pending bindings cannot be approved while NODE_AUTH_MODE=enforce; enroll the node with a token');
  const current = await nodeCredentialStore.pendingBinding(id);
  if (!current) throw new HttpError(404, 'NOT_FOUND', 'Pending binding not found');
  if (current.status === 'PENDING' && Date.now() - current.lastSeenAt.getTime() > PENDING_BINDING_TTL_MS)
    throw new HttpError(410, 'PENDING_BINDING_EXPIRED', 'The agent has not asked for this binding for seven days; enroll the node with a token');
  const node = await nodeCredentialStore.nodeById(current.nodeId);
  const result = await nodeCredentialStore.approvePendingBinding(id, actorId, new Date());
  if (result.outcome === 'not-pending') throw new HttpError(409, 'PENDING_BINDING_DECIDED', 'This request was already approved or rejected');
  if (result.outcome === 'exists') throw new HttpError(409, 'NODE_CREDENTIAL_EXISTS', 'The node has a credential by now; revoke or reset it first');
  if (result.outcome === 'key-in-use') throw new HttpError(409, 'NODE_KEY_IN_USE', 'This key is already bound to another node');
  await logAuditEvent({ action: 'node.credential.binding_approve', actorId, targetType: 'node', targetId: current.nodeId,
    details: { pendingBindingId: id, keyFingerprint: keyFingerprint(current.keyId), keyId: current.keyId, peerAddress: current.peerAddress } });
  await logAuditEvent({ action: 'node.credential.bind', actorId, targetType: 'node', targetId: current.nodeId,
    details: { origin: 'LEGACY_UPGRADE', approvedPendingBinding: id, keyFingerprint: keyFingerprint(current.keyId), keyId: current.keyId, fqdn: current.fqdn,
      peerAddress: current.peerAddress } });
  if (node) await notify(node, 'info', `bound:${current.keyId.slice(0, 16)}`, `${node.name} now has its own node key`,
    `An administrator approved the key ${keyFingerprint(current.keyId)} that ${node.name} asked to bind from ${current.peerAddress}. The shared node secret can no longer speak for this node.`,
    { origin: 'LEGACY_UPGRADE', keyFingerprint: keyFingerprint(current.keyId) });
  return pendingView(result.row!, new Map(node ? [[node.id, node.name]] : []));
}

export async function rejectPendingBinding(id: string, actorId: string, reason: string | null): Promise<PendingBindingView> {
  const row = await nodeCredentialStore.rejectPendingBinding(id, actorId, reason, new Date());
  if (!row) {
    if (!await nodeCredentialStore.pendingBinding(id)) throw new HttpError(404, 'NOT_FOUND', 'Pending binding not found');
    throw new HttpError(409, 'PENDING_BINDING_DECIDED', 'This request was already approved or rejected');
  }
  await logAuditEvent({ action: 'node.credential.binding_reject', actorId, targetType: 'node', targetId: row.nodeId,
    details: { pendingBindingId: id, keyFingerprint: keyFingerprint(row.keyId), peerAddress: row.peerAddress, ...(reason ? { reason } : {}) } });
  const node = await nodeCredentialStore.nodeById(row.nodeId);
  return pendingView(row, new Map(node ? [[node.id, node.name]] : []));
}

/** The first agent release that knows node keys. An older agent only has the shared node secret. */
export const NODE_CREDENTIALS_SINCE = '2.10.0';

export interface CredentialDowngradeCheck {
  nodeId: string;
  /** The agent version the operator wants to install. */
  to: string;
  /** Whether that version keeps the node key (and so stays accepted). */
  targetKnowsNodeKeys: boolean;
  /** The node has credential rows, so the shared secret is refused for it (the per-node ratchet). */
  nodeHasCredentials: boolean;
  /** `none`: install it. `reset-credentials`: reset first (or the node is refused until you do). `enroll-instead`: enforce mode, no reset exists. */
  action: 'none' | 'reset-credentials' | 'enroll-instead';
  resetPath: string | null;
  detail: string;
}

/**
 * Before installing an older agent on a node: an agent older than {@link NODE_CREDENTIALS_SINCE}
 * only has the shared secret, which the server refuses for a node that has a key. The answer names
 * the reset that has to come first (docs/NODE_CREDENTIALS.md, rollback). An agent of a release
 * that knows node keys keeps its key; the evidence ratchet follows its own heartbeats.
 */
export async function credentialDowngradeCheck(nodeId: string, to: string): Promise<CredentialDowngradeCheck> {
  if (!isVersion(to)) throw new HttpError(400, 'VALIDATION_ERROR', 'to must be a version such as 2.9.1');
  const node = await nodeCredentialStore.nodeById(nodeId);
  if (!node) throw new HttpError(404, 'NOT_FOUND', 'Node not found');
  const rows = await nodeCredentialStore.credentialsOfNode(nodeId);
  const targetKnowsNodeKeys = compareVersions(to, NODE_CREDENTIALS_SINCE) >= 0;
  const nodeHasCredentials = rows.length > 0;
  const base = { nodeId, to, targetKnowsNodeKeys, nodeHasCredentials };
  if (targetKnowsNodeKeys || !nodeHasCredentials)
    return { ...base, action: 'none', resetPath: null, detail: targetKnowsNodeKeys ? `magnus-agent ${to} keeps the node key` : 'The node has no key; it already uses the shared node secret' };
  if (nodeAuthMode() === 'enforce')
    return { ...base, action: 'enroll-instead', resetPath: null,
      detail: `magnus-agent ${to} only knows the shared node secret, which NODE_AUTH_MODE=enforce refuses; keep an agent of ${NODE_CREDENTIALS_SINCE} or later on ${node.name}` };
  return { ...base, action: 'reset-credentials', resetPath: `/api/v1/nodes/${encodeURIComponent(nodeId)}/credentials/reset`,
    detail: `magnus-agent ${to} only knows the shared node secret, which is refused for ${node.name} while it has a key. Reset its credentials first (POST the reset path), then install ${to}` };
}

export interface LegacyChannelUse { count: number; lastUsedAt: string }
export interface NodeLegacyUseView { request: LegacyChannelUse | null; evidence: LegacyChannelUse | null; outbound: LegacyChannelUse | null; lastUsedAt: string | null }

export function legacyUseView(rows: readonly LegacyUseRow[] | undefined): NodeLegacyUseView {
  const of = (channel: LegacyUseRow['channel']) => {
    const entry = rows?.find(item => item.channel === channel);
    return entry ? { count: entry.count, lastUsedAt: entry.lastUsedAt.toISOString() } : null;
  };
  const last = (rows ?? []).reduce<Date | null>((latest, entry) => !latest || entry.lastUsedAt > latest ? entry.lastUsedAt : latest, null);
  return { request: of('request'), evidence: of('evidence'), outbound: of('outbound'), lastUsedAt: last?.toISOString() ?? null };
}

export interface NodeCredentialView {
  /** none: shared secret only. active: has a valid key. revoked: its keys were revoked and it must re-enroll. */
  state: 'none' | 'active' | 'revoked';
  origin: string | null;
  boundAt: string | null;
  lastUsedAt: string | null;
  /** Key fingerprint (first 16 hex characters of the key id); ADMIN only. */
  keyFingerprint?: string | null;
  /** The node's agent signs its evidence with its active key (HMAC-only evidence for it is refused). */
  evidenceSigning: boolean;
  /** Recent use of the shared credentials for this node; null where the caller did not load it. */
  legacyUse: NodeLegacyUseView | null;
}

export function credentialView(rows: readonly CredentialRow[] | undefined, includeFingerprint: boolean, legacy?: readonly LegacyUseRow[]): NodeCredentialView {
  const active = rows?.find(entry => entry.status === 'ACTIVE');
  const shown = active ?? rows?.[0];
  return {
    state: active ? 'active' : rows && rows.length > 0 ? 'revoked' : 'none',
    origin: shown?.origin ?? null,
    boundAt: shown?.createdAt.toISOString() ?? null,
    lastUsedAt: shown?.lastUsedAt?.toISOString() ?? null,
    ...(includeFingerprint ? { keyFingerprint: shown ? keyFingerprint(shown.keyId) : null } : {}),
    evidenceSigning: active?.evidenceSigning === true,
    legacyUse: legacy === undefined ? null : legacyUseView(legacy),
  };
}

export function credentialDetail(entry: CredentialRow) {
  return { keyId: entry.keyId, keyFingerprint: keyFingerprint(entry.keyId), status: entry.status, origin: entry.origin, boundFqdn: entry.boundFqdn,
    evidenceSigning: entry.evidenceSigning, evidenceSigningAt: entry.evidenceSigningAt?.toISOString() ?? null,
    createdAt: entry.createdAt.toISOString(), lastUsedAt: entry.lastUsedAt?.toISOString() ?? null,
    retireAt: entry.retireAt?.toISOString() ?? null, revokedAt: entry.revokedAt?.toISOString() ?? null, revokedBy: entry.revokedBy };
}

/** For tests. */
export function resetNodeCredentialServiceState(): void {
  windowStartedAt = null;
  refusalAudits.clear();
}
