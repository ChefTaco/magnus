/**
 * How this agent gets and keeps its own node key (see docs/NODE_CREDENTIALS.md in the repository).
 *
 *   - An agent without a bound key asks the Control API to bind one, authenticated by the shared
 *     node secret (the legacy upgrade). It does so only after a heartbeat acknowledgement shows the
 *     server supports node credentials, and never while a self-upgrade is on trial: a version the
 *     launcher may still revert must not close the node to the shared secret.
 *   - `magnus-agent enroll --token` binds a key with a one-time token instead.
 *   - Nothing here needs an operator on the host; every failure is retried with a backoff.
 */
import { createHash } from 'node:crypto';
import { CONTROL_API_URL, HOST_FQDN, NODE_MANAGER_SECRET } from './env.js';
import { nodeApiFetch, nodeAuthNow, noteControlApiResponse, onControlApiStatus } from './node-auth.js';
import { boundNodeIdentity, ensureNodeKey, loadNodeIdentity, replaceNodeIdentity, saveNodeBinding, savePinnedServerKeys, saveServerEvidenceSupport, type NodeBinding,
  type PinnedServerKey } from './security/node-identity.js';
import { generateSigningKey, keyFingerprint, keyIdOfSpki, privateKeyFromPem, signEnrollmentProof } from './security/node-request-auth.js';
import { controlApiFetch } from './tls.js';
import { trialOf } from './upgrade/self-upgrade.js';
import { logger } from './utils/logger.js';
import { AGENT_VERSION } from './version.js';

const base = (): string => CONTROL_API_URL.replace(/\/+$/, '');
const fqdn = (): string => HOST_FQDN.trim().toLowerCase();

export interface HeartbeatNodeAuth { supported?: boolean | undefined; mode?: string | undefined; method?: string | undefined; problem?: string | undefined;
  /** 1: the server verifies evidence signed with the node key. */
  evidence?: number | undefined }
export type UpgradeOutcome =
  | { state: 'bound'; nodeId: string }
  | { state: 'retry'; reason: string; retryInMs: number };

const MINUTE = 60_000;
let nextAttemptAt = 0;
let failures = 0;
let inFlight = false;
let lastLogged = '';
let lastPinRefreshAt = 0;

function pinnedKeys(value: unknown): PinnedServerKey[] {
  if (!Array.isArray(value)) return [];
  const keys = value.flatMap((entry: { publicKey?: unknown; status?: unknown }) => {
    try { return typeof entry?.publicKey === 'string' ? [{ keyId: keyIdOfSpki(entry.publicKey), publicKey: entry.publicKey, active: entry.status !== 'next' }] : []; }
    catch { return []; }
  });
  // The key the server signs with, and the audience this agent signs for, goes first.
  return keys.sort((a, b) => Number(b.active) - Number(a.active)).slice(0, 4).map(({ keyId, publicKey }) => ({ keyId, publicKey }));
}

interface BindingReply { nodeId?: unknown; keyId?: unknown; serverKeys?: unknown }
async function readReply(response: Response): Promise<{ data?: BindingReply; error?: { code?: string; message?: string } }> {
  try {
    const text = await response.text();
    return text.length > 65_536 ? {} : JSON.parse(text) as { data?: BindingReply; error?: { code?: string; message?: string } };
  } catch { return {}; }
}

function bindingFrom(reply: BindingReply | undefined, keyId: string, origin: NodeBinding['origin']): NodeBinding | null {
  const serverKeys = pinnedKeys(reply?.serverKeys);
  if (typeof reply?.nodeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(reply.nodeId) || reply.keyId !== keyId || serverKeys.length === 0) return null;
  return { version: 1, nodeId: reply.nodeId, keyId, serverKeys, origin, boundAt: new Date().toISOString() };
}

function logOnce(level: 'info' | 'warn' | 'error', message: string): void {
  if (message === lastLogged) return;
  lastLogged = message;
  logger[level](message);
}

/** Ask the Control API to bind this node's key, authenticated by the shared node secret. */
export async function attemptLegacyUpgrade(): Promise<UpgradeOutcome> {
  let identity;
  try { identity = ensureNodeKey(); }
  catch (error) {
    logOnce('warn', `Node key could not be created or read (${error instanceof Error ? error.message : String(error)}); staying on the shared node secret`);
    return { state: 'retry', reason: 'KEY_UNAVAILABLE', retryInMs: 30 * MINUTE };
  }
  // The name exactly as heartbeats report it, so the server finds the same inventory node.
  const body = JSON.stringify({ fqdn: HOST_FQDN.trim(), publicKey: identity.publicKey,
    proof: signEnrollmentProof(identity.privateKey, { purpose: 'legacy-upgrade', publicKey: identity.publicKey, fqdn: fqdn(), binding: '-' }, nodeAuthNow()) });
  let response: Response;
  try {
    response = await controlApiFetch(`${base()}/api/v1/node-enrollment/legacy-upgrade`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'x-node-token': NODE_MANAGER_SECRET }, body });
  } catch (error) {
    return { state: 'retry', reason: `UNREACHABLE: ${error instanceof Error ? error.message : String(error)}`, retryInMs: Math.min(MINUTE * 2 ** failures, 30 * MINUTE) };
  }
  noteControlApiResponse(response);
  const reply = await readReply(response);
  const code = reply.error?.code ?? `HTTP_${response.status}`;
  if (response.status === 200) {
    const binding = bindingFrom(reply.data, identity.keyId, 'legacy-upgrade');
    if (!binding) return { state: 'retry', reason: 'INVALID_REPLY', retryInMs: 10 * MINUTE };
    saveNodeBinding(binding);
    logger.info(`Node key bound: this agent is node ${binding.nodeId} with key ${keyFingerprint(identity.keyId)}; pinned server key ${keyFingerprint(binding.serverKeys[0]!.keyId)}. Requests to the Control API are now signed.`);
    return { state: 'bound', nodeId: binding.nodeId };
  }
  if (response.status === 409) {
    logOnce('error', `Node key NOT bound (${code}): the Control API already holds a different key for this node, or this key for another node. `
      + 'If this host is the genuine node, an administrator must revoke or reset the node\'s credentials, or issue an enrollment token for `magnus-agent enroll --token`. Until then this agent is refused.');
    return { state: 'retry', reason: code, retryInMs: 60 * MINUTE };
  }
  if (response.status === 404) {
    // An older server has no such route; a newer one does not know this node yet (its first heartbeat adds it).
    logOnce('info', `Node key not bound yet (${code}); retrying later`);
    return { state: 'retry', reason: code, retryInMs: Math.min(5 * MINUTE * 2 ** failures, 60 * MINUTE) };
  }
  if (response.status === 403) {
    logOnce('warn', `Node key not bound (${code}): the Control API sees this agent at an address other than the one recorded for the node. An administrator can repair the node's address or issue an enrollment token.`);
    return { state: 'retry', reason: code, retryInMs: 60 * MINUTE };
  }
  if (response.status === 410) {
    logOnce('warn', `Node key not bound (${code}): the automatic upgrade of existing nodes is closed. An administrator must issue an enrollment token for \`magnus-agent enroll --token\`.`);
    return { state: 'retry', reason: code, retryInMs: 6 * 60 * MINUTE };
  }
  if (code === 'NODE_AUTH_SKEW') return { state: 'retry', reason: code, retryInMs: 30_000 };
  logOnce('warn', `Node key not bound (${code}); retrying later`);
  return { state: 'retry', reason: code, retryInMs: Math.min(MINUTE * 2 ** failures, 30 * MINUTE) };
}

/**
 * Drive the migration from heartbeat acknowledgements. `nodeAuth` is absent from a server older
 * than node credentials, which leaves this agent on the shared secret until the server is upgraded.
 */
export function onHeartbeatAcknowledged(nodeAuth: HeartbeatNodeAuth | undefined, now = Date.now()): void {
  // Sign evidence with the node key only for a server that verifies it; a server downgrade turns it off again.
  try { saveServerEvidenceSupport(nodeAuth?.evidence === 1); }
  catch (error) { logger.warn(`Could not record whether the server verifies node evidence: ${error instanceof Error ? error.message : String(error)}`); }
  if (!nodeAuth?.supported || inFlight || now < nextAttemptAt) return;
  let bound = false;
  try { bound = Boolean(loadNodeIdentity()?.binding); }
  catch { return; }
  // Bound and accepted by signature: nothing to do. Bound but the server does not know the key
  // (its records were restored, or the node was re-created): bind again with the same key.
  if (bound && !(nodeAuth.method === 'legacy' && nodeAuth.problem === 'UNKNOWN_KEY')) { failures = 0; return; }
  if (nodeAuth.mode === 'enforce' && !bound) return;
  if (trialOf(AGENT_VERSION) !== null) return;
  inFlight = true;
  void attemptLegacyUpgrade().then(outcome => {
    if (outcome.state === 'bound') { failures = 0; nextAttemptAt = 0; lastLogged = ''; return; }
    failures += 1;
    nextAttemptAt = Date.now() + outcome.retryInMs;
  }).catch((error: unknown) => {
    failures += 1;
    nextAttemptAt = Date.now() + 10 * MINUTE;
    logger.warn(`Node key binding failed: ${error instanceof Error ? error.message : String(error)}`);
  }).finally(() => { inFlight = false; });
}

/** Read the server keys again and pin them. Throttled; used when the server presents a key this agent does not know. */
export async function refreshPinnedServerKeys(minIntervalMs = MINUTE, now = Date.now()): Promise<boolean> {
  if (now - lastPinRefreshAt < minIntervalMs) return false;
  lastPinRefreshAt = now;
  try {
    const response = await controlApiFetch(`${base()}/api/v1/node-enrollment/server-key`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    noteControlApiResponse(response);
    if (response.status !== 200) return false;
    const keys = pinnedKeys(((await readReply(response)).data as { keys?: unknown } | undefined)?.keys);
    const current = loadNodeIdentity(0)?.binding;
    if (!current || keys.length === 0 || JSON.stringify(keys) === JSON.stringify(current.serverKeys)) return false;
    savePinnedServerKeys(keys);
    logger.warn(`Pinned server key changed: now ${keys.map(key => keyFingerprint(key.keyId)).join(', ')} (was ${current.serverKeys.map(key => keyFingerprint(key.keyId)).join(', ')})`);
    return true;
  } catch (error) {
    logger.debug(`Server keys could not be refreshed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Keep the pinned server keys current: once at start, and whenever the Control API refuses a
 * request (its key may have been replaced). Binding itself is driven by heartbeat acknowledgements.
 */
export function startNodeIdentityMaintenance(): void {
  onControlApiStatus(status => { if (status === 401 && boundNodeIdentity()) void refreshPinnedServerKeys(5 * MINUTE); });
  const identity = boundNodeIdentity();
  if (identity) {
    logger.info(`Node identity: node ${identity.binding.nodeId}, key ${keyFingerprint(identity.keyId)}`);
    void refreshPinnedServerKeys(0);
  } else logger.info('Node identity: none yet; using the shared node secret until the Control API binds a node key');
}

/** `magnus-agent enroll --token`: bind a new key with a one-time token from an administrator. */
export async function enrollWithToken(token: string): Promise<{ ok: true; nodeId: string; keyFingerprint: string; serverKeyFingerprint: string } | { ok: false; reason: string }> {
  if (!/^mne_[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, reason: 'the token is not an enrollment token (mne_...)' };
  // Always a new key: the token replaces whatever key the node had.
  const key = generateSigningKey();
  const privateKey = privateKeyFromPem(key.privateKeyPem);
  const body = JSON.stringify({ token, fqdn: fqdn(), publicKey: key.publicKey, proof: signEnrollmentProof(privateKey,
    { purpose: 'enroll', publicKey: key.publicKey, fqdn: fqdn(), binding: createHash('sha256').update(token).digest('hex') }) });
  const send = () => controlApiFetch(`${base()}/api/v1/node-enrollment/enroll`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json' }, body });
  let response: Response;
  try { response = await send(); }
  catch (error) { return { ok: false, reason: `the Control API is unreachable: ${error instanceof Error ? error.message : String(error)}` }; }
  const reply = await readReply(response);
  if (response.status !== 200) return { ok: false, reason: `${reply.error?.code ?? `HTTP ${response.status}`}: ${reply.error?.message ?? 'enrollment refused'}` };
  const binding = bindingFrom(reply.data, key.keyId, 'enrollment-token');
  if (!binding) return { ok: false, reason: 'the Control API reply is not a valid binding' };
  replaceNodeIdentity(key.privateKeyPem, binding);
  return { ok: true, nodeId: binding.nodeId, keyFingerprint: keyFingerprint(key.keyId), serverKeyFingerprint: keyFingerprint(binding.serverKeys[0]!.keyId) };
}

/** `magnus-agent identity rotate`: replace the bound key, signed with the key it replaces. */
export async function rotateNodeKey(): Promise<{ ok: true; keyFingerprint: string; retiresAt: string } | { ok: false; reason: string }> {
  const current = loadNodeIdentity(0);
  if (!current?.binding) return { ok: false, reason: 'this agent has no bound node key to rotate' };
  const key = generateSigningKey();
  const body = JSON.stringify({ fqdn: fqdn(), publicKey: key.publicKey, proof: signEnrollmentProof(privateKeyFromPem(key.privateKeyPem),
    { purpose: 'rotate', publicKey: key.publicKey, fqdn: fqdn(), binding: current.binding.nodeId }) });
  let response: Response;
  try {
    response = await nodeApiFetch(`${base()}/api/v1/node-enrollment/rotate`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json' }, body });
  } catch (error) { return { ok: false, reason: `the Control API is unreachable: ${error instanceof Error ? error.message : String(error)}` }; }
  const reply = await readReply(response);
  if (response.status !== 200) return { ok: false, reason: `${reply.error?.code ?? `HTTP ${response.status}`}: ${reply.error?.message ?? 'rotation refused'}` };
  const binding = bindingFrom(reply.data, key.keyId, 'rotation');
  if (!binding || binding.nodeId !== current.binding.nodeId) return { ok: false, reason: 'the Control API reply is not a valid binding' };
  replaceNodeIdentity(key.privateKeyPem, binding);
  return { ok: true, keyFingerprint: keyFingerprint(key.keyId), retiresAt: String((reply.data as { retiresAt?: unknown }).retiresAt ?? '') };
}

/** What `magnus-agent identity show` prints. Fingerprints only. */
export function describeNodeIdentity(): { state: 'none' | 'unbound' | 'bound'; nodeId?: string; keyFingerprint?: string; keyId?: string; origin?: string; boundAt?: string; serverKeyFingerprints?: string[] } {
  const identity = loadNodeIdentity(0);
  if (!identity) return { state: 'none' };
  if (!identity.binding) return { state: 'unbound', keyFingerprint: keyFingerprint(identity.keyId), keyId: identity.keyId };
  return { state: 'bound', nodeId: identity.binding.nodeId, keyFingerprint: keyFingerprint(identity.keyId), keyId: identity.keyId,
    origin: identity.binding.origin, boundAt: identity.binding.boundAt, serverKeyFingerprints: identity.binding.serverKeys.map(key => keyFingerprint(key.keyId)) };
}

/** For tests. */
export function resetNodeEnrollmentState(): void {
  nextAttemptAt = 0; failures = 0; inFlight = false; lastLogged = ''; lastPinRefreshAt = 0;
}
