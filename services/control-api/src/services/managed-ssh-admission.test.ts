import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ enabled: false, lease: vi.fn(), enrollment: vi.fn(), nodes: vi.fn(), fence: vi.fn() }));
vi.mock('../db/index.js', () => ({ getDb: () => ({ commandResourceLease: { findFirst: mock.lease }, resourceEnrollment: { findFirst: mock.enrollment },
  admissionFence: { findFirst: mock.fence, findUnique: mock.fence }, node: { findMany: mock.nodes } }) }));
vi.mock('./command-resource-leases.js', () => ({ resourceLeasesRequested: () => mock.enabled }));
const { assertUnenrolledSshTarget } = await import('./managed-ssh-admission.js');
beforeEach(() => { mock.enabled = false; mock.lease.mockReset(); mock.nodes.mockReset(); mock.enrollment.mockReset().mockResolvedValue(null); mock.fence.mockReset().mockResolvedValue(null); });
describe('managed SSH enrollment guard', () => {
  it('preserves default-off unenrolled legacy targets', async () => {
    mock.lease.mockResolvedValue(null); await assertUnenrolledSshTarget('fixture.lab'); expect(mock.nodes).not.toHaveBeenCalled();
  });
  it('blocks new sessions while enrollment is enabled before inventory lookup', async () => {
    mock.enabled = true; await expect(assertUnenrolledSshTarget('fixture.lab')).rejects.toMatchObject({ status: 409 }); expect(mock.lease).not.toHaveBeenCalled();
  });
  it('cannot bypass sticky enrollment after the flag is disabled', async () => {
    mock.lease.mockResolvedValue({ id: 'history' }); mock.nodes.mockResolvedValue([{ id: 'fixture' }]);
    await expect(assertUnenrolledSshTarget('fixture.lab')).rejects.toMatchObject({ status: 409 });
  });
  it.each([{ nodes: [] }, { nodes: [{ id: 'one' }, { id: 'two' }] }])('rejects unknown or ambiguous aliases once any node is enrolled', async ({ nodes }) => {
    mock.lease.mockResolvedValue({ id: 'history' }); mock.nodes.mockResolvedValue(nodes);
    await expect(assertUnenrolledSshTarget('alias.lab')).rejects.toMatchObject({ status: 409 });
  });
  it('allows an exact identified unenrolled target despite unrelated enrollment', async () => {
    mock.lease.mockResolvedValueOnce({ id: 'other' }).mockResolvedValueOnce(null); mock.nodes.mockResolvedValue([{ id: 'fixture' }]);
    await assertUnenrolledSshTarget('fixture.lab'); expect(mock.lease.mock.calls[1]?.[0]).toEqual({ where: { nodeId: 'fixture' }, select: { id: true } });
  });
  it('denies an exact target with a release API admission fence', async () => {
    mock.lease.mockResolvedValue(null); mock.fence.mockResolvedValue({ nodeId: 'fixture' }); mock.nodes.mockResolvedValue([{ id: 'fixture' }]);
    await expect(assertUnenrolledSshTarget('fixture.lab')).rejects.toMatchObject({ status: 409 });
  });
});
