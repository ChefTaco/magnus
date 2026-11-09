/** Read the canonical occurrence ledger; never fabricate or backfill execution receipts. */
import { getDb, Prisma } from '../db/index.js';
import type { ManagedCronOccurrence, RemoteCommand, CommandResult, CommandResourceLease } from '../db/generated/prisma/client.js';

type JobIdentity = { id: string; nodeId: string };
type HistoryCommand = Pick<RemoteCommand, 'id' | 'nodeId' | 'status' | 'startedAt' | 'completedAt'> & { result: CommandResult | null };
type HistoryLease = Pick<CommandResourceLease, 'commandId' | 'nodeId' | 'state' | 'settlement' | 'completionClass' | 'completionOccurrenceId' | 'completionSpecSha256'>;

export function managedCronExecution(row: ManagedCronOccurrence, command?: HistoryCommand, lease?: HistoryLease) {
  const matched = command?.id === row.commandId && command.nodeId === row.nodeId;
  const completed = matched && row.state === 'completed' && command.completedAt !== null && command.result !== null
    && command.result.commandId === row.commandId
    && command.status === (command.result.exitCode === 0 ? 'COMPLETED' : 'FAILED')
    && lease?.commandId === row.commandId && lease.nodeId === row.nodeId && lease.state === 'released'
    && lease.settlement === 'signed-command-result' && lease.completionClass === 'managed-scheduler'
    && lease.completionOccurrenceId === row.id && lease.completionSpecSha256 === row.specSha256;
  return { id: row.id, cronJobId: row.cronJobId, nodeId: row.nodeId,
    startedAt: matched ? command.startedAt ?? row.scheduledAt : row.scheduledAt,
    completedAt: completed ? command.completedAt : null, exitCode: completed ? command.result!.exitCode : null,
    stdout: completed ? command.result!.stdout : '', stderr: completed ? command.result!.stderr : '',
    durationMs: completed ? command.result!.durationMs : null };
}

/** One batched latest-occurrence query for the list, ten ordered rows for a detail. */
export async function readManagedCronHistory(jobs: JobIdentity[], detail = false) {
  const history = new Map<string, ReturnType<typeof managedCronExecution>[]>();
  if (!jobs.length) return history;
  const db = getDb();
  const rows = detail
    ? await db.managedCronOccurrence.findMany({ where: { cronJobId: jobs[0]!.id, nodeId: jobs[0]!.nodeId },
      orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }], take: 10 })
    : await db.$queryRaw<ManagedCronOccurrence[]>(Prisma.sql`
      SELECT DISTINCT ON ("cronJobId", "nodeId") * FROM managed_cron_occurrences
      WHERE ("cronJobId", "nodeId") IN (VALUES ${Prisma.join(jobs.map(job => Prisma.sql`(${job.id}, ${job.nodeId})`))})
      ORDER BY "cronJobId", "nodeId", "scheduledAt" DESC, id DESC`);
  const ids = rows.map(row => row.commandId);
  if (!ids.length) return history;
  const [commands, leases] = await Promise.all([
    db.remoteCommand.findMany({ where: { id: { in: ids } }, select: {
      id: true, nodeId: true, status: true, startedAt: true, completedAt: true, result: true } }),
    db.commandResourceLease.findMany({ where: { commandId: { in: ids } }, select: {
      commandId: true, nodeId: true, state: true, settlement: true, completionClass: true,
      completionOccurrenceId: true, completionSpecSha256: true } }),
  ]);
  const commandById = new Map(commands.map(command => [command.id, command]));
  const leaseById = new Map(leases.map(lease => [lease.commandId, lease]));
  for (const row of rows) {
    if (!jobs.some(job => job.id === row.cronJobId && job.nodeId === row.nodeId)) continue;
    const executions = history.get(row.cronJobId) ?? [];
    executions.push(managedCronExecution(row, commandById.get(row.commandId), leaseById.get(row.commandId)));
    history.set(row.cronJobId, executions);
  }
  return history;
}
