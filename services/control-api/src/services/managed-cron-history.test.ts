import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../db/generated/prisma/client.js';
import type { ManagedCronOccurrence, RemoteCommand, CommandResult, CommandResourceLease } from '../db/generated/prisma/client.js';

const fixture = vi.hoisted(() => ({ rows: [] as unknown[], commands: [] as unknown[], leases: [] as unknown[],
  latest: vi.fn(), detail: vi.fn(), commandQuery: vi.fn(), leaseQuery: vi.fn() }));
vi.mock('../db/index.js', () => ({ Prisma, getDb: () => ({ $queryRaw: fixture.latest,
  managedCronOccurrence: { findMany: fixture.detail }, remoteCommand: { findMany: fixture.commandQuery },
  commandResourceLease: { findMany: fixture.leaseQuery } }) }));
const { managedCronExecution, readManagedCronHistory } = await import('./managed-cron-history.js');
const scheduledAt = new Date('2030-01-01T00:00:00Z');
const row = { id: 'occurrence-1', cronJobId: 'job-1', nodeId: 'node-1', commandId: 'command-1', revision: 1,
  specSha256: 'a'.repeat(64), scheduledAt, deadline: new Date('2030-01-01T00:01:00Z'), state: 'completed',
  admissionJson: 'private-authority-never-returned', createdAt: scheduledAt } satisfies ManagedCronOccurrence;
const result = { id: 'result-1', commandId: row.commandId, exitCode: 0, stdout: 'fixture-ok', stderr: '', durationMs: 3, truncated: false } satisfies CommandResult;
const command = { id: row.commandId, nodeId: row.nodeId, status: 'COMPLETED', startedAt: scheduledAt,
  completedAt: new Date('2030-01-01T00:00:03Z'), result } satisfies Pick<RemoteCommand, 'id' | 'nodeId' | 'status' | 'startedAt' | 'completedAt'> & { result: CommandResult };
const lease = { commandId: row.commandId, nodeId: row.nodeId, state: 'released', settlement: 'signed-command-result',
  completionClass: 'managed-scheduler', completionOccurrenceId: row.id, completionSpecSha256: row.specSha256 } satisfies
  Pick<CommandResourceLease, 'commandId' | 'nodeId' | 'state' | 'settlement' | 'completionClass' | 'completionOccurrenceId' | 'completionSpecSha256'>;

beforeEach(() => {
  vi.clearAllMocks(); fixture.rows = [row]; fixture.commands = [command]; fixture.leases = [lease];
  fixture.latest.mockImplementation(async () => fixture.rows); fixture.detail.mockImplementation(async () => fixture.rows);
  fixture.commandQuery.mockImplementation(async () => fixture.commands); fixture.leaseQuery.mockImplementation(async () => fixture.leases);
});
describe('managed cron execution views', () => {
  it('reports existing signed scheduler completions without creating legacy executions', async () => {
    const history = await readManagedCronHistory([{ id: row.cronJobId, nodeId: row.nodeId }]);
    expect(history.get(row.cronJobId)?.[0]).toEqual({ id: row.id, cronJobId: row.cronJobId, nodeId: row.nodeId,
      startedAt: scheduledAt, completedAt: command.completedAt, exitCode: 0, stdout: 'fixture-ok', stderr: '', durationMs: 3 });
    expect(JSON.stringify([...history])).not.toContain('private-authority');
    expect(fixture.latest).toHaveBeenCalledOnce(); expect(fixture.detail).not.toHaveBeenCalled();
  });
  it('does not claim success or expose output for uncertain or mismatched evidence', () => {
    const cases = [managedCronExecution({ ...row, state: 'unknown' }, command, lease),
      managedCronExecution(row, { ...command, nodeId: 'another-node' }, lease),
      managedCronExecution(row, { ...command, id: 'another-command' }, lease),
      managedCronExecution(row, { ...command, result: null }, lease),
      managedCronExecution(row, { ...command, status: 'RUNNING' }, lease),
      managedCronExecution(row, { ...command, completedAt: null }, lease),
      managedCronExecution(row, command),
      ...[{ state: 'unknown' }, { nodeId: 'another-node' }, { completionClass: 'native-http' },
        { completionOccurrenceId: 'another-occurrence' }, { completionSpecSha256: 'b'.repeat(64) },
        { settlement: 'signed-reconciliation:no_effect_verified' }].map(patch => managedCronExecution(row, command, { ...lease, ...patch }))];
    for (const value of cases) expect(value).toMatchObject({ completedAt: null, exitCode: null, stdout: '', stderr: '', durationMs: null });
  });
  it('reports nonzero failures with the same verified authority', () => {
    expect(managedCronExecution(row, { ...command, status: 'FAILED', result: { ...result, exitCode: 7, stderr: 'fixture-failure' } }, lease))
      .toMatchObject({ exitCode: 7, stderr: 'fixture-failure' });
  });
  it('uses scheduled order across revisions and bounds detail to ten executions', async () => {
    fixture.rows = [{ ...row, id: 'newer', state: 'running', revision: 2, commandId: 'new-command', scheduledAt: new Date('2030-01-01T00:02:00Z') }, row];
    const history = await readManagedCronHistory([{ id: row.cronJobId, nodeId: row.nodeId }], true);
    expect(history.get(row.cronJobId)?.map(value => value.exitCode)).toEqual([null, 0]);
    expect(fixture.detail).toHaveBeenCalledWith({ where: { cronJobId: row.cronJobId, nodeId: row.nodeId },
      orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }], take: 10 });
    expect(fixture.latest).not.toHaveBeenCalled();
  });
  it('batches command evidence and excludes rows for another job or node', async () => {
    fixture.rows = [row, { ...row, cronJobId: 'another-job' }, { ...row, nodeId: 'another-node' }];
    const history = await readManagedCronHistory([{ id: row.cronJobId, nodeId: row.nodeId }]);
    expect(history.get(row.cronJobId)).toHaveLength(1); expect(history.size).toBe(1);
    expect(fixture.commandQuery).toHaveBeenCalledOnce(); expect(fixture.leaseQuery).toHaveBeenCalledOnce();
    expect(fixture.latest.mock.calls[0]![0].text).toContain('DISTINCT ON');
  });
  it('leaves legacy-only lists untouched without querying the occurrence ledger', async () => {
    expect((await readManagedCronHistory([])).size).toBe(0); expect(fixture.latest).not.toHaveBeenCalled();
  });
});
