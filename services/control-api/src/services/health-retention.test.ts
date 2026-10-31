import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeRaw = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ $executeRaw: executeRaw }),
}));

const { getHealthRetentionCutoffs, getHealthRetentionPolicy, pruneOldSnapshots } = await import('./health-retention.js');

describe('health retention', () => {
  beforeEach(() => {
    delete process.env['HEALTH_SNAPSHOT_RETENTION_DAYS'];
    delete process.env['HEALTH_SNAPSHOT_FULL_FIDELITY_HOURS'];
    delete process.env['HEALTH_SNAPSHOT_SAMPLE_MINUTES'];
    delete process.env['ENGINEERING_EXERCISE_RETENTION_DAYS'];
    executeRaw.mockReset();
    executeRaw.mockResolvedValueOnce(11).mockResolvedValueOnce(89).mockResolvedValueOnce(7)
      .mockResolvedValueOnce(13).mockResolvedValueOnce(144).mockResolvedValueOnce(2);
  });

  it('defaults to one day of full fidelity and seven days of 15-minute samples', () => {
    expect(getHealthRetentionPolicy()).toEqual({
      retentionDays: 7,
      fullFidelityHours: 24,
      sampleMinutes: 15,
    });
  });

  it('deletes expired rows and downsamples the remaining baseline', async () => {
    await pruneOldSnapshots();
    expect(executeRaw).toHaveBeenCalledTimes(6);
    const expirySql = (executeRaw.mock.calls[0]?.[0] as TemplateStringsArray).join(' ');
    const sql = (executeRaw.mock.calls[1]?.[0] as TemplateStringsArray).join(' ');
    expect(expirySql).toContain('"healthSnapshotId" = snapshot."id"');
    expect(sql).toContain('"cpuMaxRank"');
    expect(sql).toContain('"memoryMaxRank"');
    expect(sql).toContain('"diskMaxRank"');
    expect(sql).toContain('"healthSnapshotId" = snapshot."id"');
    const gpuExpirySql = (executeRaw.mock.calls[2]?.[0] as TemplateStringsArray).join(' ');
    expect(gpuExpirySql).toContain('"gpu_snapshots"');
    const metricExpirySql = (executeRaw.mock.calls[3]?.[0] as TemplateStringsArray).join(' ');
    expect(metricExpirySql).toContain('"engineering_metric_samples"');
    expect(metricExpirySql).toContain('"observedAt"');
    const metricDownsampleSql = (executeRaw.mock.calls[4]?.[0] as TemplateStringsArray).join(' ');
    expect(metricDownsampleSql).toContain('"applicationId", "metric", "sourceKey"');
    expect(metricDownsampleSql).toContain('"lastRank"');
    expect(metricDownsampleSql).toContain('"maxRank"');
    expect(metricDownsampleSql).toContain('"minRank"');
    const recoveryExpirySql = (executeRaw.mock.calls[5]?.[0] as TemplateStringsArray).join(' ');
    expect(recoveryExpirySql).toContain('"engineering_recovery_exercises"');
    expect(recoveryExpirySql).toContain('"createdAt"');
  });

  it('keeps a critical spike and the final normal observation in a normal-critical-normal bucket', () => {
    const samples = [
      { id: 'normal-first', timestamp: 1, cpu: 20 },
      { id: 'critical-spike', timestamp: 2, cpu: 99 },
      { id: 'normal-last', timestamp: 3, cpu: 21 },
    ];
    const cpuMaxId = [...samples].sort((a, b) => b.cpu - a.cpu || b.timestamp - a.timestamp)[0]?.id;
    const lastId = [...samples].sort((a, b) => b.timestamp - a.timestamp)[0]?.id;
    expect([cpuMaxId, lastId]).toEqual(['critical-spike', 'normal-last']);
  });

  it('calculates explicit full-fidelity and expiry cutoffs', () => {
    const now = new Date('2026-08-19T12:00:00.000Z');
    expect(getHealthRetentionCutoffs(now, {
      retentionDays: 7,
      fullFidelityHours: 24,
      sampleMinutes: 15,
    })).toEqual({
      expiresBefore: new Date('2026-08-12T12:00:00.000Z'),
      fullFidelityAfter: new Date('2026-08-18T12:00:00.000Z'),
    });
  });
});
