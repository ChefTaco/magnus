/** One node execution slot for reviewed synchronous native mutations and commands. */
import { randomUUID } from 'node:crypto';
import type { Hono, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { CONTROL_API_URL, HOST_FQDN, NODE_MANAGER_SECRET, RESULT_SIGNING_SECRET, MAGNUS_EXECUTION_SUPERVISOR_ENABLED } from '../env.js';
import { controlApiFetch } from '../tls.js';
import { commandLedger, executeBodySchema } from './command-executor.js';
import { commandFenceSchema, commandRequestDigest, isArdentScopedCommand, type CommandIdentity } from './command-ledger.js';
import { managedExecution } from '../security/managed-context.js';
import { legacyAdmissionResponseSchema, managedClaimSchema, MANAGED_CLAIM_HEADER, httpIdentity, httpReceiptBody, type ManagedClaim } from '../security/managed-http.js';
import { nativeCompletionDescriptor, nativeCompletionResourceKey } from '../security/native-completion-registry.js';
import { signCommandResult } from '../security/command-result-signature.js';
import { mutationBarrier, type MutationToken } from './mutation-barrier.js';
import { recoverSkillPublication } from './skill-publication.js';

export const managedHttpRequestSchema = z.object({ claim: managedClaimSchema, commandId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']), path: z.string().min(1).max(300),
  body: z.string().max(4 * 1024 * 1024), timeoutSeconds: z.number().int().min(1).max(3600), coordination: commandFenceSchema,
  recoveryOnly: z.literal(true).optional(),
}).strict().superRefine((value, context) => {
  if (value.recoveryOnly && (value.method !== 'POST' || value.path !== '/skills/install'))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['recoveryOnly'], message: 'Recovery-only is limited to POST /skills/install' });
});
let activeLegacy = 0;
let enrolling = false;
async function confirmAt(claim: ManagedClaim, input: CommandIdentity, endpoint: 'claim' | 'recovery-claim'): Promise<void> {
  if (claim.nodeFqdn !== HOST_FQDN || (input.coordination?.resourceKey !== `node:${claim.nodeId}`
    && !isArdentScopedCommand(input, claim.nodeId)))
    throw new Error('Resource claim target differs from this node');
  const value = { ...claim, commandId: input.commandId, requestSha256: commandRequestDigest(input), coordination: input.coordination };
  const response = await controlApiFetch(`${CONTROL_API_URL.replace(/\/+$/, '')}/api/v1/resource-leases/${endpoint}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', 'x-node-token': NODE_MANAGER_SECRET }, body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error('Root authority did not confirm the exact resource owner');
  const reply = await response.json() as { success?: boolean; data?: Record<string, unknown> };
  if (reply.success !== true || reply.data?.['admitted'] !== true || Object.keys(value).some(k => JSON.stringify(reply.data?.[k]) !== JSON.stringify(value[k as keyof typeof value])))
    throw new Error('Root resource receipt binding differs');
}
const confirm = (claim: ManagedClaim, input: CommandIdentity) => confirmAt(claim, input, 'claim');
const confirmRecovery = (claim: ManagedClaim, input: CommandIdentity) => confirmAt(claim, input, 'recovery-claim');

async function legacyAdmission() {
  const request = { nodeFqdn: HOST_FQDN, nonce: randomUUID() };
  const response = await controlApiFetch(`${CONTROL_API_URL.replace(/\/+$/, '')}/api/v1/resource-leases/legacy-admission`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', 'x-node-token': NODE_MANAGER_SECRET, 'cache-control': 'no-store' }, body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error('Enrollment authority unavailable');
  const envelope = await response.json() as { success?: boolean; data?: unknown };
  const decision = legacyAdmissionResponseSchema.parse(envelope.data);
  if (envelope.success !== true || decision.nonce !== request.nonce || decision.nodeFqdn !== request.nodeFqdn
    || decision.allowedLegacy !== (!decision.enrolled && !decision.gateEnabled)) throw new Error('Enrollment authority binding differs');
  return decision;
}

/** Mounted after native auth, before every mutation route. Enrollment is sticky. */
export const managedMutationGuard: MiddlewareHandler = async (c, next) => {
  const path = c.req.path.replace(/^\/api\/v1/, '');
  // Hermes state accepts a caller-selected executable and launches inspection subprocesses.
  const executionBearingRead = path === '/hermes/state';
  if ((!executionBearingRead && ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) || managedExecution.getStore()) return next();
  if (path === '/commands/managed-http' || path === '/commands/enrollment-drain' || path === '/cron/enrollment-drain'
    || path === '/cron/source-reconciliation' || path === '/cron/enrollment-stage'
    || /^\/commands\/receipts\/[a-zA-Z0-9._-]+\/reconcile$/.test(path)) return next();
  const encoded = c.req.header(MANAGED_CLAIM_HEADER);
  if (path === '/commands/execute' && encoded) {
    if (activeLegacy || enrolling) return c.json({ success: false, error: { code: 'RESOURCE_BUSY' } }, 409);
    enrolling = true;
    try {
      const claim = managedClaimSchema.parse(JSON.parse(encoded));
      const input = await c.req.json<CommandIdentity>();
      await confirm(claim, input);
      return await managedExecution.run({ claim, commandId: input.commandId, requestSha256: commandRequestDigest(input),
        ...(input.coordination ? { coordination: input.coordination } : {}), signal: c.req.raw.signal }, () => next());
    } catch { return c.json({ success: false, error: { code: 'RESOURCE_CLAIM_INVALID', message: 'A current authoritative resource claim is required' } }, 409); }
    finally { enrolling = false; }
  }
  if (enrolling) return c.json({ success: false, error: { code: 'RESOURCE_BUSY' } }, 409);
  // Increment before awaiting authority: an already-admitted legacy handler must
  // drain before a managed claim can cross the node execution boundary.
  activeLegacy++;
  let token: MutationToken | undefined;
  let dispatched = false;
  let completed = false;
  try {
    const command = path === '/commands/execute' && c.req.method === 'POST'
      ? executeBodySchema.safeParse(await c.req.json().catch(() => null)) : undefined;
    token = await mutationBarrier.begin(c.req.method, path, command?.success ? command.data : undefined);
    if (command && !command.success) return c.json({ success: false, error: { code: 'VALIDATION_ERROR',
      message: command.error.issues.map(error => error.message).join('; ') } }, 400);
    if (await commandLedger.managedEnrollment()) return c.json({ success: false,
      error: { code: 'UNMANAGED_MUTATION', message: 'Enrolled node requires the reviewed managed mutation boundary' } }, 409);
    const decision = await legacyAdmission();
    if (decision.enrolled) await commandLedger.observeManagedEnrollment({ nodeId: decision.nodeId, nodeFqdn: decision.nodeFqdn });
    if (!decision.allowedLegacy) return c.json({ success: false,
      error: { code: 'UNMANAGED_MUTATION', message: 'Authoritative enrollment requires managed mutation admission' } }, 409);
    dispatched = true;
    await next();
    // Generic HTTP success cannot prove detached/background work stopped.
    // Only the reviewed synchronous handlers have a known completion boundary.
    completed = nativeCompletionDescriptor(c.req.method, path)?.completionMode === 'buffered-synchronous-http' && c.res.status < 500
      && c.res.status !== 202 && !(c.res.status >= 300 && c.res.status < 400);
    if (path === '/commands/execute' && c.req.method === 'POST' && c.res.status === 200
      && MAGNUS_EXECUTION_SUPERVISOR_ENABLED) completed = true;
  } catch { return c.json({ success: false,
    error: dispatched
      ? { code: 'MUTATION_OUTCOME_UNKNOWN', message: 'Mutation outcome is uncertain; reconcile before retrying' }
      : { code: 'ENROLLMENT_AUTHORITY_UNAVAILABLE', message: 'Legacy mutation admission could not be verified' } }, 409); }
  finally {
    try { if (token) await mutationBarrier.finish(token, !dispatched || completed ? 'completed' : 'unknown'); }
    finally { activeLegacy--; }
  }

};

export function registerManagedHttp(app: Hono): void {
  app.post('/api/v1/commands/managed-http', async c => {
    const parsed = managedHttpRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ success: false, error: { code: 'INVALID_MANAGED_MUTATION' } }, 400);
    const value = parsed.data;
    if (value.recoveryOnly && (value.method !== 'POST' || value.path !== '/skills/install'))
      return c.json({ success: false, error: { code: 'INVALID_RECOVERY_ONLY',
        message: 'Recovery-only execution is limited to exact skill publication evidence' } }, 409);
    const descriptor = nativeCompletionDescriptor(value.method, value.path);
    if (!descriptor) return c.json({ success: false,
      error: { code: 'UNREVIEWED_MUTATION', message: 'This mutation needs a separately reviewed completion boundary' } }, 409);
    if (value.timeoutSeconds > descriptor.timeoutCeilingSeconds
      || value.coordination.resourceKey !== nativeCompletionResourceKey(descriptor, value.claim.nodeId))
      return c.json({ success: false, error: { code: 'UNREVIEWED_MUTATION',
        message: 'Native mutation exceeds its reviewed completion or resource boundary' } }, 409);
    if (activeLegacy || enrolling) return c.json({ success: false, error: { code: 'RESOURCE_BUSY' } }, 409);
    enrolling = true;
    try {
      const identity = { ...httpIdentity(value.commandId, value.method, value.path, value.body, value.timeoutSeconds), coordination: value.coordination };
      const digest = commandRequestDigest(identity);
      const prior = await commandLedger.receipt(value.commandId);
      if (value.recoveryOnly) {
        if (prior && (prior.requestSha256 !== digest || !['unknown', 'completed'].includes(prior.state)))
          throw new Error('Local recovery receipt differs or remains active');
        await confirmRecovery(value.claim, identity);
        const recovered = await recoverSkillPublication(JSON.parse(value.body), { claim: value.claim,
          commandId: value.commandId, requestSha256: digest, coordination: value.coordination },
        process.env['SKILLS_DIR'] ?? '/opt/magnus-agent/skills');
        const unsigned = { commandId: value.commandId, exitCode: recovered.status >= 200 && recovered.status < 300 ? 0 : 1,
          stdout: httpReceiptBody(value.method, value.path, recovered.status, recovered.body), stderr: '', durationMs: 0,
          truncated: false, coordination: { ...value.coordination, requestSha256: digest } };
        if (prior?.state === 'completed') {
          if (prior.result?.stdout !== unsigned.stdout || prior.result.exitCode !== unsigned.exitCode)
            throw new Error('Retained skill publication response differs from its signed receipt');
          return c.json({ success: true, data: { response: recovered, receipt: prior.result } });
        }
        const signed = { ...unsigned, signature: signCommandResult(unsigned, RESULT_SIGNING_SECRET) };
        const adopted = await commandLedger.settleRecoveredResult(identity, signed, value.claim);
        return c.json({ success: true, data: { response: recovered, receipt: adopted.result } });
      }
      await confirm(value.claim, identity);
      let response: { status: number; body: string } | undefined;
      const receipt = await commandLedger.execute(identity, async digest => {
        const start = Date.now();
        // Durable fence/enrollment/receipt writes may outlast the authority
        // deadline. Check at the actual handler boundary, after those writes.
        // A signed no-dispatch failure can settle this slot without replay.
        let result: Response;
        if (value.coordination.expiresAt <= Date.now()) {
          if (value.method === 'POST' && value.path === '/skills/install') {
            const recovered = await recoverSkillPublication(JSON.parse(value.body), { claim: value.claim,
              commandId: value.commandId, requestSha256: digest, coordination: value.coordination },
            process.env['SKILLS_DIR'] ?? '/opt/magnus-agent/skills');
            result = new Response(recovered.body, { status: recovered.status, headers: { 'content-type': 'application/json' } });
          } else result = new Response(JSON.stringify({ success: false, error: {
            code: 'LEASE_EXPIRED', message: 'Native mutation lease expired before handler start; no handler executed',
          } }), { status: 409, headers: { 'content-type': 'application/json' } });
        } else result = await managedExecution.run({ claim: value.claim, commandId: value.commandId, requestSha256: digest,
            coordination: value.coordination, signal: c.req.raw.signal }, () => app.request(`http://localhost/api/v1${value.path}`, {
          method: value.method, headers: { 'content-type': 'application/json', 'x-node-token': NODE_MANAGER_SECRET },
          signal: c.req.raw.signal,
          ...(value.body ? { body: value.body } : {}),
        }));
        // A backend acceptance, redirect, unbounded stream, or thrown callback does
        // not prove completion. Keep the ledger's durable uncertain owner.
        if (result.status >= 500 || result.status === 202 || result.status >= 300 && result.status < 400) throw new Error('Unsettled asynchronous mutation');
        const reader = result.body?.getReader();
        const chunks: Uint8Array[] = []; let bytes = 0;
        if (reader) {
          try {
            for (;;) { const chunk = await reader.read(); if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('Unbounded mutation response'); }
              chunks.push(chunk.value);
            }
          } finally { reader.releaseLock(); }
        }
        const text = Buffer.concat(chunks).toString('utf8');
        response = { status: result.status, body: text };
        const signed = { commandId: value.commandId, exitCode: result.ok ? 0 : 1,
          stdout: httpReceiptBody(value.method, value.path, result.status, text), stderr: '',
          durationMs: Date.now() - start, truncated: false,
          coordination: { ...value.coordination, requestSha256: digest } };
        return { ...signed, signature: signCommandResult(signed, RESULT_SIGNING_SECRET) };
      }, value.claim);
      if (!response) return c.json({ success: false, error: { code: 'RESULT_ALREADY_RECORDED', message: 'Read the existing signed receipt without replay' } }, 409);
      return c.json({ success: true, data: { response, receipt } });
    } catch { return c.json({ success: false, error: { code: 'MANAGED_MUTATION_UNCERTAIN', message: 'Inspect the exact resource receipt before further work; no automatic replay' } }, 409); }
    finally { enrolling = false; }
  });
}
