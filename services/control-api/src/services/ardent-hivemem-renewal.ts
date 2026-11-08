/**
 * Keeps every Magnus-managed Ardent profile's HiveMem credential ahead of its
 * deadline. HiveMem agent credentials last at most 720 hours, so without this an
 * agent silently loses its memory a month after New Agent or Enable HiveMem.
 *
 * Magnus records each credential it issues (never the token). A background job
 * renews one once half its lifetime has passed: HiveMem's `renew` action issues a
 * new credential with a new deadline and keeps the previous one working for a day,
 * the node agent writes the new one into the profile's `.env`, and the running
 * gateway picks it up through Ardent's credential reload, or a restart on an Ardent
 * without it. A failure is retried with backoff, audited, and raised as a
 * notification that turns critical close to the deadline.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ArdentFleetInstallation, ArdentHiveMemCredentialStatus } from '@hivemagnus/magnus-contracts';
import { getDb } from '../db/index.js';
import { AgentResponseError } from '../sdk/node-api-client.js';
import { logAuditEvent } from './audit-service.js';
import { createNotification } from './notification-service.js';
import { getArdentInstallation, getArdentProfileResource, performArdentAction } from './ardent-service.js';
import {
  ardentHiveMemCredentialRequest, ardentHiveMemDisplayName, ardentHiveMemSettings, ardentHiveMemSupportsRenewal, HiveMemEnrollmentError,
  requestArdentHiveMemCredential, type ArdentHiveMemPlan, type ArdentHiveMemSettings,
} from './ardent-hivemem.js';

/** How often the job looks for credentials to renew. */
export const RENEWAL_CHECK_INTERVAL_MS = 60_000;
/** Renew once this share of a credential's lifetime has passed. */
export const RENEWAL_AT_LIFETIME = 0.5;
/** How long the previous credential keeps working after a renewal: long enough to survive a node being briefly away. */
export const RENEWAL_GRACE_SECONDS = 86_400;
const BACKOFF_FIRST_MS = 15 * 60_000;
const BACKOFF_MAX_MS = 6 * 3_600_000;
/** A failing renewal this close to the deadline is critical. */
const CRITICAL_WITHIN_MS = 72 * 3_600_000;
/** A claimed renewal that no process finishes within this time can be claimed again. */
const LEASE_MS = 10 * 60_000;
const SYSTEM_ACTOR = 'system:ardent-hivemem-renewal';

interface Row {
  id: string; nodeId: string; profile: string; agentId: string; workspaceId: string;
  issuedAt: Date; expiresAt: Date; lastRenewedAt: Date | null; lastAttemptAt: Date | null; nextAttemptAt: Date;
  failures: number; lastError: string | null; renewals: number; leaseUntil: Date | null;
  leaseToken: string | null; pendingJson: string | null; recoveryRequired: boolean; updatedAt: Date;
}

/** When a credential issued at `issuedAt` with this deadline is due for renewal. */
export function renewalDueAt(issuedAt: Date, expiresAt: Date): Date {
  const lifetime = Math.max(0, expiresAt.getTime() - issuedAt.getTime());
  return new Date(issuedAt.getTime() + Math.floor(lifetime * RENEWAL_AT_LIFETIME));
}

/** When to retry after `failures` consecutive failures: 15 minutes, doubling, at most six hours. */
export function renewalRetryAt(now: Date, failures: number): Date {
  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, Math.min(failures - 1, 16)));
  return new Date(now.getTime() + delay);
}

/** The status a profile read shows. */
export function ardentHiveMemCredentialStatus(row: Row, now = new Date()): ArdentHiveMemCredentialStatus {
  const state = row.expiresAt.getTime() <= now.getTime() ? 'expired' : row.failures > 0 ? 'renewal-failing' : 'ok';
  return {
    agentId: row.agentId, workspaceId: row.workspaceId, expiresAt: row.expiresAt.toISOString(),
    lastRenewedAt: row.lastRenewedAt?.toISOString() ?? null, lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    nextRenewalAt: row.nextAttemptAt.toISOString(), failures: row.failures, lastError: row.lastError, state,
  };
}

export interface ArdentHiveMemRenewalDeps {
  settings(): ArdentHiveMemSettings | null;
  supportsRenewal(settings: ArdentHiveMemSettings): Promise<boolean>;
  credential(settings: ArdentHiveMemSettings, plan: ArdentHiveMemPlan): ReturnType<typeof requestArdentHiveMemCredential>;
  installation(nodeId: string): Promise<ArdentFleetInstallation>;
  read<T>(nodeId: string, profile: string, resource: string): Promise<T>;
  action(nodeId: string, profile: string, action: string, target?: string, body?: unknown): Promise<unknown>;
  delay(ms: number): Promise<void>;
  now(): Date;
}

const defaultDeps: ArdentHiveMemRenewalDeps = {
  settings: () => ardentHiveMemSettings(),
  supportsRenewal: settings => ardentHiveMemSupportsRenewal(settings),
  credential: (settings, plan) => requestArdentHiveMemCredential(settings, plan),
  installation: getArdentInstallation,
  read: (nodeId, profile, resource) => getArdentProfileResource(nodeId, profile, resource) as never,
  action: performArdentAction,
  delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => new Date(),
};
let deps = defaultDeps;
/** Replace HiveMem, node and clock access in tests. Returns a restore function. */
export function setArdentHiveMemRenewalDeps(overrides: Partial<ArdentHiveMemRenewalDeps>): () => void {
  deps = { ...defaultDeps, ...overrides };
  return () => { deps = defaultDeps; };
}

/**
 * Record the credential Magnus just delivered to a profile (New Agent, Enable
 * HiveMem or a renewal), with its next renewal time. A new enrollment resets the
 * failure count.
 */
export async function recordArdentHiveMemCredential(input: { nodeId: string; profile: string; agentId: string; workspaceId: string;
  expiresAt: string | null; issuedAt?: Date; adopt?: boolean }): Promise<void> {
  const issuedAt = input.issuedAt ?? deps.now();
  const settings = deps.settings();
  // HiveMem always answers with the deadline; without one, assume the requested lifetime.
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : new Date(issuedAt.getTime() + (settings?.hours ?? 720) * 3_600_000);
  if (Number.isNaN(expiresAt.getTime())) throw new Error('HiveMem returned an invalid credential deadline');
  const data = { agentId: input.agentId, workspaceId: input.workspaceId, issuedAt, expiresAt, nextAttemptAt: renewalDueAt(issuedAt, expiresAt),
    failures: 0, lastError: null, leaseUntil: null, leaseToken: null, pendingJson: null, recoveryRequired: false };
  if (input.adopt) {
    await getDb().ardentHiveMemCredential.createMany({ data: { nodeId: input.nodeId, profile: input.profile, ...data }, skipDuplicates: true });
    return;
  }
  await getDb().ardentHiveMemCredential.upsert({ where: { nodeId_profile: { nodeId: input.nodeId, profile: input.profile } },
    create: { nodeId: input.nodeId, profile: input.profile, ...data }, update: data });
}

/** Credential status for each node profile Magnus manages, keyed `nodeId:profile`. */
export async function ardentHiveMemCredentialStatuses(nodeIds: string[]): Promise<Map<string, ArdentHiveMemCredentialStatus>> {
  if (!nodeIds.length) return new Map();
  const rows = await getDb().ardentHiveMemCredential.findMany({ where: { nodeId: { in: nodeIds } } }) as Row[];
  const now = deps.now();
  return new Map(rows.map(row => [`${row.nodeId}:${row.profile}`, ardentHiveMemCredentialStatus(row, now)]));
}

/**
 * Profiles enrolled before Magnus recorded credentials: adopt each one's latest
 * succeeded HiveMem enrollment from the operation receipts, so it is renewed too.
 */
export async function adoptEnrolledArdentProfiles(): Promise<number> {
  const db = getDb();
  const operations = await db.ardentAgentOperation.findMany({ where: { status: 'succeeded' }, orderBy: { completedAt: 'desc' },
    select: { nodeId: true, profile: true, stepsJson: true, completedAt: true } });
  const known = new Set((await db.ardentHiveMemCredential.findMany({ select: { nodeId: true, profile: true } }))
    .map(row => `${row.nodeId}:${row.profile}`));
  let adopted = 0;
  for (const operation of operations) {
    const key = `${operation.nodeId}:${operation.profile}`;
    if (known.has(key)) continue;
    known.add(key);
    const steps = JSON.parse(operation.stepsJson) as Array<{ name: string; status: string; finishedAt: string | null; receipt: Record<string, unknown> | null }>;
    const enroll = steps.find(step => step.name === 'hivemem-enroll' && step.status === 'succeeded');
    const receipt = enroll?.receipt;
    if (!receipt || typeof receipt['agentId'] !== 'string' || typeof receipt['workspaceId'] !== 'string') continue;
    // An expired credential needs Enable HiveMem again; renewal cannot revive it.
    if (typeof receipt['expiresAt'] !== 'string' || !(Date.parse(receipt['expiresAt']) > deps.now().getTime())) continue;
    await recordArdentHiveMemCredential({ nodeId: operation.nodeId, profile: operation.profile, agentId: receipt['agentId'],
      workspaceId: receipt['workspaceId'], expiresAt: receipt['expiresAt'],
      issuedAt: new Date(enroll.finishedAt ?? operation.completedAt ?? deps.now()), adopt: true });
    adopted++;
  }
  return adopted;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[token]').slice(0, 500);
}

/** Stop tracking a profile that no longer exists on a reachable node. Its credential simply expires. */
class ProfileGone extends Error {}
class ClaimLost extends Error {}
class RecoveryRequired extends Error {}

/** Only the current, unexpired claim may change state or begin a node mutation. */
async function assertClaim(row: Row): Promise<void> {
  const owned = await getDb().ardentHiveMemCredential.findFirst({ where: { id: row.id, leaseToken: row.leaseToken,
    leaseUntil: { gt: deps.now() } }, select: { id: true } });
  if (!owned) throw new ClaimLost('Renewal claim was superseded');
}
async function updateClaim(row: Row, data: Record<string, unknown>): Promise<void> {
  const result = await getDb().ardentHiveMemCredential.updateMany({ where: { id: row.id, leaseToken: row.leaseToken,
    leaseUntil: { gt: deps.now() } }, data });
  if (result.count !== 1) throw new ClaimLost('Renewal claim was superseded');
}


/** The installed Ardent did not know the reload route, or the node agent did not know the action: restart instead. */
function reloadUnsupported(error: unknown): boolean {
  return error instanceof AgentResponseError && [400, 404, 405].includes(error.agentStatus);
}

type Activation = 'reloaded' | 'restarted' | 'deferred';

/** Make the running gateway use the token just written to its `.env`. A stopped profile reads it when it starts. */
async function activate(row: Row, running: boolean): Promise<Activation> {
  if (!running) return 'deferred';
  try {
    await deps.action(row.nodeId, row.profile, 'hivemem-credential-reload');
    return 'reloaded';
  } catch (error: unknown) {
    if (!reloadUnsupported(error)) throw error;
  }
  await assertClaim(row);
  await deps.action(row.nodeId, row.profile, 'service-restart');
  return 'restarted';
}

/** Whether the agent reports HiveMem ready after the switch, or why not. Advisory: the renewal itself succeeded. */
async function verify(row: Row): Promise<string | null> {
  let last = 'no answer';
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const memory = await deps.read<{ status?: unknown; reason?: unknown }>(row.nodeId, row.profile, 'memory/status');
      if (memory?.status === 'ready') return null;
      last = `HiveMem is ${String(memory?.status ?? 'unknown')}${typeof memory?.reason === 'string' ? `: ${memory.reason}` : ''}`;
    } catch (error: unknown) { last = message(error); }
    if (attempt < 5) await deps.delay(3000);
  }
  return `Renewed, but the agent does not report HiveMem ready (${last})`.slice(0, 500);
}

/** One renewal: new credential from HiveMem, delivered to the node and activated. */
async function renew(row: Row, settings: ArdentHiveMemSettings): Promise<{ expiresAt: string | null; activation: Activation; operationId: string;
  previousCredentialValidUntil: string; warning: string | null; renewals: number }> {
  const installation = await deps.installation(row.nodeId).catch((error: unknown) => {
    // The node was removed from Magnus or decommissioned.
    if (error instanceof Error && error.message === 'Managed node not found') throw new ProfileGone('The node is no longer managed');
    throw error;
  });
  if (!installation.reachable) throw new Error(`Node unreachable: ${installation.error ?? 'no answer'}`);
  const profile = installation.profiles.find(item => item.id === row.profile);
  if (!profile) {
    if (installation.installed) throw new ProfileGone('The Ardent profile no longer exists on the node');
    throw new Error('Ardent is not installed on the node');
  }
  if (!await deps.supportsRenewal(settings)) throw new HiveMemEnrollmentError(501,
    'HiveMem cannot renew agent credentials (no actor_credential_renewal capability); upgrade HiveMem', 'HIVEMEM_RENEWAL_UNSUPPORTED');
  // The entire wire policy and its destination/principal binding are durable BEFORE issuance.
  // A retry also freezes scopes, descriptions and the display name across upgrades/settings drift.
  let pending: { plan: ArdentHiveMemPlan; authority: string; startedAt: string };
  const authority = createHash('sha256').update(JSON.stringify([settings.apiUrl, settings.auth.kind,
    settings.auth.kind === 'token' ? settings.auth.token : [settings.auth.tokenUrl, settings.auth.clientId]])).digest('hex');
  if (row.pendingJson) pending = JSON.parse(row.pendingJson) as typeof pending;
  else {
    const plan: ArdentHiveMemPlan = { key: `renew-v2:${row.id}:${randomUUID()}`, action: 'renew', agentId: row.agentId,
      displayName: ardentHiveMemDisplayName(row.profile, installation.nodeName), workspaceId: row.workspaceId,
      expiresAt: new Date(deps.now().getTime() + settings.hours * 3_600_000 - 60_000).toISOString(), graceSeconds: RENEWAL_GRACE_SECONDS };
    plan.request = ardentHiveMemCredentialRequest(plan);
    pending = { plan, authority, startedAt: deps.now().toISOString() };
    const pendingJson = JSON.stringify(pending);
    await updateClaim(row, { pendingJson });
    row.pendingJson = pendingJson;
  }
  if (pending.authority !== authority) throw new RecoveryRequired('HiveMem destination or service identity changed during a pending renewal');
  await assertClaim(row);
  const issued = await deps.credential(settings, pending.plan);
  // Neither delivery nor activation failure advances the key. Repeat the SAME token, even when
  // the node committed a credential write but its response was lost.
  await assertClaim(row);
  await deps.action(row.nodeId, row.profile, 'hivemem-credential-set', undefined, { token: issued.token });
  await assertClaim(row);
  const activation = await activate(row, profile.running);
  const warning = activation === 'deferred' ? null : await verify(row);
  return { expiresAt: issued.expiresAt ?? pending.plan.expiresAt, activation, operationId: issued.operationId,
    previousCredentialValidUntil: new Date(Date.parse(pending.startedAt) + RENEWAL_GRACE_SECONDS * 1000).toISOString(),
    warning, renewals: row.renewals + 1 };
}

async function notifyFailure(row: Row, error: string, now: Date, recovery = false): Promise<void> {
  const remaining = row.expiresAt.getTime() - now.getTime();
  const expired = remaining <= 0;
  await createNotification({
    type: 'ardent.hivemem.renewal_failed', severity: recovery || remaining < CRITICAL_WITHIN_MS ? 'critical' : 'warning',
    title: expired ? `Ardent ${row.profile} has lost HiveMem` : `HiveMem credential renewal failed for Ardent ${row.profile}`,
    message: (expired
      ? `The credential expired at ${row.expiresAt.toISOString()}. Run Enable HiveMem on the profile to enroll it again. Last error: ${error}`
      : `The recorded credential expires at ${row.expiresAt.toISOString()}. Last error: ${error}`).slice(0, 1000),
    nodeId: row.nodeId, sourceRef: `ardent-hivemem:${row.nodeId}:${row.profile}`,
    metadata: { profile: row.profile, agentId: row.agentId, failures: row.failures + 1, expiresAt: row.expiresAt.toISOString() },
  }).catch((cause: unknown) => console.warn(`[ardent-hivemem] notification failed: ${message(cause)}`));
}

/** Renew one claimed credential and record the outcome. Never throws. */
async function renewClaimed(row: Row, settings: ArdentHiveMemSettings): Promise<'renewed' | 'failed' | 'untracked' | 'skipped'> {
  const db = getDb();
  const target = `${row.nodeId}:${row.profile}`;
  const previousExpiresAt = row.expiresAt.toISOString();
  try {
    const result = await renew(row, settings);
    const now = deps.now();
    const expiresAt = result.expiresAt ? new Date(result.expiresAt) : new Date(now.getTime() + settings.hours * 3_600_000);
    await updateClaim(row, { issuedAt: now, expiresAt, lastRenewedAt: now, renewals: result.renewals, pendingJson: null,
      nextAttemptAt: renewalDueAt(now, expiresAt), failures: 0, lastError: result.warning, leaseUntil: null, leaseToken: null });
    await logAuditEvent({ action: 'ardent.hivemem.renew', actorId: SYSTEM_ACTOR, actorType: 'system', targetType: 'ardent-profile', targetId: target,
      details: { status: 'succeeded', agentId: row.agentId, workspaceId: row.workspaceId, previousExpiresAt, expiresAt: expiresAt.toISOString(),
        previousCredentialValidUntil: result.previousCredentialValidUntil, activation: result.activation, hivememOperationId: result.operationId,
        renewal: result.renewals, ...(result.warning ? { warning: result.warning } : {}) } });
    console.log(`[ardent-hivemem] renewed ${target} until ${expiresAt.toISOString()} (${result.activation})`);
    return 'renewed';
  } catch (error: unknown) {
    if (error instanceof ClaimLost) return 'skipped';
    const now = deps.now();
    const recovery = error instanceof RecoveryRequired || error instanceof HiveMemEnrollmentError && [409, 410].includes(error.status);
    const text = recovery ? 'Renewal outcome requires recovery: ' + message(error)
      + '. An ADMIN must inspect the profile and explicitly run Enable HiveMem; no replacement is issued automatically.' : message(error);
    if (error instanceof ProfileGone) {
      const deleted = await db.ardentHiveMemCredential.deleteMany({ where: { id: row.id, leaseToken: row.leaseToken, leaseUntil: { gt: now } } });
      if (!deleted.count) return 'skipped';
      await logAuditEvent({ action: 'ardent.hivemem.untrack', actorId: SYSTEM_ACTOR, actorType: 'system', targetType: 'ardent-profile', targetId: target,
        details: { agentId: row.agentId, reason: text, expiresAt: previousExpiresAt } });
      console.log(`[ardent-hivemem] stopped renewing ${target}: ${text}`);
      return 'untracked';
    }
    const failures = row.failures + 1;
    // Pending issuance has only a fifteen-minute replay window: retry each minute.
    // A 409/410 is held for explicit recovery, never hidden by a new key or more grace.
    try { await updateClaim(row, { failures, lastError: text, recoveryRequired: recovery,
      nextAttemptAt: row.pendingJson ? new Date(now.getTime() + 60_000) : renewalRetryAt(now, failures), leaseUntil: null, leaseToken: null }); }
    catch (cause) { if (cause instanceof ClaimLost) return 'skipped'; throw cause; }
    await logAuditEvent({ action: 'ardent.hivemem.renew', actorId: SYSTEM_ACTOR, actorType: 'system', targetType: 'ardent-profile', targetId: target,
      details: { status: 'failed', agentId: row.agentId, error: text, failures, expiresAt: previousExpiresAt } });
    console.warn(`[ardent-hivemem] renewal of ${target} failed (${failures} in a row, expires ${previousExpiresAt}): ${text}`);
    await notifyFailure(row, text, now, recovery);
    return 'failed';
  }
}

/** Claim a due credential and re-read its current plan. Null when the snapshot or lease is stale. */
async function claim(row: Row, now: Date): Promise<Row | null> {
  const leaseToken = randomUUID();
  const db = getDb();
  const claimed = await db.ardentHiveMemCredential.updateMany({
    where: { id: row.id, updatedAt: row.updatedAt, recoveryRequired: false, nextAttemptAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
    data: { leaseToken, leaseUntil: new Date(now.getTime() + LEASE_MS), lastAttemptAt: now } });
  if (!claimed.count) return null;
  return db.ardentHiveMemCredential.findFirst({ where: { id: row.id, leaseToken } }) as Promise<Row | null>;
}

/**
 * Renew every due credential, one at a time. A profile with a New Agent or
 * Enable HiveMem operation running is left to that operation and checked again
 * on the next pass.
 */
export async function renewDueArdentHiveMemCredentials(): Promise<{ renewed: number; failed: number; untracked: number; skipped: number }> {
  const counts = { renewed: 0, failed: 0, untracked: 0, skipped: 0 };
  let settings: ArdentHiveMemSettings | null;
  try { settings = deps.settings(); }
  catch (error: unknown) { console.warn(`[ardent-hivemem] renewal skipped: ${message(error)}`); return counts; }
  if (!settings) return counts;
  const db = getDb();
  const now = deps.now();
  const due = await db.ardentHiveMemCredential.findMany({ where: { nextAttemptAt: { lte: now }, recoveryRequired: false }, orderBy: { expiresAt: 'asc' }, take: 100 }) as Row[];
  for (const row of due) {
    const running = await db.ardentAgentOperation.findFirst({ where: { nodeId: row.nodeId, profile: row.profile, status: 'running' }, select: { id: true } });
    const claimed = running ? null : await claim(row, now);
    if (!claimed) { counts.skipped++; continue; }
    counts[await renewClaimed(claimed, settings)]++;
  }
  return counts;
}

let timer: ReturnType<typeof setInterval> | null = null;
let pass: Promise<unknown> | null = null;
let adopted = false;

function runPass(): void {
  if (pass) return;
  // Earlier enrollments are adopted once per start; a profile untracked since then is not adopted again until a restart.
  const adopt = adopted ? Promise.resolve() : adoptEnrolledArdentProfiles().then(() => { adopted = true; });
  pass = adopt
    .catch((error: unknown) => console.warn(`[ardent-hivemem] adopting enrolled profiles failed: ${message(error)}`))
    .then(() => renewDueArdentHiveMemCredentials())
    .catch((error: unknown) => console.warn(`[ardent-hivemem] renewal pass failed: ${message(error)}`))
    .finally(() => { pass = null; });
}

/** Start the renewal job. It does nothing while HiveMem enrollment is not configured. */
export function startArdentHiveMemRenewal(): void {
  if (timer) return;
  runPass();
  timer = setInterval(runPass, RENEWAL_CHECK_INTERVAL_MS);
  timer.unref();
  console.log(`[ardent-hivemem] credential renewal started with ${RENEWAL_CHECK_INTERVAL_MS}ms interval`);
}

export async function stopArdentHiveMemRenewal(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await pass;
}

