import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ updateMany: vi.fn(), findUnique: vi.fn() }));
vi.mock('../db/index.js', () => ({ getDb: () => ({ commandResourceLease: fixture }) }));
const { correlateSkillPublicationNoEffect, isSkillPublicationNoEffectSettlement } =
  await import('./skill-publication-settlement.js');

const exact = { success: false as const,
  error: { code: 'SKILL_PUBLICATION_NOT_COMMITTED' as const, message: 'No visible version' },
  data: { skillName: 'maps', version: '2.0.0', bundleSha256: '2'.repeat(64),
    commandId: 'skill-command', requestSha256: '4'.repeat(64), effect: 'none' as const } };

describe('signed skill no-effect settlement', () => {
  beforeEach(() => { vi.clearAllMocks(); fixture.updateMany.mockResolvedValue({ count: 1 }); });

  it('correlates only the exact typed no-effect response after generic signed settlement', async () => {
    await correlateSkillPublicationNoEffect({ commandId: 'skill-command', requestSha256: '4'.repeat(64),
      skillName: 'maps', version: '2.0.0', bundleSha256: '2'.repeat(64), responseBody: JSON.stringify(exact) });
    const mutation = fixture.updateMany.mock.calls[0]![0];
    expect(mutation.where).toEqual({ commandId: 'skill-command', requestSha256: '4'.repeat(64),
      state: 'released', settlement: 'signed-command-result' });
    expect(isSkillPublicationNoEffectSettlement(mutation.data.settlement)).toBe(true);
  });

  it.each([
    { ...exact, error: { ...exact.error, code: 'CONFLICT' } },
    { ...exact, data: { ...exact.data, commandId: 'another-command' } },
    { ...exact, data: { ...exact.data, effect: 'unknown' } },
  ])('rejects an arbitrary or mismatched HTTP 409 body: %j', async response => {
    await expect(correlateSkillPublicationNoEffect({ commandId: 'skill-command', requestSha256: '4'.repeat(64),
      skillName: 'maps', version: '2.0.0', bundleSha256: '2'.repeat(64),
      responseBody: JSON.stringify(response) })).rejects.toThrow();
    expect(fixture.updateMany).not.toHaveBeenCalled();
  });
});
