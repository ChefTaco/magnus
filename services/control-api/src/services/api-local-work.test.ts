import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../middleware/error-handler.js';
const calls = vi.hoisted(() => ({ reserve: vi.fn(), start: vi.fn(), finish: vi.fn() }));
vi.mock('./control-host-node.js', () => ({ probeLocalAgent: vi.fn(async () => ({ verifiedTlsHostname: 'fixture.invalid' })) }));
vi.mock('./resource-participant-work.js', () => ({ apiParticipantWork: calls }));
import { ApiLocalWorkError, reserveApiLocalWork, withApiLocalWork } from './api-local-work.js';

describe('local work acknowledgment recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks(); calls.reserve.mockResolvedValue({ epoch: 0, barrierId: null });
    calls.start.mockResolvedValue({ state: 'running' }); calls.finish.mockResolvedValue({ state: 'unknown' });
  });
  it('retains the exact generated UUID when reservation acknowledgment is lost', async () => {
    calls.reserve.mockRejectedValue(new Error('Lost reservation acknowledgment'));
    const error = await reserveApiLocalWork('self-update-apply').catch(error => error);
    expect(error).toBeInstanceOf(ApiLocalWorkError);
    expect(error.workId).toBe(calls.reserve.mock.calls[0]![0].workId);
    expect(error.code).toBe('LOCAL_WORK_FAILED'); expect(calls.start).not.toHaveBeenCalled();
  });
  it('keeps pre-dispatch HTTP denials typed and lookupable without asserting a row exists', async () => {
    calls.reserve.mockRejectedValue(new HttpError(409, 'RESOURCE_DRAIN_REQUIRED', 'Draining'));
    const error = await reserveApiLocalWork('self-update-restart').catch(error => error);
    expect(error).toBeInstanceOf(ApiLocalWorkError);
    expect(error).toMatchObject({ status: 409, code: 'RESOURCE_DRAIN_REQUIRED', workId: calls.reserve.mock.calls[0]![0].workId });
  });
  it('keeps lost start acknowledgment unknown and never runs the operation', async () => {
    const work = await reserveApiLocalWork('self-update-check');
    calls.start.mockRejectedValue(new Error('Lost start acknowledgment'));
    const operation = vi.fn(async () => ({}));
    const error = await work.run(operation).catch(error => error);
    expect(error).toBeInstanceOf(ApiLocalWorkError); expect(error.workId).toBe(work.workId);
    expect(operation).not.toHaveBeenCalled();
    expect(calls.finish).toHaveBeenCalledWith(work.workId, expect.objectContaining({ disposition: 'not-started' }));
    // The authoritative finish service keeps committed running work unknown.
  });
  it('returns operation-failure identity even when settlement acknowledgment also fails', async () => {
    calls.finish.mockRejectedValue(new Error('Lost finish acknowledgment'));
    const error = await withApiLocalWork('self-update-apply', async () => { throw new Error('Build failed'); }).catch(error => error);
    expect(error).toBeInstanceOf(ApiLocalWorkError);
    expect(error.workId).toBe(calls.reserve.mock.calls[0]![0].workId); expect(error.message).toBe('Build failed');
    expect(calls.finish).toHaveBeenCalledWith(error.workId, expect.objectContaining({ disposition: 'unknown' }));
  });
});
