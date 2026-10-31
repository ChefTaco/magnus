import { getDb } from '../db/index.js';
import { getValidatedEnv } from '../utils/env.js';

// ─── HealthSnapshot Retention — periodic pruning of old snapshots ───

/** How often to check if pruning is needed (ms). */
const CHECK_INTERVAL_MS = 3_600_000; // every hour

let timer: ReturnType<typeof setInterval> | null = null;
let lastPrunedDate: string | null = null;

export interface HealthRetentionPolicy {
  retentionDays: number;
  fullFidelityHours: number;
  sampleMinutes: number;
}

export interface HealthRetentionCutoffs {
  expiresBefore: Date;
  fullFidelityAfter: Date;
}

/** Keep recent data dense and retain a bounded historical baseline. */
export function getHealthRetentionPolicy(): HealthRetentionPolicy {
  const env = getValidatedEnv();
  return {
    retentionDays: env.HEALTH_SNAPSHOT_RETENTION_DAYS,
    fullFidelityHours: env.HEALTH_SNAPSHOT_FULL_FIDELITY_HOURS,
    sampleMinutes: env.HEALTH_SNAPSHOT_SAMPLE_MINUTES,
  };
}

export function getHealthRetentionCutoffs(
  now = new Date(),
  policy = getHealthRetentionPolicy(),
): HealthRetentionCutoffs {
  return {
    expiresBefore: new Date(now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000),
    fullFidelityAfter: new Date(now.getTime() - policy.fullFidelityHours * 60 * 60 * 1000),
  };
}

export function getRecoveryExerciseRetentionCutoff(now = new Date()): Date {
  return new Date(now.getTime() - getValidatedEnv().ENGINEERING_EXERCISE_RETENTION_DAYS * 86_400_000);
}

export function getRetentionPolicyReadiness(): { status: 'pass' | 'fail'; message: string } {
  try {
    const health = getHealthRetentionPolicy();
    const env = getValidatedEnv();
    if (health.fullFidelityHours > health.retentionDays * 24) {
      return { status: 'fail', message: 'health full-fidelity window exceeds total retention' };
    }
    if (env.NOTIFICATION_READ_RETENTION_DAYS > env.NOTIFICATION_MAX_RETENTION_DAYS) {
      return { status: 'fail', message: 'notification read retention exceeds maximum retention' };
    }
    return {
      status: 'pass',
      message: `health ${health.fullFidelityHours}h/${health.retentionDays}d; notifications ${env.NOTIFICATION_READ_RETENTION_DAYS}d/${env.NOTIFICATION_MAX_RETENTION_DAYS}d`,
    };
  } catch (error) {
    return { status: 'fail', message: error instanceof Error ? error.message : 'invalid retention policy' };
  }
}

/** Return today's date as YYYY-MM-DD string. */
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Delete health snapshots older than the retention window.
 * Runs at most once per calendar day.
 */
export async function pruneOldSnapshots(): Promise<void> {
  const today = todayStr();
  if (lastPrunedDate === today) return;

  const policy = getHealthRetentionPolicy();
  const { expiresBefore: cutoff, fullFidelityAfter: fullFidelityCutoff } = getHealthRetentionCutoffs();

  try {
    const db = getDb();
    const expiredCount = await db.$executeRaw`
      DELETE FROM "health_snapshots" AS snapshot
      WHERE snapshot."timestamp" < ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM "anomaly_events" AS anomaly
          WHERE anomaly."healthSnapshotId" = snapshot."id"
        )
    `;
    const downsampledCount = await db.$executeRaw`
      WITH measured AS (
        SELECT snapshot.*,
          COALESCE((
            SELECT MAX((disk ->> 'usagePercent')::double precision)
            FROM jsonb_array_elements(snapshot."disks"::jsonb) AS disk
          ), 0) AS "maxDiskPercent"
        FROM "health_snapshots"
          AS snapshot
        WHERE snapshot."timestamp" < ${fullFidelityCutoff}
          AND snapshot."timestamp" >= ${cutoff}
      ), ranked AS (
        SELECT "id",
          ROW_NUMBER() OVER (PARTITION BY "nodeId", FLOOR(EXTRACT(EPOCH FROM "timestamp") / ${policy.sampleMinutes * 60}) ORDER BY "timestamp" DESC, "id") AS "lastRank",
          ROW_NUMBER() OVER (PARTITION BY "nodeId", FLOOR(EXTRACT(EPOCH FROM "timestamp") / ${policy.sampleMinutes * 60}) ORDER BY "cpuUsagePercent" DESC, "timestamp" DESC, "id") AS "cpuMaxRank",
          ROW_NUMBER() OVER (PARTITION BY "nodeId", FLOOR(EXTRACT(EPOCH FROM "timestamp") / ${policy.sampleMinutes * 60}) ORDER BY "cpuUsagePercent" ASC, "timestamp" DESC, "id") AS "cpuMinRank",
          ROW_NUMBER() OVER (PARTITION BY "nodeId", FLOOR(EXTRACT(EPOCH FROM "timestamp") / ${policy.sampleMinutes * 60}) ORDER BY "memoryPercent" DESC, "timestamp" DESC, "id") AS "memoryMaxRank",
          ROW_NUMBER() OVER (PARTITION BY "nodeId", FLOOR(EXTRACT(EPOCH FROM "timestamp") / ${policy.sampleMinutes * 60}) ORDER BY "memoryPercent" ASC, "timestamp" DESC, "id") AS "memoryMinRank",
          ROW_NUMBER() OVER (PARTITION BY "nodeId", FLOOR(EXTRACT(EPOCH FROM "timestamp") / ${policy.sampleMinutes * 60}) ORDER BY "swapUsedBytes" DESC, "timestamp" DESC, "id") AS "swapMaxRank",
          ROW_NUMBER() OVER (PARTITION BY "nodeId", FLOOR(EXTRACT(EPOCH FROM "timestamp") / ${policy.sampleMinutes * 60}) ORDER BY "maxDiskPercent" DESC, "timestamp" DESC, "id") AS "diskMaxRank"
        FROM measured
      )
      DELETE FROM "health_snapshots" AS snapshot
      USING ranked
      WHERE snapshot."id" = ranked."id"
        AND ranked."lastRank" > 1
        AND ranked."cpuMaxRank" > 1
        AND ranked."cpuMinRank" > 1
        AND ranked."memoryMaxRank" > 1
        AND ranked."memoryMinRank" > 1
        AND ranked."swapMaxRank" > 1
        AND ranked."diskMaxRank" > 1
        AND NOT EXISTS (
          SELECT 1 FROM "anomaly_events" AS anomaly
          WHERE anomaly."healthSnapshotId" = snapshot."id"
        )
    `;
    const expiredGpuCount = await db.$executeRaw`
      DELETE FROM "gpu_snapshots"
      WHERE "sampledAt" < ${cutoff}
    `;
    const expiredEngineeringMetricCount = await db.$executeRaw`
      DELETE FROM "engineering_metric_samples"
      WHERE "observedAt" < ${cutoff}
    `;
    const downsampledEngineeringMetricCount = await db.$executeRaw`
      WITH ranked AS (
        SELECT "id",
          ROW_NUMBER() OVER (
            PARTITION BY "applicationId", "metric", "sourceKey",
              FLOOR(EXTRACT(EPOCH FROM "observedAt") / ${policy.sampleMinutes * 60})
            ORDER BY "observedAt" DESC, "id"
          ) AS "lastRank",
          ROW_NUMBER() OVER (
            PARTITION BY "applicationId", "metric", "sourceKey",
              FLOOR(EXTRACT(EPOCH FROM "observedAt") / ${policy.sampleMinutes * 60})
            ORDER BY "value" DESC, "observedAt" DESC, "id"
          ) AS "maxRank",
          ROW_NUMBER() OVER (
            PARTITION BY "applicationId", "metric", "sourceKey",
              FLOOR(EXTRACT(EPOCH FROM "observedAt") / ${policy.sampleMinutes * 60})
            ORDER BY "value" ASC, "observedAt" DESC, "id"
          ) AS "minRank"
        FROM "engineering_metric_samples"
        WHERE "observedAt" < ${fullFidelityCutoff}
          AND "observedAt" >= ${cutoff}
      )
      DELETE FROM "engineering_metric_samples" AS sample
      USING ranked
      WHERE sample."id" = ranked."id"
        AND ranked."lastRank" > 1
        AND ranked."maxRank" > 1
        AND ranked."minRank" > 1
    `;
    const expiredRecoveryExerciseCount = await db.$executeRaw`
      DELETE FROM "engineering_recovery_exercises"
      WHERE "createdAt" < ${getRecoveryExerciseRetentionCutoff()}
    `;

    lastPrunedDate = today;
    const deletedCount = expiredCount + downsampledCount + expiredGpuCount
      + expiredEngineeringMetricCount + downsampledEngineeringMetricCount + expiredRecoveryExerciseCount;

    if (deletedCount > 0) {
      console.log(
        `🗑️  Engineering retention: pruned ${deletedCount} telemetry/exercise rows (${policy.fullFidelityHours}h full fidelity, ${policy.sampleMinutes}m samples through day ${policy.retentionDays})`,
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`Health snapshot retention error: ${message}`);
  }
}

/** Start the periodic health snapshot retention service. */
export function startHealthRetention(): void {
  if (timer) return;
  const policy = getHealthRetentionPolicy();
  console.log(
    `🗑️  Health snapshot retention started (${policy.fullFidelityHours}h full fidelity, ${policy.sampleMinutes}m samples through day ${policy.retentionDays})`,
  );
  void pruneOldSnapshots();
  timer = setInterval(() => void pruneOldSnapshots(), CHECK_INTERVAL_MS);
}

/** Stop the health snapshot retention service. */
export function stopHealthRetention(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
