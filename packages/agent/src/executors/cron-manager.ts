import { Hono } from 'hono';
import { schedulerAuthority } from './scheduler-authority.js';
import { canonicalSchedulerEvidence, schedulerDrainRoutes } from './scheduler-drain.js';
import { schedulerInventory } from './scheduler-inventory.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ManagedScheduler, managedCronSchema, makeCronJob, schedulerSourceSettlementSchema,
  schedulerSourceSettlementSigningPayload, schedulerSourceSettlementReceiptPayload,
  cronEnrollmentStageSchema, cronEnrollmentStageSigningPayload, cronEnrollmentStageReceiptPayload,
  type ManagedCronJob } from './managed-scheduler.js';
import { hash } from './execution-supervisor-state.js';
import { HOST_FQDN, NODE_MANAGER_SECRET, RESULT_SIGNING_SECRET } from '../env.js';
import { readdir, readFile } from 'node:fs/promises';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const cronRoutes = new Hono();

const scheduler = new ManagedScheduler();
const execFileAsync = promisify(execFile);
const managedCronIdentitySchema = z.object({
  nodeFqdn: z.string().min(1).max(253),
  name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  jobId: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().positive().max(2147483647),
  specSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
async function currentCrontab(): Promise<string> {
  try { return (await execFileAsync('crontab', ['-l'], { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout; }
  catch (error) {
    const value = error as { code?: number; stderr?: string };
    if (value.code === 1 && /no crontab for/i.test(value.stderr ?? '')) return '';
    throw new Error('Existing crontab could not be read; preserving it');
  }
}
/** Write only after a private immutable managed definition exists. */
async function writeCrontab(content: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile('crontab', ['-'], { timeout: 5000 }, error => error ? reject(error) : resolve());
    child.stdin?.end(content);
  });
}
export function removeCronEntry(raw: string, name: string): string {
  const lines = raw.split('\n'); const result: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] === '# MAGNUS:' + name) {
      // Only the immediate cron entry is owned; never discard an unrelated line.
      if (/^\s*(?:\S+\s+){5}\S/.test(lines[index + 1] ?? '') && !lines[index + 1]?.startsWith('#')) index++;
    } else result.push(lines[index]!);
  }
  return result.join('\n');
}
export function managedCronLine(job: ManagedCronJob, nodePath = process.execPath,
  runnerPath = fileURLToPath(new URL('./scheduler-runner.js', import.meta.url))): string {
  for (const path of [nodePath, runnerPath]) if (!path.startsWith('/') || /[\x00-\x1f\x7f%]/.test(path)) throw new Error('Unsafe fixed cron runner path');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  // Wake every minute; the runner verifies the explicit UTC schedule itself.
  return `* * * * * /usr/bin/env -i PATH=/usr/bin:/bin ${quote(nodePath)} ${quote(runnerPath)} trigger ${job.jobId} ${job.spec.revision} >/dev/null 2>&1`;
}
export function exactManagedEntry(raw: string, name: string, expected?: string): boolean {
  const lines = raw.split('\n'); let matches = 0;
  for (let index = 0; index < lines.length; index++) if (lines[index] === '# MAGNUS:' + name) {
    matches++;
    if (expected !== undefined && lines[index + 1] !== expected) return false;
  }
  return expected === undefined ? matches === 0 : matches === 1 && lines.filter(line => line === expected).length === 1;
}
export function managedCronEntryAbsent(raw: string, job: ManagedCronJob): boolean {
  const token = ` trigger ${job.jobId} ${job.spec.revision} `;
  return exactManagedEntry(raw, job.spec.name) && !raw.split('\n').some(line => line.includes(token));
}

cronRoutes.route('/', schedulerDrainRoutes({ scheduler, inventory: { wrapper: managedCronLine } }));

export const OS_SCHEDULER_WRITER_DOMAIN = 'magnus.os-scheduler-writer.v1\n';
const writerProofRequest = z.object({ nodeFqdn: z.string().min(1).max(253), nonce: z.string().guid() }).strict();

// This proves only the OS scheduler boundary. Native Hermes and channel writers
// require their own owner receipts even when this complete inventory is clear.
cronRoutes.get('/os-scheduler-writer-proof', async c => {
  const request = writerProofRequest.safeParse(c.req.query());
  if (!request.success || request.data.nodeFqdn !== HOST_FQDN || RESULT_SIGNING_SECRET.length < 32
    || RESULT_SIGNING_SECRET === NODE_MANAGER_SECRET)
    return c.json({ success: false, error: { code: 'WRITER_PROOF_INVALID' } }, 409);
  try {
    const first = await schedulerInventory({ scheduler, wrapper: managedCronLine });
    const observed = await schedulerInventory({ scheduler, wrapper: managedCronLine });
    if (canonicalSchedulerEvidence(first) !== canonicalSchedulerEvidence(observed)
      || !observed.barrier || observed.barrier.nodeFqdn !== HOST_FQDN
      || !observed.supported || !observed.quiescent || observed.activeCount !== 0 || observed.unknownCount !== 0
      || observed.blockers.length !== 0 || observed.issues.length !== 0)
      throw new Error('Scheduler source or admission remains unverified');
    const identity = observed.barrier;
    const receipt = { version: 1 as const, sourceClass: 'os-schedulers' as const,
      ...identity, nonce: request.data.nonce, observedAt: Date.now(), active: observed.activeCount,
      unknown: observed.unknownCount,
      scheduleInventorySha256: createHash('sha256').update(canonicalSchedulerEvidence(observed)).digest('hex'),
      admissionFenceSha256: createHash('sha256').update(canonicalSchedulerEvidence({
        sourceClass: 'os-schedulers', ...identity })).digest('hex') };
    const signature = createHmac('sha256', RESULT_SIGNING_SECRET)
      .update(OS_SCHEDULER_WRITER_DOMAIN + canonicalSchedulerEvidence(receipt)).digest('hex');
    c.header('Cache-Control', 'no-store');
    return c.json({ success: true, data: { ...receipt, signature } });
  } catch { return c.json({ success: false, error: { code: 'WRITER_PROOF_UNAVAILABLE' } }, 409); }
});

// ── List crontab entries ──
cronRoutes.get('/', async (c) => {
  try {
    const crontab = await currentCrontab();
    const jobs = parseCrontab(crontab);
    return c.json({ success: true, data: jobs });
  } catch {
    return c.json({ success: true, data: [] });
  }
});

// ── List crontab entries for ALL system users ──
cronRoutes.get('/all-users', async (c) => {
  const CRONTAB_DIR = '/var/spool/cron/crontabs';
  const allJobs: Array<{ user: string; name: string; schedule: string; command: string }> = [];

  try {
    const files = await readdir(CRONTAB_DIR).catch(() => [] as string[]);

    for (const user of files) {
      // Skip hidden files and non-user entries
      if (user.startsWith('.')) continue;

      try {
        const raw = await readFile(`${CRONTAB_DIR}/${user}`, 'utf-8');
        const jobs = parseCrontab(raw);
        for (const job of jobs) {
          allJobs.push({ user, ...job });
        }
      } catch {
        // Skip users whose crontab we can't read
      }
    }

    return c.json({ success: true, data: allJobs });
  } catch {
    return c.json({ success: true, data: [] });
  }
});

// Read-only inventory exposes hashes/counts, never commands or environment values.
cronRoutes.get('/managed-inventory', async c => {
  return c.json({ success: true, data: await schedulerInventory({ scheduler, wrapper: managedCronLine }) });
});

// Pre-drain conversion control message. It can only remove a same-name wake-up
// and persist a disabled definition; activation is a separate enrolled action.
cronRoutes.post('/enrollment-stage', async c => {
  const parsed = cronEnrollmentStageSchema.safeParse(await c.req.json().catch(() => null));
  const secret = process.env['COMMAND_RECONCILIATION_SECRET'] ?? '';
  const conflicting = [NODE_MANAGER_SECRET, process.env['NODE_MANAGER_SECRET_PREVIOUS'] ?? '', RESULT_SIGNING_SECRET,
    process.env['RESULT_SIGNING_PREVIOUS_SECRET'] ?? ''];
  if (!parsed.success || parsed.data.nodeFqdn !== HOST_FQDN || parsed.data.spec.nodeFqdn !== HOST_FQDN
    || parsed.data.expiresAt <= Date.now() || parsed.data.expiresAt > Date.now() + 300_000 || secret.length < 32
    || conflicting.some(value => value && value === secret))
    return c.json({ success: false, error: { code: 'CRON_ENROLLMENT_STAGE_INVALID' } }, 403);
  const { signature, ...assertion } = parsed.data;
  const expected = createHmac('sha256', secret).update(cronEnrollmentStageSigningPayload(assertion)).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
    return c.json({ success: false, error: { code: 'CRON_ENROLLMENT_STAGE_INVALID' } }, 403);
  try {
    const job = makeCronJob(parsed.data.spec);
    await scheduler.locked(async () => {
      await scheduler.assertOpen(false);
      await scheduler.saveJob({ ...job, enabled: false });
      await writeCrontab(removeCronEntry(await currentCrontab(), job.spec.name));
      if (!managedCronEntryAbsent(await currentCrontab(), job)) throw new Error('Legacy wake-up remains');
    });
    const receipt = { nodeFqdn: HOST_FQDN, name: job.spec.name, jobId: job.jobId, revision: job.spec.revision,
      specSha256: job.specSha256, operationId: parsed.data.operationId, staged: true as const, enabled: false as const };
    return c.json({ success: true, data: { ...receipt, receiptSignature: createHmac('sha256', RESULT_SIGNING_SECRET)
      .update(cronEnrollmentStageReceiptPayload(receipt)).digest('hex') } });
  } catch {
    return c.json({ success: false, error: { code: 'CRON_ENROLLMENT_STAGE_CONFLICT' } }, 409);
  }
});

cronRoutes.get('/source-reconciliation/:decisionId', async c => {
  try {
    const receipt = await scheduler.settlementReceipt(c.req.param('decisionId'));
    if (!receipt) return c.json({ success: false, error: { code: 'SCHEDULER_RECONCILIATION_NOT_FOUND' } }, 404);
    c.header('Cache-Control', 'no-store');
    return c.json({ success: true, data: receipt });
  } catch { return c.json({ success: false, error: { code: 'SCHEDULER_RECONCILIATION_NOT_FOUND' } }, 404); }
});

// This is evidence reconciliation during enrollment, never scheduler execution
// or permission to modify a foreign source. The separately provisioned signer
// and exact retained source/barrier are both required.
cronRoutes.post('/source-reconciliation', async c => {
  const parsed = schedulerSourceSettlementSchema.safeParse(await c.req.json().catch(() => null));
  const secret = process.env['COMMAND_RECONCILIATION_SECRET'] ?? '';
  const conflicting = [NODE_MANAGER_SECRET, process.env['NODE_MANAGER_SECRET_PREVIOUS'] ?? '', RESULT_SIGNING_SECRET,
    process.env['RESULT_SIGNING_PREVIOUS_SECRET'] ?? ''];
  if (!parsed.success || parsed.data.nodeFqdn !== HOST_FQDN || secret.length < 32
    || conflicting.some(value => value && value === secret))
    return c.json({ success: false, error: { code: 'SCHEDULER_RECONCILIATION_INVALID' } }, 403);
  const { signature, ...assertion } = parsed.data;
  const expected = createHmac('sha256', secret).update(schedulerSourceSettlementSigningPayload(assertion)).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
    return c.json({ success: false, error: { code: 'SCHEDULER_RECONCILIATION_INVALID' } }, 403);
  try {
    const retained = await scheduler.settlementReceipt(parsed.data.decisionId);
    if (retained) {
      if (!('sourceIdentityVersion' in retained)
        || schedulerSourceSettlementSigningPayload(retained) !== schedulerSourceSettlementSigningPayload(assertion))
        throw new Error('Scheduler settlement decision was reused');
      c.header('Cache-Control', 'no-store'); return c.json({ success: true, data: retained });
    }
    if (parsed.data.expiresAt <= Date.now() || parsed.data.expiresAt > Date.now() + 300_000)
      return c.json({ success: false, error: { code: 'SCHEDULER_RECONCILIATION_INVALID' } }, 403);
    const settled = await scheduler.settleForeignSource(parsed.data, receipt => createHmac('sha256', RESULT_SIGNING_SECRET)
      .update(schedulerSourceSettlementReceiptPayload(receipt)).digest('hex'));
    c.header('Cache-Control', 'no-store'); return c.json({ success: true, data: settled.receipt });
  } catch {
    return c.json({ success: false, error: { code: 'SCHEDULER_RECONCILIATION_CONFLICT' } }, 409);
  }
});

// ── Sync (add/update) a cron job by name ──
const legacyCronSchema = z.object({ name: z.string().min(1).max(128).regex(/^[^\n\r\x00]+$/),
  schedule: z.string().min(9).max(64).regex(/^(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)$/),
  command: z.string().min(1).regex(/^[^\n\r\x00]+$/), args: z.array(z.string().regex(/^[^\n\r\x00]+$/)).default([]) });
// Compatibility only. The existing mutation guard admits this on legacy nodes;
// it is deliberately excluded from reviewed managed HTTP paths and drain proof.
cronRoutes.post('/sync', async c => {
  const parsed = legacyCronSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: { code: 'VALIDATION_ERROR' } }, 400);
  const job = parsed.data;
  try {
    await scheduler.locked(async () => {
      await scheduler.assertOpen();
      const current = await currentCrontab();
      const existing = await scheduler.job(hash(JSON.stringify([HOST_FQDN, job.name])));
      if (existing) throw new Error('Managed jobs cannot fall back to raw scheduling');
      const kept = removeCronEntry(current, job.name).trimEnd();
      await writeCrontab((kept ? kept + '\n' : '') + '# MAGNUS:' + job.name + '\n' + job.schedule + ' ' + job.command + (job.args.length ? ' ' + job.args.join(' ') : '') + '\n');
    });
    return c.json({ success: true, data: { name: job.name, schedule: job.schedule, command: job.command, synced: true, managed: false } });
  } catch { return c.json({ success: false, error: { code: 'CRON_SYNC_ERROR' } }, 500); }
});

cronRoutes.post('/managed-sync', async (c) => {
  const parsed = managedCronSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || parsed.data.nodeFqdn !== HOST_FQDN) return c.json({ success: false, error: { code: 'MANAGED_SCHEDULER_SPEC_REQUIRED',
    message: 'Explicit revision, UTC schedule, finite timeout and absolute expiry are required' } }, 400);
  try {
    const job = makeCronJob(parsed.data);
    await scheduler.confirmEnrollment(schedulerAuthority());
    await scheduler.locked(async () => {
      const crontab = await currentCrontab();
      // Staging removes any same-name legacy wake-up and records only a disabled
      // definition. No executable wrapper exists until exact activation.
      await scheduler.saveJob({ ...job, enabled: false });
      const kept = removeCronEntry(crontab, job.spec.name).trimEnd();
      await writeCrontab(kept ? kept + '\n' : '');
      const installed = await currentCrontab();
      const stored = await scheduler.job(job.jobId);
      if (!managedCronEntryAbsent(installed, job) || !stored || stored.enabled
        || stored.spec.revision !== job.spec.revision || stored.specSha256 !== job.specSha256)
        throw new Error('Managed cron staging acknowledgement differs');
    });
    return c.json({ success: true, data: { nodeFqdn: HOST_FQDN, name: job.spec.name, jobId: job.jobId,
      revision: job.spec.revision, specSha256: job.specSha256, staged: true, enabled: false } });
  } catch {
    return c.json({ success: false, error: { code: 'CRON_SYNC_ERROR', message: 'Managed cron installation incomplete; inspect durable definition before retry' } }, 500);
  }
});

cronRoutes.post('/managed-activate', async c => {
  const parsed = managedCronIdentitySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || parsed.data.nodeFqdn !== HOST_FQDN)
    return c.json({ success: false, error: { code: 'MANAGED_SCHEDULER_IDENTITY_REQUIRED' } }, 400);
  try {
    await scheduler.confirmEnrollment(schedulerAuthority());
    await scheduler.locked(async () => {
      await scheduler.assertOpen(true);
      const job = await scheduler.job(parsed.data.jobId);
      if (!job || job.spec.name !== parsed.data.name || job.spec.revision !== parsed.data.revision
        || job.specSha256 !== parsed.data.specSha256 || job.enabled)
        throw new Error('Managed cron staged identity differs');
      const line = managedCronLine(job); const kept = removeCronEntry(await currentCrontab(), job.spec.name).trimEnd();
      await writeCrontab((kept ? kept + '\n' : '') + '# MAGNUS:' + job.spec.name + '\n' + line + '\n');
      if (!exactManagedEntry(await currentCrontab(), job.spec.name, line)) throw new Error('Managed cron activation readback differs');
      await scheduler.setEnabled(parsed.data, true);
    });
    return c.json({ success: true, data: { ...parsed.data, activated: true, enabled: true } });
  } catch {
    return c.json({ success: false, error: { code: 'CRON_ACTIVATION_ERROR', message: 'Managed cron activation was not acknowledged' } }, 500);
  }
});

cronRoutes.post('/managed-revoke', async c => {
  const parsed = managedCronIdentitySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || parsed.data.nodeFqdn !== HOST_FQDN)
    return c.json({ success: false, error: { code: 'MANAGED_SCHEDULER_IDENTITY_REQUIRED' } }, 400);
  try {
    await scheduler.locked(async () => {
      const job = await scheduler.job(parsed.data.jobId);
      if (!job || job.spec.name !== parsed.data.name || job.spec.revision !== parsed.data.revision
        || job.specSha256 !== parsed.data.specSha256) throw new Error('Managed cron revocation identity differs');
      // Disable durable authority before removing the wake-up line. A crash at
      // either boundary leaves execution denied and permits an exact retry.
      await scheduler.setEnabled(parsed.data, false);
      await writeCrontab(removeCronEntry(await currentCrontab(), job.spec.name));
      if (!managedCronEntryAbsent(await currentCrontab(), job)) throw new Error('Managed cron revocation readback differs');
    });
    return c.json({ success: true, data: { ...parsed.data, revoked: true, enabled: false } });
  } catch {
    return c.json({ success: false, error: { code: 'CRON_REVOCATION_ERROR', message: 'Managed cron revocation was not acknowledged' } }, 500);
  }
});

cronRoutes.delete('/:name', async c => {
  const name = c.req.param('name');
  if (!/^[^\n\r\x00]{1,128}$/.test(name)) return c.json({ success: false, error: { code: 'INVALID_CRON_NAME' } }, 400);
  try {
    await scheduler.locked(async () => {
      const crontab = await currentCrontab();
      await scheduler.disable(hash(JSON.stringify([HOST_FQDN, name])));
      await writeCrontab(removeCronEntry(crontab, name));
    });
    return c.json({ success: true, data: { deleted: true } });
  } catch { return c.json({ success: false, error: { code: 'CRON_DELETE_ERROR' } }, 500); }
});

/**
 * Parse crontab output into structured job objects.
 *
 * Recognises `# MAGNUS:<name>` comment markers placed immediately before a cron
 * entry to provide a human-readable name. Entries without a marker are named by
 * truncating the command to 40 characters.
 *
 * @param raw - Raw string output from `crontab -l`.
 * @returns Array of parsed jobs, each with `name`, `schedule` (5-field cron expression),
 *   and `command` (the command to run).
 */
export function parseCrontab(raw: string): Array<{ name: string; schedule: string; command: string }> {
  const lines = raw.split('\n').filter(Boolean);
  const jobs: Array<{ name: string; schedule: string; command: string }> = [];
  let pendingName: string | null = null;

  for (const line of lines) {
    const nameMatch = line.match(/^# MAGNUS:(.+)$/);
    if (nameMatch?.[1]) {
      pendingName = nameMatch[1];
      continue;
    }

    if (line.startsWith('#') || line.trim() === '') continue;

    const parts = line.trim().split(/\s+/);
    if (parts.length >= 6) {
      const schedule = parts.slice(0, 5).join(' ');
      const command = parts.slice(5).join(' ');
      jobs.push({
        name: pendingName ?? command.slice(0, 40),
        schedule,
        command,
      });
      pendingName = null;
    }
  }

  return jobs;
}
