import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationsUrl = new URL('../../prisma/migrations/', import.meta.url);
const baselineName = '20261031000000_baseline';
const migration = readFileSync(new URL(`${baselineName}/migration.sql`, migrationsUrl), 'utf8');
const seed = readFileSync(new URL('./seed.ts', import.meta.url), 'utf8');

describe('PostgreSQL baseline migration', () => {
  it('is the first packaged migration and only uses the PostgreSQL provider', () => {
    const names = readdirSync(migrationsUrl).filter(name => /^\d+_/.test(name)).sort();
    expect(names[0]).toBe(baselineName);
    expect(readFileSync(new URL('migration_lock.toml', migrationsUrl), 'utf8')).toContain('provider = "postgresql"');
    expect(migration).toContain('CREATE TYPE public."UserRole" AS ENUM');
    expect(migration).not.toContain('PRAGMA ');
    expect(migration).not.toContain('_prisma_migrations');
  });

  it('keeps fleet-readiness indexes and node ownership cascades', () => {
    expect(migration).toContain('CREATE INDEX "health_snapshots_nodeId_timestamp_idx" ON public.health_snapshots');
    expect(migration).toContain('CREATE UNIQUE INDEX "hermes_installations_hostname_hermesHome_key"');
    expect(migration).toMatch(/"hermes_installations_nodeId_fkey" FOREIGN KEY \("nodeId"\) REFERENCES public\.nodes\(id\) ON UPDATE CASCADE ON DELETE CASCADE/);
    expect(migration).toMatch(/"anomaly_events_healthSnapshotId_fkey" FOREIGN KEY \("healthSnapshotId"\) REFERENCES public\.health_snapshots\(id\) ON UPDATE CASCADE ON DELETE RESTRICT/);
  });

  it('carries database-enforced invariants that Prisma does not model', () => {
    for (const name of [
      'engineering_metric_samples_metric_check',
      'engineering_recovery_exercises_target_check',
      'command_resource_leases_completion_authority_complete',
      'managed_cron_enabled_requires_v1_acknowledgement',
      'shared_resource_fences_key_check',
      'shared_resource_leases_started_check',
    ]) expect(migration).toContain(`CONSTRAINT ${name} CHECK`);
    expect(migration).toMatch(/CREATE UNIQUE INDEX shared_resource_lease_resources_active_resource .* WHERE \(state = ANY/);
    expect(migration).toMatch(/CREATE UNIQUE INDEX command_resource_leases_active_resource .* WHERE \(state = ANY/);
    for (const trigger of [
      'command_resource_leases_authority_immutable',
      'engineering_recovery_exercises_no_update',
      'engineering_recovery_exercises_no_truncate',
      'managed_cron_clear_acknowledgement_on_disable',
      'resource_participant_work_identity_immutable',
      'shared_resource_fence_generation_monotonic',
      'shared_resource_fence_insert_guard',
      'shared_resource_fence_delete_guard',
      'shared_resource_fence_truncate_guard',
      'shared_resource_lease_insert_guard',
      'shared_resource_lease_transition_guard',
      'shared_resource_claim_insert_guard',
      'shared_resource_claim_transition_guard',
      'shared_resource_claim_delete_guard',
      'shared_resource_claim_truncate_guard',
    ]) expect(migration).toContain(`CREATE TRIGGER ${trigger} `);
    expect(migration).toContain('shared resource lease must be born reserved');
    expect(migration).toContain('released shared resource ownership cannot be revived');
  });

  it('seeds the receipt-chain head and the system fan alert rule', () => {
    expect(migration).toMatch(/INSERT INTO public\.security_fusion_receipt_chain_heads[\s\S]*'security-fusion'/);
    expect(migration).toMatch(/INSERT INTO public\.alert_rules[\s\S]*'system-gpu-fan-100-8h'/);
  });

  it('does not create a default interactive administrator', () => {
    expect(migration).not.toMatch(/INSERT INTO public\.users/);
    expect(seed).not.toContain('admin@magnus.local');
    expect(seed).not.toMatch(/hashPassword\(['"]admin['"]\)/);
    expect(seed).toContain(`id: 'system'`);
    expect(seed).toContain(`id: '__control-api__'`);
    expect(seed).toContain(`id: '__dashboard__'`);
  });
});
