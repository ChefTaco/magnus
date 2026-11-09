import { describe, expect, it, vi } from 'vitest';
import { managedShell } from './managed-shell.js';
import { createResourceParticipant } from './participant.js';
import { managedTerminalOperation } from '@hivemagnus/magnus-contracts';
import { createHash, randomUUID } from 'node:crypto';

describe('enrolled terminal transport', () => {
  it('carries I/O, resize and close only through the fixed owner-bound node relay', async () => {
    const request = vi.fn(async (_path, input) => input.operation.action === 'read'
      ? { state: 'running', dataBase64: Buffer.from('fixture output').toString('base64') } : { state: 'running' });
    const workId = randomUUID(); const ownerId = randomUUID(); const channel = await managedShell(workId, ownerId, { cols: 100, rows: 30 }, request);
    const data = new Promise<string>(resolve => channel.onData(value => resolve(value.toString())));
    channel.write('fixture input\n'); channel.resize({ cols: 111, rows: 44 });
    expect(await data).toBe('fixture output'); channel.terminate();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('/terminal/' + workId, { ownerId, operation: { action: 'close' } }));
    expect(request.mock.calls.every(([path, input]) => path === '/terminal/' + workId && input.ownerId === ownerId)).toBe(true);
  });
  it('binds a managed reservation to the shared operation contract', async () => {
    const ownerId = randomUUID(); let record: Record<string, unknown>;
    const request = vi.fn(async (path, body: Record<string, unknown>) => {
      if (path === '/work/reserve') { record = { ...body, nodeId: 'fixture', nodeFqdn: body.host, participant: 'dashboard',
        epoch: 1, barrierId: randomUUID(), state: 'reserved', requestSha256: 'a'.repeat(64), fence: '1' }; return record; }
      return { ...record, ...body, workId: record.workId, state: 'running' };
    });
    const result = await createResourceParticipant('fixture', request, ownerId).begin('node-1.example.com', 'fixture', 60000, true);
    const reservation = request.mock.calls[0]![1];
    expect(reservation.operationSha256).toBe(createHash('sha256').update(managedTerminalOperation({
      workId: result.workId, ownerId, host: 'node-1.example.com' })).digest('hex'));
    expect(result.ownerId).toBe(ownerId);
  });
});
