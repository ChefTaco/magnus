/**
 * Zod schemas for validating data returned from node-manager agents before
 * persisting to the database (item 2.2 — response shape validation).
 */

import { z } from 'zod';

export const commandFenceSchema = z.object({
  version: z.literal(1), resourceKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/),
  fence: z.string().regex(/^[1-9][0-9]{0,18}$/),
  expiresAt: z.number().int().positive().max(8_640_000_000_000_000),
}).strict();

// ── Command execution result (from workers.ts / quick-command.ts) ──
export const commandResultSchema = z.object({
  commandId: z.string(),
  exitCode: z.number().int(),
  stdout: z.string().default(''),
  stderr: z.string().default(''),
  durationMs: z.number().min(0).default(0),
  truncated: z.boolean(),
  signature: z.string().regex(/^[a-f0-9]{64}$/i),
  coordination: commandFenceSchema.extend({ requestSha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  completion: z.object({ registryVersion: z.literal(1), registrySha256: z.string().regex(/^[a-f0-9]{64}$/),
    descriptorId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/) }).strict().optional(),
});

// ── Quick-command response envelope ──
export const quickCommandResponseSchema = z.object({
  success: z.boolean(),
  data: commandResultSchema,
});

// ── Heartbeat health payload (from node-manager agent) ──
export const heartbeatHealthSchema = z.object({
  cpu: z.object({
    usagePercent: z.number().min(0).max(100).optional().default(0),
    cores: z.number().int().min(0).optional().default(0),
    loadAverage: z.array(z.number()).optional().default([0, 0, 0]),
  }).optional(),
  memory: z.object({
    totalBytes: z.number().min(0).optional().default(0),
    usedBytes: z.number().min(0).optional().default(0),
    usagePercent: z.number().min(0).max(100).optional().default(0),
    swapTotalBytes: z.number().min(0).optional().default(0),
    swapUsedBytes: z.number().min(0).optional().default(0),
  }).optional(),
  disks: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  network: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  services: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  wazuh: z.object({
    installed: z.boolean(),
    serviceStatus: z.enum(['active', 'inactive', 'failed', 'not_installed', 'unknown']),
    enabled: z.enum(['enabled', 'disabled', 'static', 'unknown']),
    version: z.string().nullable(),
    managerAddresses: z.array(z.string()),
  }).optional(),
  systemUpdates: z.object({
    supported: z.boolean(),
    platform: z.string(),
    automaticUpdates: z.enum(['enabled', 'disabled', 'partial', 'unsupported', 'unknown']),
    unattendedUpgradesInstalled: z.boolean(),
    periodicUpdateListsEnabled: z.boolean(),
    periodicUnattendedUpgradeEnabled: z.boolean(),
    fullUpgradePolicyEnabled: z.boolean(),
    timers: z.array(z.object({
      name: z.string(),
      enabled: z.boolean(),
      active: z.boolean(),
      state: z.string(),
    })),
    rebootRequired: z.boolean(),
    rebootRequiredPackages: z.array(z.string()).max(50),
  }).optional(),
  gpu: z.object({
    sampledAt: z.string().datetime(),
    sampleIntervalSeconds: z.number().int().min(15).max(300).default(30),
    status: z.enum(['ok', 'unavailable', 'error']).default('unavailable'),
    devices: z.array(z.object({
      index: z.number().int().min(0),
      vendor: z.enum(['nvidia', 'amd']),
      name: z.string().min(1).max(200),
      uuid: z.string().max(200).nullable(),
      utilizationPercent: z.number().min(0).max(100).nullable(),
      fanPercent: z.number().min(0).max(100).nullable(),
      temperatureCelsius: z.number().min(-100).max(250).nullable(),
    })).max(32),
  }).optional(),
  cockpitAvailable: z.boolean().optional().default(false),
  source: z.string().optional().default('system-probe'),
});
