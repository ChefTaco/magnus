/**
 * Per-node credentials: binding a node's first key (enrollment token or the legacy upgrade),
 * rotation, revocation, and the rule that closes a node to the shared secret once it has a key.
 * See docs/NODE_CREDENTIALS.md.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { HttpError } from '../middleware/error-handler.js';
import { keyFingerprint, keyIdOfSpki, NonceCache, verifyEnrollmentProof, type EnrollmentPurpose } from '../security/node-request-auth.js';
import { isLoopbackOrUnroutableIp, normalizeIpAddress } from '../utils/ip.js';
import { logAuditEvent } from './audit-service.js';
import { ENROLLMENT_TOKEN_DEFAULT_TTL_SECONDS, ENROLLMENT_TOKEN_MAX_TTL_SECONDS, legacyUpgradeDeadline, nodeAuthMode,
  ROTATION_GRACE_MS } from './node-auth-config.js';
import { nodeCredentialStore, type CredentialNode, type CredentialRow } from './node-credential-store.js';
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
/** Audit a refusal at most once an hour per node and reason: a retrying agent must not flood the chain. */
async function auditRefusal(action: 'node.credential.bind_refused' | 'node.credential.identity_mismatch', node: { id: string; name: string } | null,
  reason: string, details: Record<string, unknown>, now = Date.now()): Promise<boolean> {
  const id = `${action}:${node?.id ?? '-'}:${reason}`;
  if ((refusalAudits.get(id) ?? 0) > now - 60 * 60 * 1000) return false;
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
export async function legacyUpgrade(input: { fqdn: string; publicKey: string; proof: EnrollmentProof; peerAddress: string }): Promise<BindingResult> {
  const window = await legacyUpgradeWindow();
  if (!window.open) throw new HttpError(410, 'LEGACY_UPGRADE_CLOSED', `The automatic upgrade of existing nodes closed on ${window.until}; enroll this node with a token`);
  const fqdn = normalizedFqdn(input.fqdn);
  const keyId = proofOrRefuse('legacy-upgrade', input.publicKey, fqdn, '-', input.proof);
  const node = await resolveUpgradeNode(input.fqdn, input.peerAddress);
  const peer = normalizeIpAddress(input.peerAddress);
  if (!await peerMatchesNode(peer, node.ipAddress)) {
    if (await auditRefusal('node.credential.bind_refused', node, 'PEER_ADDRESS_MISMATCH', { peerAddress: peer, recordedAddress: node.ipAddress,
      keyFingerprint: keyFingerprint(keyId) }))
      await notify(node, 'warning', 'bind-refused-peer', `${node.name} could not bind its node key`,
        `An agent reporting ${fqdn} asked to bind a key from ${peer || 'an unknown address'}, but ${node.name} is recorded at ${node.ipAddress}. Repair the node's address if this is the same host, or enroll it with a token.`,
        { peerAddress: peer });
    throw new HttpError(403, 'PEER_ADDRESS_MISMATCH', 'The caller address is not the address recorded for this node');
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

export async function revokeNodeCredentials(nodeId: string, keyId: string | null, actorId: string): Promise<{ revoked: number }> {
  const node = await nodeCredentialStore.nodeById(nodeId);
  if (!node) throw new HttpError(404, 'NOT_FOUND', 'Node not found');
  const revoked = await nodeCredentialStore.revoke(nodeId, keyId, actorId, new Date());
  if (revoked === 0) throw new HttpError(404, 'NODE_CREDENTIAL_NOT_FOUND', 'No valid credential matches');
  await logAuditEvent({ action: 'node.credential.revoke', actorId, targetType: 'node', targetId: nodeId,
    details: { revoked, ...(keyId ? { keyFingerprint: keyFingerprint(keyId), keyId } : { all: true }) } });
  await notify(node, 'warning', `revoked:${Date.now()}`, `Node key of ${node.name} revoked`,
    `An administrator revoked ${keyId ? `the key ${keyFingerprint(keyId)}` : 'every key'} of ${node.name}. Its agent is refused until it is enrolled with a new token.`);
  return { revoked };
}

/** Rollback: forget the node's credentials so it is a shared-secret node again. Not available in enforce mode. */
export async function resetNodeCredentials(nodeId: string, actorId: string): Promise<{ removed: number }> {
  if (nodeAuthMode() === 'enforce') throw new HttpError(409, 'NODE_AUTH_ENFORCED', 'Credentials cannot be reset to the shared secret while NODE_AUTH_MODE=enforce');
  const node = await nodeCredentialStore.nodeById(nodeId);
  if (!node) throw new HttpError(404, 'NOT_FOUND', 'Node not found');
  const removed = await nodeCredentialStore.reset(nodeId);
  await logAuditEvent({ action: 'node.credential.reset', actorId, targetType: 'node', targetId: nodeId, details: { removed } });
  await notify(node, 'warning', `reset:${Date.now()}`, `Node credentials of ${node.name} reset`,
    `An administrator removed the node keys of ${node.name}. It is accepted with the shared node secret again and may bind a new key while the upgrade window is open.`);
  return { removed };
}

export interface NodeCredentialView {
  /** none: shared secret only. active: has a valid key. revoked: its keys were revoked and it must re-enroll. */
  state: 'none' | 'active' | 'revoked';
  origin: string | null;
  boundAt: string | null;
  lastUsedAt: string | null;
  /** Key fingerprint (first 16 hex characters of the key id); ADMIN only. */
  keyFingerprint?: string | null;
}

export function credentialView(rows: readonly CredentialRow[] | undefined, includeFingerprint: boolean): NodeCredentialView {
  const active = rows?.find(entry => entry.status === 'ACTIVE');
  const shown = active ?? rows?.[0];
  return {
    state: active ? 'active' : rows && rows.length > 0 ? 'revoked' : 'none',
    origin: shown?.origin ?? null,
    boundAt: shown?.createdAt.toISOString() ?? null,
    lastUsedAt: shown?.lastUsedAt?.toISOString() ?? null,
    ...(includeFingerprint ? { keyFingerprint: shown ? keyFingerprint(shown.keyId) : null } : {}),
  };
}

export function credentialDetail(entry: CredentialRow) {
  return { keyId: entry.keyId, keyFingerprint: keyFingerprint(entry.keyId), status: entry.status, origin: entry.origin, boundFqdn: entry.boundFqdn,
    createdAt: entry.createdAt.toISOString(), lastUsedAt: entry.lastUsedAt?.toISOString() ?? null,
    retireAt: entry.retireAt?.toISOString() ?? null, revokedAt: entry.revokedAt?.toISOString() ?? null, revokedBy: entry.revokedBy };
}

/** For tests. */
export function resetNodeCredentialServiceState(): void {
  windowStartedAt = null;
  refusalAudits.clear();
}
