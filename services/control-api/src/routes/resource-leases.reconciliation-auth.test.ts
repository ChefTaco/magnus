import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error-handler.js';

const fixture = vi.hoisted(() => ({ reconcile: vi.fn(), historical: vi.fn(), inspectHistorical: vi.fn(), audit: vi.fn() }));
vi.mock('../middleware/user-status.js', () => ({
  getCurrentUserStatus: async (userId: string) => ({ active: true, role: userId.split('-').pop()!.toUpperCase() }),
  invalidateUserStatus: () => undefined,
}));
vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  JWT_SECRET: 'participant-route-jwt-fixture-at-least-32-characters',
  API_SECRET: 'participant-route-api-fixture-at-least-32-characters',
  IAM_CORE_URL: '', IAM_TOKEN_ISSUER: '', IAM_TOKEN_AUDIENCE: '',
}));
vi.mock('../services/resource-participant-work.js', async original => ({ ...await original<object>(),
  reconcileParticipantWork: fixture.reconcile,
  reconcileHistoricalParticipantWork: fixture.historical,
  inspectHistoricalParticipantWork: fixture.inspectHistorical,
}));
vi.mock('../services/audit-service.js', async original => ({ ...await original<object>(), logAuditEvent: fixture.audit }));

const { resourceLeasesRouter } = await import('./resource-leases.js');
const { signUserToken } = await import('../middleware/auth.js');
const app = new Hono().onError(errorHandler).route('/resource-leases', resourceLeasesRouter);
const workId = '1c538fc4-4d17-40c0-8d01-c30884ea32a4';
const body = { version: 1, workId, nodeId: 'node-fixture', nodeFqdn: 'fixture.invalid', participant: 'dashboard',
  ownerId: 'cd3078e3-a891-44dd-bb1c-32ce61b51e28', kind: 'hermes-http', epoch: 1, barrierId: null,
  operationSha256: 'd'.repeat(64), fence: '7', deadline: Date.now() + 600_000,
  requestSha256: 'a'.repeat(64), disposition: 'effects_verified', evidenceSha256: 'b'.repeat(64),
  approvalRef: 'telegram:approved', decisionId: 'decision-one', expiresAt: Date.now() + 60_000, signature: 'c'.repeat(64) };
const historicalBody = { version: 2, workId, nodeId: 'node-fixture', participant: 'dashboard', kind: 'hermes-http',
  recordSha256: 'a'.repeat(64), dashboardObservationSha256: 'b'.repeat(64), nodeObservationSha256: 'c'.repeat(64),
  operationAuditSha256: 'd'.repeat(64), observedAt: Date.now(),
  disposition: 'historical_descendants_absent_outcome_unknown', approvalRef: 'fixture:reviewed',
  decisionId: 'historical-one', expiresAt: Date.now() + 60_000, signature: 'e'.repeat(64) };

describe('participant reconciliation route authorization', () => {
  it('rejects anonymous, non-admin, malformed, and path-mismatched requests before reconciliation', async () => {
    const send = (authorization: string | undefined, value: unknown, id = workId) => app.request(`/resource-leases/enrollment/work/${id}/reconcile`, {
      method: 'POST', headers: { ...(authorization ? { authorization } : {}), 'content-type': 'application/json' }, body: JSON.stringify(value),
    });
    expect((await send(undefined, body)).status).toBe(401);
    const viewer = await signUserToken({ userId: 'fixture-viewer', username: 'fixture', role: 'VIEWER' });
    expect((await send(`Bearer ${viewer}`, body)).status).toBe(403);
    const admin = await signUserToken({ userId: 'fixture-admin', username: 'fixture', role: 'ADMIN' });
    expect((await send(`Bearer ${admin}`, { ...body, release: true })).status).toBe(400);
    expect((await send(`Bearer ${admin}`, body, 'aa5e1264-b97b-43f2-a561-c52485200336')).status).toBe(400);
    expect(fixture.reconcile).not.toHaveBeenCalled();
  });
  it('passes an exact admin request to reconciliation and audits only bounded evidence metadata', async () => {
    fixture.reconcile.mockResolvedValueOnce({ workId, state: 'released', requestSha256: body.requestSha256 });
    const admin = await signUserToken({ userId: 'fixture-admin', username: 'fixture', role: 'ADMIN' });
    const response = await app.request(`/resource-leases/enrollment/work/${workId}/reconcile`, { method: 'POST',
      headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    expect(fixture.reconcile).toHaveBeenCalledWith(body);
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'resource.participant.reconcile',
      targetId: workId, details: { nodeId: body.nodeId, participant: body.participant, kind: body.kind,
        disposition: body.disposition, decisionId: body.decisionId, evidenceSha256: body.evidenceSha256 } }));
  });
  it('restricts historical inspection and reconciliation to admins and exact bounded assertions', async () => {
    const viewer = await signUserToken({ userId: 'fixture-viewer', username: 'fixture', role: 'VIEWER' });
    const admin = await signUserToken({ userId: 'fixture-admin', username: 'fixture', role: 'ADMIN' });
    const path = `/resource-leases/enrollment/work/${workId}/historical`;
    expect((await app.request(path)).status).toBe(401);
    expect((await app.request(path, { headers: { authorization: `Bearer ${viewer}` } })).status).toBe(403);
    fixture.inspectHistorical.mockResolvedValueOnce({ recordSha256: historicalBody.recordSha256 });
    expect((await app.request(path, { headers: { authorization: `Bearer ${admin}` } })).status).toBe(200);
    const send = (value: unknown, id = workId) => app.request(`/resource-leases/enrollment/work/${id}/historical-reconcile`, {
      method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, body: JSON.stringify(value),
    });
    expect((await send({ ...historicalBody, arbitrary: true })).status).toBe(400);
    expect((await send(historicalBody, 'aa5e1264-b97b-43f2-a561-c52485200336')).status).toBe(400);
    fixture.historical.mockResolvedValueOnce({ workId, state: 'released' });
    expect((await send(historicalBody)).status).toBe(200);
    expect(fixture.historical).toHaveBeenCalledWith(historicalBody);
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'resource.participant.historical-reconcile', targetId: workId,
      details: expect.objectContaining({ recordSha256: historicalBody.recordSha256 }),
    }));
  });
});
