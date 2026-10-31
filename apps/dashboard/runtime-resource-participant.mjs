/** Dashboard managed SSH participant. Durable ownership lives in Control API Postgres. */
import { randomUUID, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { controlApiTlsOptions } from './runtime-hermes-security.mjs';

const PREFIX = '/api/v1/resource-leases/enrollment/dashboard';
const DOMAIN = 'magnus.resource-enrollment.v1\n';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const kinds = new Set(['terminal-http', 'terminal-ws', 'hermes-http', 'hermes-ws']);
export function canonicalDrainJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalDrainJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalDrainJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function secretFor(env) {
  const secret = env.RESOURCE_ENROLLMENT_DASHBOARD_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 ||
      ['API_SECRET', 'SESSION_SECRET', 'JWT_SECRET', 'NODE_MANAGER_SECRET', 'RESULT_SIGNING_SECRET', 'MAGNUS_SECRET', 'SECURITY_SENTI_BRIDGE_TOKEN', 'COMMAND_RECONCILIATION_SECRET', 'RESOURCE_PARTICIPANT_RECONCILIATION_SECRET', 'CREDENTIAL_ROTATION_KEY', 'AGENT_DISCOVERY_SECRET', 'RESOURCE_LEASE_RESULT_SECRET', 'RESOURCE_ENROLLMENT_NODE_SECRET', 'RESOURCE_LEASE_ADAPTER_SECRET'].some(k => env[k] && env[k] === secret))
    throw new Error('Dashboard resource participant credential is unavailable or not dedicated');
  return secret;
}
function fixedRequest(env, path, body) {
  const secret = secretFor(env);
  const base = new URL(env.CONTROL_API_URL ?? '');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new Error('Dashboard resource authority must use verified HTTPS');
  const url = new URL(`${base.pathname.replace(/\/+$/, '')}${PREFIX}${path}`, base.origin);
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { method: 'POST', ...controlApiTlsOptions(env), timeout: 5000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-resource-drain-key': secret } }, response => {
      let text = '';
      response.on('data', chunk => {
        text += chunk.toString();
        if (Buffer.byteLength(text) > 65536) request.destroy(new Error('Resource authority response exceeded limit'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('Resource authority denied managed SSH admission or settlement');
          const value = JSON.parse(text);
          if (value.success !== true || !value.data) throw new Error('Invalid resource authority response');
          resolve(value.data);
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Resource authority request timed out')));
    request.on('error', reject);
    request.end(data);
  });
}

export function createResourceParticipant({ env = process.env, request = (path, body) => fixedRequest(env, path, body), ownerId = randomUUID() } = {}) {
  if (!UUID.test(ownerId)) throw new Error('Invalid dashboard process incarnation');
  return {
    async begin(host, kind) {
      secretFor(env);
      if (typeof host !== 'string' || !host || host.length > 253 || !kinds.has(kind)) throw new Error('Invalid managed SSH target or kind');
      const workId = randomUUID();
      const deadline = Date.now() + 15 * 60_000;
      // This binds the complete admission descriptor. It deliberately labels
      // the effect as external/unrestricted, so it can never become node-
      // supervised terminal evidence merely because the transport closes.
      const operationSha256 = createHash('sha256').update(canonicalDrainJson({
        domain: 'magnus.dashboard-external-session.v1', host: host.toLowerCase(), workId, ownerId, kind,
        effectBoundary: 'external-unverified',
      })).digest('hex');
      const record = await request('/work/reserve', { host, workId, ownerId, kind, operationSha256, deadline });
      if (typeof record.nodeId !== 'string' || !record.nodeId || typeof record.nodeFqdn !== 'string' || !record.nodeFqdn || record.workId !== workId || record.participant !== 'dashboard' || record.ownerId !== ownerId || record.kind !== kind || record.state !== 'reserved' ||
          !Number.isSafeInteger(record.epoch) || record.epoch < 0 || !(record.barrierId === null || UUID.test(record.barrierId)) || !SHA.test(record.requestSha256) ||
          record.operationSha256 !== operationSha256 || !/^[1-9][0-9]{0,19}$/.test(record.fence) || record.deadline !== deadline)
        throw new Error('Invalid managed SSH reservation');
      // No local SSH side effect occurs until this second admission check succeeds.
      const admitted = await request(`/work/${workId}/start`, { ownerId, epoch: record.epoch, barrierId: record.barrierId,
        operationSha256, fence: record.fence, deadline, requestSha256: record.requestSha256 });
      if (admitted.workId !== workId || admitted.participant !== 'dashboard' || admitted.ownerId !== ownerId || admitted.kind !== kind || admitted.nodeId !== record.nodeId ||
          admitted.nodeFqdn !== record.nodeFqdn || admitted.epoch !== record.epoch || admitted.barrierId !== record.barrierId
          || admitted.operationSha256 !== operationSha256 || admitted.fence !== record.fence || admitted.deadline !== deadline
          || admitted.requestSha256 !== record.requestSha256 || admitted.state !== 'running')
        throw new Error('Managed SSH start was not acknowledged');
      let settlement;
      return {
        workId,
        finish(disposition = 'unknown', evidenceSha256 = createHash('sha256').update(canonicalDrainJson({ workId, ownerId, disposition, proof: 'transport-observation-only' })).digest('hex')) {
          if (!['not-started', 'remote-ended', 'unknown'].includes(disposition) || !SHA.test(evidenceSha256))
            return Promise.reject(new Error('Invalid managed SSH disposition'));
          // One immutable settlement per process handle. Ambiguous failures stay durable remotely.
          settlement ??= request(`/work/${workId}/finish`, { ownerId, disposition, evidenceSha256 });
          return settlement;
        },
      };
    },
    async drain(descriptor, suppliedKey) {
      const secret = secretFor(env);
      if (typeof suppliedKey !== 'string' || Buffer.byteLength(suppliedKey) !== Buffer.byteLength(secret) ||
          !timingSafeEqual(Buffer.from(suppliedKey), Buffer.from(secret))) throw new Error('Invalid drain authentication');
      const expectedKeys = ['version','participant','nodeId','nodeFqdn','epoch','barrierId','challengeId','expiresAt'].sort();
      if (!descriptor || Object.keys(descriptor).sort().join() !== expectedKeys.join() || descriptor.version !== 1 ||
          descriptor.participant !== 'dashboard' || typeof descriptor.nodeId !== 'string' || !descriptor.nodeId ||
          typeof descriptor.nodeFqdn !== 'string' || !descriptor.nodeFqdn || !Number.isSafeInteger(descriptor.epoch) ||
          !UUID.test(descriptor.barrierId) || !UUID.test(descriptor.challengeId) || !Number.isSafeInteger(descriptor.expiresAt) ||
          descriptor.expiresAt <= Date.now()) throw new Error('Invalid or expired drain challenge');
      const nonce = randomUUID();
      const snapshot = await request('/status', { nodeId: descriptor.nodeId, nonce });
      if (snapshot.version !== 1 || snapshot.nodeId !== descriptor.nodeId || snapshot.nodeFqdn !== descriptor.nodeFqdn ||
          snapshot.nonce !== nonce || snapshot.epoch !== descriptor.epoch || snapshot.barrierId !== descriptor.barrierId ||
          snapshot.challenge?.challengeId !== descriptor.challengeId || snapshot.challenge?.expiresAt !== descriptor.expiresAt ||
          descriptor.expiresAt <= Date.now() || snapshot.state !== 'draining' ||
          !Number.isSafeInteger(snapshot.activeCount) || snapshot.activeCount < 0 ||
          !Number.isSafeInteger(snapshot.unknownCount) || snapshot.unknownCount < 0 || !SHA.test(snapshot.evidenceSha256))
        throw new Error('Drain challenge did not match authoritative durable state');
      const receipt = { ...descriptor, status: snapshot.activeCount === 0 && snapshot.unknownCount === 0 ? 'drained' : 'pending',
        activeCount: snapshot.activeCount, unknownCount: snapshot.unknownCount, evidenceSha256: snapshot.evidenceSha256 };
      return { ...receipt, signature: createHmac('sha256', secret).update(DOMAIN + canonicalDrainJson(receipt)).digest('hex') };
    },
  };
}
const participant = createResourceParticipant();
export const beginManagedSshWork = (host, kind) => participant.begin(host, kind);
export const dashboardDrainReceipt = (descriptor, suppliedKey) => participant.drain(descriptor, suppliedKey);
export function observeManagedSshEnd(work, disposition = 'unknown') {
  void work.finish(disposition).catch(() => {
    // Do not include session content, credentials, or response bodies. Failure retains the durable reservation.
    console.error('Managed SSH settlement unacknowledged; resource drain remains blocked');
  });
}
