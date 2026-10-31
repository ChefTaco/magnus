import { createHash, randomUUID } from 'node:crypto';
import { MANAGED_CLAIM_HEADER, httpIdentity, httpReceiptBody, managedHttpRequestSchema } from '../security/managed-http.js';
import { nativeCompletionDescriptor, nativeCompletionResourceKey } from '../security/native-completion-registry.js';
import { COMMAND_COMPLETION_REGISTRY, COMMAND_COMPLETION_REGISTRY_SHA256, commandCompletionDescriptor } from '../security/command-completion-registry.js';
import { commandReconciliationSchema } from '../schemas/command-reconciliation.js';
import { admitResourceCommand, markResourceDispatched, failResourceCommand, settleResourceResult, settleResourceReconciliation, type ResourceCommandContext } from '../services/command-resource-leases.js';
import { commandFenceSchema, commandResultSchema } from '../schemas/node-responses.js';
import type { CronEnrollmentStage, ManagedCronIdentity, ManagedCronSpec, SchedulerSourceSettlement } from '../schemas/managed-cron.js';
import { commandRequestDigest, type CommandRequest } from '../security/command-request.js';
import ky, { type AfterResponseState, type KyInstance } from 'ky';
import { HttpError } from '../middleware/error-handler.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ArdentNodeState } from '@hivemagnus/magnus-contracts';
import type {
  ApiResponse,
  HealthSnapshot,
  CommandResult,
  CronJobSpec,
  CronJobCreateRequest,
  CronJobUpdateRequest,
  FileReadResponse,
  SkillInstallation,
  DiscoveredSkill,
  HermesNodeState,
  HermesManagedConfiguration,
  CodexNodeState,
  CodexDeviceAuthSession,
  SystemUpdateInfo,
} from '../types/index.js';
import { RESULT_SIGNING_PREVIOUS_SECRET, RESULT_SIGNING_SECRET } from '../utils/env.js';
import { correlateSkillPublicationNoEffect } from '../services/skill-publication-settlement.js';
import {
  commandResultSigningPayload,
  type SignedCommandResult,
  verifyCommandResultSignature,
} from '../security/command-result-signature.js';

/** Wire format shared with the node ledger; cross-wire tests guard canonicalization. */
export { commandReconciliationSchema } from '../schemas/command-reconciliation.js';
export type CommandReconciliationAssertion = z.infer<typeof commandReconciliationSchema>;
export interface ExpectedCommandReceipt { nodeFqdn: string; requestSha256: string }
export type CommandReceipt = { commandId: string; requestSha256: string } & (
  { state: 'running' | 'unknown'; result?: never; reconciliation?: never }
  | { state: 'completed'; result: SignedCommandResult; reconciliation?: never }
  | { state: 'reconciled'; result?: never; reconciliation: CommandReconciliationAssertion }
);
export function commandReconciliationSigningPayload(assertion: Omit<CommandReconciliationAssertion, 'signature'>): string {
  return JSON.stringify({ domain: 'magnus.command-reconciliation.v1', nodeFqdn: assertion.nodeFqdn,
    commandId: assertion.commandId, requestSha256: assertion.requestSha256,
    coordination: assertion.coordination ? { version: assertion.coordination.version,
      resourceKey: assertion.coordination.resourceKey, fence: assertion.coordination.fence,
      expiresAt: assertion.coordination.expiresAt } : null,
    disposition: assertion.disposition, evidenceSha256: assertion.evidenceSha256,
    approvalRef: assertion.approvalRef, decisionId: assertion.decisionId, expiresAt: assertion.expiresAt });
}
function verifiedReconciliation(raw: unknown, commandId: string, expected: ExpectedCommandReceipt | undefined, fresh: boolean, nodeToken: string): CommandReconciliationAssertion {
  const assertion = commandReconciliationSchema.parse(raw);
  const secret = process.env['COMMAND_RECONCILIATION_SECRET'] ?? '';
  if (!expected || !/^[a-f0-9]{64}$/.test(expected.requestSha256) || !expected.nodeFqdn
    || secret.length < 32 || secret === RESULT_SIGNING_SECRET || secret === nodeToken
    || assertion.commandId !== commandId || assertion.nodeFqdn !== expected.nodeFqdn
    || assertion.requestSha256 !== expected.requestSha256
    || (fresh && (assertion.expiresAt <= Date.now() || assertion.expiresAt > Date.now() + 300_000)))
    throw new Error('Command reconciliation authority, expected node, digest, or validity differs');
  const signature = createHmac('sha256', secret).update(commandReconciliationSigningPayload(assertion)).digest();
  if (!timingSafeEqual(signature, Buffer.from(assertion.signature, 'hex')))
    throw new Error('Command reconciliation signature verification failed');
  return assertion;
}

// ─── Node API Client — used by the control-api to talk to node-manager agents ───

export interface NodeApiClientOptions {
  baseUrl: string;
  nodeToken: string;
  timeout?: number;
  resourceNodeId?: string;
  resourceActorId?: string;
  resourceScope?: 'ardent-managed-http';
}

export interface ManagedMutationEvidence {
  commandId: string;
  commandSha256: string;
  receiptSha256: string;
  acknowledgedAt: Date;
}

export interface ManagedMutationResult<T> {
  response: T;
  evidence: ManagedMutationEvidence;
}

/**
 * An agent running with MAGNUS_AGENT_PRIVILEGED=false answers root-only routes
 * (cron, users, system updates, Ardent actions) with 403 AGENT_NOT_PRIVILEGED.
 * Surface that as a non-retryable "feature disabled on this node" error.
 */
export const AGENT_NOT_PRIVILEGED = 'AGENT_NOT_PRIVILEGED';

async function rejectUnprivilegedAgent({ response }: AfterResponseState): Promise<void> {
  if (response.status !== 403) return;
  type Denial = { error?: { code?: unknown; feature?: unknown } };
  let body: Denial;
  try { body = await response.clone().json() as Denial; } catch { return; }
  if (body?.error?.code !== AGENT_NOT_PRIVILEGED) return;
  const feature = typeof body.error.feature === 'string' ? body.error.feature.slice(0, 64) : 'feature';
  throw new HttpError(409, AGENT_NOT_PRIVILEGED,
    `${feature} is disabled on this node: agent is not privileged (MAGNUS_AGENT_PRIVILEGED=false)`);
}

/** Whether an error means the target agent has the feature disabled. */
export function isAgentNotPrivileged(error: unknown): boolean {
  return error instanceof HttpError && error.code === AGENT_NOT_PRIVILEGED;
}

export class NodeApiClient {
  private api: KyInstance;
  private readonly nodeToken: string;
  private readonly defaultTimeout: number;
  private readonly resourceContext?: ResourceCommandContext;

  constructor(options: NodeApiClientOptions) {
    this.nodeToken = options.nodeToken;
    this.defaultTimeout = options.timeout ?? 15_000;
    if (options.resourceNodeId) this.resourceContext = { nodeId: options.resourceNodeId,
      actorId: options.resourceActorId ?? 'system:control-api', baseUrl: options.baseUrl,
      ...(options.resourceScope ? { scope: options.resourceScope } : {}) };
    this.api = ky.create({
      prefix: `${options.baseUrl}/api/v1`,
      timeout: options.timeout ?? 15_000,
      headers: {
        'x-node-token': options.nodeToken,
      },
      hooks: { afterResponse: [rejectUnprivilegedAgent] },
    });
  }

  /** All finite native mutations use the same central owner and node execution slot. */
  private async mutateWithEvidence<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown,
    timeout = this.defaultTimeout, commandId?: string, skillPublication?: {
      skillName: string; version: string; bundleSha256: string;
    }, requireManaged = false): Promise<{ response: T; evidence?: ManagedMutationEvidence }> {
    if (!this.resourceContext) throw new Error('Managed mutation requires canonical resource node identity');
    const serialized = body === undefined ? '' : JSON.stringify(body);
    const nativePath = '/' + path; const requestedTimeoutSeconds = Math.ceil(timeout / 1000);
    const timeoutSeconds = Math.min(3600, requestedTimeoutSeconds);
    const descriptor = nativeCompletionDescriptor(method, nativePath);
    const identity = httpIdentity(commandId ?? 'native-' + randomUUID(), method, nativePath, serialized, timeoutSeconds);
    const admission = await admitResourceCommand(this.resourceContext, identity);
    if (!admission && requireManaged) throw new Error('This operation requires enrolled managed admission; direct node mutation is forbidden');
    if (!admission) return { response: await this.api(path, { method,
      ...(body === undefined ? {} : { body: serialized, headers: { 'content-type': 'application/json' } }), timeout, retry: 0 }).json<T>() };
    try {
      if (!descriptor || descriptor.completionMode !== 'buffered-synchronous-http'
        || requestedTimeoutSeconds > descriptor.timeoutCeilingSeconds)
        throw new Error('This enrolled-node mutation lacks a reviewed completion boundary; not dispatched');
      if (admission.payload.coordination?.resourceKey !== nativeCompletionResourceKey(descriptor, this.resourceContext.nodeId))
        throw new Error('Native mutation resource classification differs from its lease');
      const capability = await this.api.get('ping').json<ApiResponse<{ features?: { managedMutations?: number } }>>();
      if (!capability.success || capability.data?.features?.managedMutations !== 1) throw new Error('Node does not support managed mutations; operation not dispatched');
      await markResourceDispatched(admission);
      const managedRequest = managedHttpRequestSchema.parse({
        claim: { leaseId: admission.leaseId, nodeId: admission.nodeId, nodeFqdn: admission.nodeFqdn },
        commandId: admission.commandId, method, path: '/' + path, body: serialized,
        timeoutSeconds: identity.timeoutSeconds, coordination: admission.payload.coordination,
      });
      const envelope = await this.api.post('commands/managed-http', { retry: 0, timeout: timeout + 5000,
        json: managedRequest }).json<ApiResponse<{ response: { status: number; body: string }; receipt: SignedCommandResult }>>();
      if (!envelope.success) throw new Error('Managed mutation response was unsuccessful');
      const { response } = envelope.data;
      const receipt = this.verifiedCommandResult(envelope.data.receipt, admission.commandId);
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599 || typeof response.body !== 'string'
        || receipt.stdout !== httpReceiptBody(method, '/' + path, response.status, response.body)) throw new Error('Managed response body differs from signed receipt');
      await settleResourceResult(admission.commandId, receipt);
      if (response.status === 409 && skillPublication) await correlateSkillPublicationNoEffect({
        commandId: admission.commandId, requestSha256: commandRequestDigest(admission.payload),
        skillName: skillPublication.skillName, version: skillPublication.version,
        bundleSha256: skillPublication.bundleSha256, responseBody: response.body,
      });
      if (response.status >= 400) throw new Error(`Native mutation completed with HTTP ${response.status}`);
      const commandSha256 = receipt.coordination?.requestSha256;
      if (!commandSha256 || commandSha256 !== commandRequestDigest(admission.payload))
        throw new Error('Managed mutation command evidence differs');
      return { response: JSON.parse(response.body) as T, evidence: { commandId: receipt.commandId,
        commandSha256, receiptSha256: createHash('sha256').update(JSON.stringify({
          payload: commandResultSigningPayload(receipt), signature: receipt.signature,
        })).digest('hex'),
        acknowledgedAt: new Date() } };
    } catch (error) { await failResourceCommand(admission); throw error; }
  }

  private async mutate<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, timeout = this.defaultTimeout): Promise<T> {
    return (await this.mutateWithEvidence<T>(method, path, body, timeout)).response;
  }

  private async evidencedMutation<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown,
    commandId?: string): Promise<ManagedMutationResult<T>> {
    const result = await this.mutateWithEvidence<T>(method, path, body, this.defaultTimeout, commandId);
    if (!result.evidence) throw new Error('Managed mutation acknowledgement requires a signed managed HTTP receipt');
    return { response: result.response, evidence: result.evidence };
  }

  // ── Health ──

  async collectHealth(): Promise<ApiResponse<HealthSnapshot>> {
    return this.api.get('health/collect').json();
  }

  async enableSystemUpdates(): Promise<ApiResponse<SystemUpdateInfo>> {
    return this.mutate('POST', 'health/system-updates/enable', undefined, 20 * 60_000);
  }

  // ── Commands ──

  private verifiedCommandResult(raw: unknown, commandId: string): SignedCommandResult {
    const parsed = commandResultSchema.safeParse(raw);
    if (!parsed.success || parsed.data.commandId !== commandId || !verifyCommandResultSignature(
      parsed.data, RESULT_SIGNING_SECRET, RESULT_SIGNING_PREVIOUS_SECRET,
    )) throw new Error('Command result signature verification failed');
    return parsed.data;
  }

  async executeCommand(payload: CommandRequest): Promise<ApiResponse<CommandResult>> {
    // Snapshot callers' mutable objects before any asynchronous admission check.
    payload = structuredClone(payload);
    if (!this.resourceContext) throw new Error('Managed command requires canonical resource node identity');
    const admission = await admitResourceCommand(this.resourceContext, payload);
    if (admission) payload = admission.payload;
    try {
      if (payload.coordination) {
        commandFenceSchema.parse(payload.coordination);
        const descriptor = commandCompletionDescriptor(payload);
        const capability = await this.api.get('ping').json<ApiResponse<{ features?: { commandFencing?: number; managedMutations?: number;
          commandCompletionRegistry?: { version?: number; sha256?: string; enabled?: number } } }>>();
        if (!capability.success || capability.data?.features?.commandFencing !== 1) throw new Error('Node does not support command fencing; command not dispatched');
        if (admission && capability.data?.features?.managedMutations !== 1) throw new Error('Node does not support sticky managed mutation admission; command not dispatched');
        if (descriptor && (capability.data?.features?.commandCompletionRegistry?.enabled !== 1
          || capability.data.features.commandCompletionRegistry.version !== COMMAND_COMPLETION_REGISTRY.version
          || capability.data.features.commandCompletionRegistry.sha256 !== COMMAND_COMPLETION_REGISTRY_SHA256))
          throw new Error('Node command completion registry differs; command not dispatched');
        if (payload.coordination.expiresAt <= Date.now()) throw new Error('Command lease expired; command not dispatched');
      }
      const timeout = (payload.timeoutSeconds + 5) * 1_000;
      // A missing POST response is uncertain. Reconcile through the receipt API;
      // never use transport retries to run an action again.
      if (admission) await markResourceDispatched(admission);
      const response = await this.api.post('commands/execute', { json: payload, timeout, retry: 0, ...(admission ? { headers: { [MANAGED_CLAIM_HEADER]: JSON.stringify({ leaseId: admission.leaseId, nodeId: admission.nodeId, nodeFqdn: admission.nodeFqdn }) } } : {}) }).json<ApiResponse<CommandResult>>();
      const result = this.verifiedCommandResult(response?.data, payload.commandId);
      const descriptor = commandCompletionDescriptor(payload);
      if (descriptor && (result.completion?.registryVersion !== COMMAND_COMPLETION_REGISTRY.version
        || result.completion.registrySha256 !== COMMAND_COMPLETION_REGISTRY_SHA256
        || result.completion.descriptorId !== descriptor.id)) throw new Error('Command completion registry receipt differs');
      if (!descriptor && result.completion !== undefined) throw new Error('Unregistered command returned terminal registry evidence');
      if (payload.coordination ? !result.coordination
        || result.coordination.resourceKey !== payload.coordination.resourceKey
        || result.coordination.fence !== payload.coordination.fence
        || result.coordination.expiresAt !== payload.coordination.expiresAt
        || result.coordination.requestSha256 !== commandRequestDigest(payload)
        : result.coordination !== undefined) throw new Error('Command result request/fence verification failed');
      if (!response.success) throw new Error('Command execution response was unsuccessful');
      if (admission) await settleResourceResult(payload.commandId, result);
      return response;
    } catch (error) {
      if (admission) await failResourceCommand(admission);
      throw error;
    }
  }

  private verifiedCommandReceipt(raw: unknown, commandId: string, expected?: ExpectedCommandReceipt): CommandReceipt {
    const parsed = z.object({ commandId: z.string(), requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
      state: z.enum(['running', 'unknown', 'completed', 'reconciled']), result: z.unknown().optional(),
      reconciliation: z.unknown().optional(), coordination: commandFenceSchema.optional(),
    }).safeParse(raw);
    if (!parsed.success || parsed.data.commandId !== commandId
      || (expected && parsed.data.requestSha256 !== expected.requestSha256)) throw new Error('Invalid command receipt');
    const row = parsed.data;
    if (row.state === 'reconciled') {
      if (row.result !== undefined) throw new Error('Reconciled receipt cannot contain a result');
      const assertion = verifiedReconciliation(row.reconciliation, commandId, expected, false, this.nodeToken);
      if (assertion.requestSha256 !== row.requestSha256
        || JSON.stringify(row.coordination ?? null) !== JSON.stringify(assertion.coordination ?? null))
        throw new Error('Reconciliation receipt request/fence binding differs');
      return { commandId, requestSha256: row.requestSha256, state: 'reconciled', reconciliation: assertion };
    }
    if (row.reconciliation !== undefined) throw new Error('Unreconciled receipt cannot contain an attestation');
    if (row.state === 'completed') {
      const result = this.verifiedCommandResult(row.result, commandId);
      if (result.coordination && result.coordination.requestSha256 !== row.requestSha256) throw new Error('Receipt request binding differs');
      return { commandId, requestSha256: row.requestSha256, state: 'completed', result };
    }
    if (row.result !== undefined) throw new Error('Nonterminal receipt cannot contain a result');
    return { commandId, requestSha256: row.requestSha256, state: row.state };
  }

  async getCommandReceipt(commandId: string, expected?: ExpectedCommandReceipt): Promise<CommandReceipt> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(commandId)) throw new Error('Invalid command identifier');
    expected = expected ? { ...expected } : undefined;
    const response = await this.api.get(`commands/receipts/${encodeURIComponent(commandId)}`).json<ApiResponse<unknown>>();
    if (!response.success) throw new Error('Command receipt response was unsuccessful');
    const receipt = this.verifiedCommandReceipt(response.data, commandId, expected);
    if (this.resourceContext && receipt.state === 'completed') await settleResourceResult(commandId, receipt.result);
    if (this.resourceContext && receipt.state === 'reconciled') await settleResourceReconciliation(this.resourceContext.nodeId, receipt.reconciliation);
    return receipt;
  }

  /** Submit only an already signed, explicitly reviewed assertion. This method
   * neither signs a decision, runs a command, nor retries ambiguous mutations. */
  async reconcileCommandReceipt(raw: CommandReconciliationAssertion, expected: ExpectedCommandReceipt): Promise<CommandReceipt> {
    expected = { ...expected };
    const assertion = verifiedReconciliation(raw, raw.commandId, expected, true, this.nodeToken);
    const capability = await this.api.get('ping').json<ApiResponse<{ features?: { commandReconciliation?: number } }>>();
    if (!capability.success || capability.data?.features?.commandReconciliation !== 1)
      throw new Error('Node does not support explicit command reconciliation');
    // A capability lookup may consume the assertion's remaining validity.
    verifiedReconciliation(assertion, assertion.commandId, expected, true, this.nodeToken);
    const response = await this.api.post(`commands/receipts/${encodeURIComponent(assertion.commandId)}/reconcile`,
      { json: assertion, retry: 0 }).json<ApiResponse<unknown>>();
    if (!response.success) throw new Error('Command reconciliation response was unsuccessful');
    const receipt = this.verifiedCommandReceipt(response.data, assertion.commandId, expected);
    if (receipt.state !== 'reconciled' || receipt.reconciliation.signature !== assertion.signature)
      throw new Error('Node did not acknowledge the exact reconciliation decision');
    if (this.resourceContext) await settleResourceReconciliation(this.resourceContext.nodeId, receipt.reconciliation);
    return receipt;
  }

  // ── Cron ──

  async listCronJobs(): Promise<ApiResponse<CronJobSpec[]>> {
    return this.api.get('cron').json();
  }

  async listAllUserCronJobs(): Promise<ApiResponse<Array<CronJobSpec & { user: string }>>> {
    return this.api.get('cron/all-users').json();
  }

  async syncManagedCronJob(data: ManagedCronSpec): Promise<ManagedMutationResult<ApiResponse<ManagedCronIdentity & { staged: true; enabled: false }>>> {
    return this.evidencedMutation('POST', 'cron/managed-sync', data);
  }

  /** Pre-enrollment conversion may only stage a disabled definition and remove
   * its same-name legacy wake-up. It deliberately cannot return activation evidence. */
  async stageManagedCronForEnrollment(data: CronEnrollmentStage): Promise<ApiResponse<ManagedCronIdentity & {
    operationId: string; staged: true; enabled: false; receiptSignature: string }>> {
    return this.api.post('cron/enrollment-stage', { json: data, retry: 0 }).json();
  }

  async activateManagedCronJob(data: ManagedCronIdentity): Promise<ManagedMutationResult<ApiResponse<ManagedCronIdentity & { activated: true; enabled: true }>>> {
    return this.evidencedMutation('POST', 'cron/managed-activate', data);
  }

  async revokeManagedCronJob(data: ManagedCronIdentity): Promise<ManagedMutationResult<ApiResponse<ManagedCronIdentity & { revoked: true; enabled: false }>>> {
    return this.evidencedMutation('POST', 'cron/managed-revoke', data);
  }

  /** Signed evidence reconciliation is an enrollment control message. It does
   * not execute or mutate the observed foreign scheduler itself. */
  async reconcileSchedulerSource(data: SchedulerSourceSettlement): Promise<ApiResponse<unknown>> {
    return this.api.post('cron/source-reconciliation', { json: data, retry: 0 }).json();
  }

  async syncCronJob(data: CronJobCreateRequest): Promise<ApiResponse<CronJobSpec>> {
    return this.mutate('POST', 'cron/sync', data);
  }

  async updateCronJob(name: string, data: CronJobUpdateRequest): Promise<ApiResponse<CronJobSpec>> {
    return this.mutate('PATCH', `cron/${encodeURIComponent(name)}`, data);
  }

  async deleteCronJob(name: string): Promise<ApiResponse<{ deleted: boolean }>> {
    return this.mutate('DELETE', `cron/${encodeURIComponent(name)}`);
  }

  // ── Files ──

  async readFile(filePath: string): Promise<ApiResponse<FileReadResponse>> {
    return this.api.get('files/read', { searchParams: { filePath } }).json();
  }

  async writeFile(payload: {
    filePath: string;
    content: string;
    createIfMissing?: boolean;
  }): Promise<ApiResponse<{ written: boolean; checksum: string }>> {
    return this.mutate('POST', 'files/write', payload);
  }

  // ── Skills ──

  async listSkills(): Promise<ApiResponse<DiscoveredSkill[]>> {
    return this.api.get('skills').json();
  }

  async installSkill(payload: {
    skillName: string;
    version: string;
    downloadUrl?: string;
    checksum?: string;
  }): Promise<ApiResponse<SkillInstallation>> {
    return this.mutate('POST', 'skills/install', payload);
  }

  async publishSkillBundle(payload: {
    skillName: string;
    version: string;
    bundleSha256: string;
    bundle: {
      format: 'magnus-skill-bundle-v1';
      entries: Array<{ path: string; mode: 420 | 493; sha256: string; contentBase64: string }>;
    };
  }, commandId: string): Promise<ManagedMutationResult<ApiResponse<SkillInstallation & {
    publishedAt: string;
    bundleSha256: string;
    treeSha256: string;
    commandId: string;
    requestSha256: string;
  }>>> {
    const result = await this.mutateWithEvidence<ApiResponse<SkillInstallation & {
      publishedAt: string; bundleSha256: string; treeSha256: string; commandId: string; requestSha256: string;
    }>>('POST', 'skills/install', payload, this.defaultTimeout, commandId, payload);
    if (!result.evidence) throw new Error('Managed skill publication acknowledgement requires a signed receipt');
    return { response: result.response, evidence: result.evidence };
  }

  /** Ask the node to recover only the retained result of the exact previously
   * dispatched skill publication. The node's recovery-claim path cannot invoke
   * the skill handler or create a new effect. */
  async recoverSkillBundle(payload: {
    skillName: string;
    version: string;
    bundleSha256: string;
    bundle: {
      format: 'magnus-skill-bundle-v1';
      entries: Array<{ path: string; mode: 420 | 493; sha256: string; contentBase64: string }>;
    };
  }, ownership: { leaseId: string; commandId: string; nodeId: string; nodeFqdn: string;
    requestSha256: string; timeoutSeconds: number; coordination: z.infer<typeof commandFenceSchema> }): Promise<ManagedMutationResult<ApiResponse<SkillInstallation & {
      publishedAt: string; bundleSha256: string; treeSha256: string; commandId: string; requestSha256: string;
    }>>> {
    if (!this.resourceContext || this.resourceContext.nodeId !== ownership.nodeId)
      throw new Error('Skill recovery target differs from canonical node identity');
    const serialized = JSON.stringify(payload);
    const identity = { ...httpIdentity(ownership.commandId, 'POST', '/skills/install', serialized, ownership.timeoutSeconds),
      coordination: ownership.coordination };
    if (commandRequestDigest(identity) !== ownership.requestSha256)
      throw new Error('Skill recovery request differs from retained workflow identity');
    const managedRequest = managedHttpRequestSchema.parse({
      claim: { leaseId: ownership.leaseId, nodeId: ownership.nodeId, nodeFqdn: ownership.nodeFqdn },
      commandId: ownership.commandId, method: 'POST', path: '/skills/install', body: serialized,
      timeoutSeconds: ownership.timeoutSeconds, coordination: ownership.coordination, recoveryOnly: true,
    });
    const envelope = await this.api.post('commands/managed-http', { retry: 0,
      timeout: Math.max(this.defaultTimeout, ownership.timeoutSeconds * 1000) + 5000,
      json: managedRequest }).json<ApiResponse<{ response: { status: number; body: string }; receipt: SignedCommandResult }>>();
    if (!envelope.success) throw new Error('Skill publication recovery response was unsuccessful');
    const receipt = this.verifiedCommandResult(envelope.data.receipt, ownership.commandId);
    const response = envelope.data.response;
    if (!Number.isInteger(response.status) || typeof response.body !== 'string'
      || receipt.coordination?.requestSha256 !== ownership.requestSha256
      || receipt.stdout !== httpReceiptBody('POST', '/skills/install', response.status, response.body))
      throw new Error('Recovered skill publication differs from its signed workflow receipt');
    await settleResourceResult(ownership.commandId, receipt);
    if (response.status === 409) {
      await correlateSkillPublicationNoEffect({ commandId: ownership.commandId,
        requestSha256: ownership.requestSha256, skillName: payload.skillName, version: payload.version,
        bundleSha256: payload.bundleSha256, responseBody: response.body });
      throw new Error('Skill publication recovery proved that no effect was committed');
    }
    if (response.status >= 400) throw new Error(`Skill publication recovery completed with HTTP ${response.status}`);
    return { response: JSON.parse(response.body) as ApiResponse<SkillInstallation & {
      publishedAt: string; bundleSha256: string; treeSha256: string; commandId: string; requestSha256: string;
    }>, evidence: { commandId: ownership.commandId, commandSha256: ownership.requestSha256,
      receiptSha256: createHash('sha256').update(JSON.stringify({
        payload: commandResultSigningPayload(receipt), signature: receipt.signature,
      })).digest('hex'), acknowledgedAt: new Date() } };
  }

  async removeSkill(skillName: string): Promise<ApiResponse<{ removed: boolean }>> {
    return this.mutate('DELETE', `skills/${encodeURIComponent(skillName)}`);
  }

  // ── Self-update ──

  async triggerUpdate(payload: {
    targetVersion: string;
    downloadUrl: string;
    checksum: string;
  }): Promise<ApiResponse<{ accepted: boolean }>> {
    return this.mutate('POST', 'update', payload);
  }

  // ── Ping ──

  async ping(): Promise<ApiResponse<{ ok: boolean; version: string }>> {
    return this.api.get('ping').json();
  }

  // ── Hermes Agent runtime ──

  async getHermesState(payload: { hermesHome?: string; hermesBin?: string } = {}): Promise<ApiResponse<HermesNodeState>> {
    return this.api.get('hermes/state', { searchParams: payload }).json();
  }

  async installHermes(payload: {
    hermesHome?: string;
    hermesBin?: string;
    skipBrowser?: boolean;
    configuration?: HermesManagedConfiguration;
  }): Promise<ApiResponse<{ state: HermesNodeState; warnings: string[]; output: string }>> {
    return this.mutate('POST', 'hermes/install', payload, 20 * 60_000);
  }

  async configureHermes(payload: {
    hermesHome?: string;
    hermesBin?: string;
    configuration: HermesManagedConfiguration;
  }): Promise<ApiResponse<{ state: HermesNodeState; warnings: string[] }>> {
    return this.mutate('POST', 'hermes/configure', payload, 60_000);
  }

  async updateHermes(payload: {
    hermesHome?: string;
    hermesBin?: string;
    checkOnly?: boolean;
    backup?: boolean;
    configuration?: HermesManagedConfiguration;
  }): Promise<ApiResponse<{ state: HermesNodeState; warnings: string[]; output: string }>> {
    return this.mutate('POST', 'hermes/update', payload, 20 * 60_000);
  }

  async uninstallHermes(payload: {
    hermesHome?: string;
    hermesBin?: string;
    confirm: true;
    keepConfiguration?: boolean;
  }): Promise<ApiResponse<{ state: HermesNodeState; output: string }>> {
    return this.mutate('POST', 'hermes/uninstall', payload, 5 * 60_000);
  }

  // ── Codex CLI and ChatGPT OAuth ──

  async getCodexState(refreshLatest = false): Promise<ApiResponse<CodexNodeState>> {
    return this.api.get('codex/state', { searchParams: { refreshLatest }, timeout: 35_000 }).json();
  }

  // ── Ardent node-local runtime ──

  async getArdentState(timeoutMs = 15_000): Promise<ApiResponse<ArdentNodeState>> {
    return this.api.get('ardent/state', { timeout: timeoutMs, retry: 0 }).json();
  }

  async getArdentProfileResource<T>(profile: string, resource: string, query?: Record<string, string>): Promise<T> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(profile) || !/^[A-Za-z0-9_/-]{1,120}$/.test(resource)) throw new Error('Invalid Ardent profile resource');
    return this.api.get(`ardent/profiles/${profile}/api/${resource}`, { ...(query ? { searchParams: query } : {}), timeout: 15_000 }).json<T>();
  }

  async getArdentArtifact(profile: string, artifactId: string): Promise<Uint8Array> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(profile) || !/^[a-f0-9]{64}$/.test(artifactId)) throw new Error('Invalid Ardent artifact target');
    const response = await this.api.get(`ardent/profiles/${profile}/api/artifacts/${artifactId}`, { timeout: 15_000 });
    if (response.headers.get('content-type') !== 'application/octet-stream') throw new Error('Ardent artifact response type differs');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('Ardent artifact exceeds size limit');
    return new Uint8Array(bytes);
  }

  async performArdentAction<T>(profile: string, action: string, target?: string, body?: unknown): Promise<T> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(profile) || !/^[a-z-]{1,32}$/.test(action)
      || (target !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(target))) throw new Error('Invalid Ardent action target');
    const timeout = action === 'package-install' ? 600_000 : action === 'profile-import-hermes' ? 90_000 : action.startsWith('service-') ? 115_000 : 45_000;
    return this.mutate('POST', 'ardent/action', { profile, action, ...(target ? { target } : {}), body: body ?? {} }, timeout);
  }

  async updateCodex(): Promise<ApiResponse<CodexNodeState>> {
    return this.mutate('POST', 'codex/update', undefined, 11 * 60_000);
  }

  async logoutCodex(): Promise<ApiResponse<CodexNodeState>> {
    return this.mutate('POST', 'codex/logout', undefined, 35_000);
  }

  async startCodexDeviceAuth(): Promise<ApiResponse<CodexDeviceAuthSession>> {
    return this.mutate('POST', 'codex/device-auth', undefined, 35_000);
  }

  async getCodexDeviceAuth(id: string): Promise<ApiResponse<CodexDeviceAuthSession>> {
    return this.api.get(`codex/device-auth/${encodeURIComponent(id)}`).json();
  }

  async cancelCodexDeviceAuth(id: string): Promise<ApiResponse<CodexDeviceAuthSession>> {
    return this.mutate('POST', `codex/device-auth/${encodeURIComponent(id)}/cancel`);
  }

  // ── User management ──

  async listUsers(): Promise<ApiResponse<string[]>> {
    return this.api.get('users').json();
  }

  async provisionUser(payload: {
    username: string;
    password: string;
    group?: string;
  }): Promise<ApiResponse<{ username: string; group: string }>> {
    return this.mutate('POST', 'users/provision', payload);
  }

  async changeUserPassword(payload: {
    username: string;
    password: string;
  }): Promise<ApiResponse<{ username: string }>> {
    return this.mutate('POST', 'users/change-password', payload);
  }
}
