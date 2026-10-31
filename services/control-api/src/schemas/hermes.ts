import { z } from 'zod';

const sshPortSchema = z.number().int().min(1).max(65535);
const optionalString = z.string().trim().min(1).optional();

const hermesTargetBaseSchema = z.object({
  nodeId: optionalString,
  hostname: optionalString,
  sshPort: sshPortSchema.optional(),
  hermesHome: z.string().trim().min(1).default('~/.hermes'),
  hermesBin: z.string().trim().min(1).default('hermes'),
});

export const hermesTargetSchema = hermesTargetBaseSchema.refine((value) => Boolean(value.nodeId || value.hostname), {
  message: 'Either nodeId or hostname is required',
  path: ['hostname'],
});

export const hermesDetectSchema = hermesTargetSchema;

export const hermesDeploySchema = hermesTargetBaseSchema.extend({
  installMethod: z.enum(['official-script', 'pip']).default('official-script'),
  dashboardPort: sshPortSchema.default(9119),
  enableDashboard: z.boolean().default(true),
  enableDashboardTui: z.boolean().default(true),
  startGateway: z.boolean().default(true),
}).refine((value) => Boolean(value.nodeId || value.hostname), {
  message: 'Either nodeId or hostname is required',
  path: ['hostname'],
});

export const hermesProfileCreateSchema = z.object({
  name: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, numbers, dot, underscore, or dash'),
  description: z.string().trim().max(2000).optional(),
  distribution: z.string().trim().min(1).max(200).optional(),
  setDefault: z.boolean().default(false),
});

export const hermesProfileUpdateSchema = z.object({
  description: z.string().trim().max(2000).optional(),
  renameTo: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/).optional(),
}).refine((value) => value.description !== undefined || value.renameTo !== undefined, {
  message: 'At least one update field is required',
});

export const hermesConfigUpdateSchema = z.object({
  configYaml: z.string().max(512_000),
});

export const hermesGatewayActionSchema = z.object({
  action: z.enum(['install', 'start', 'stop', 'restart', 'status']),
});

export const hermesApiServerEnableSchema = z.object({
  port: sshPortSchema.default(8642),
  host: z.string().trim().min(1).default('127.0.0.1'),
  apiKey: z.string().min(16).max(4096).optional(),
});

export const hermesOpenClawMigrationSchema = z.object({
  installationId: z.string().min(1),
  profileName: z.string().trim().min(1).max(100).optional(),
  sourcePath: z.string().trim().min(1).default('~/.openclaw'),
  preset: z.enum(['full', 'user-data']).default('full'),
  overwrite: z.boolean().default(false),
  migrateSecrets: z.boolean().default(false),
});

export const hermesJobListQuerySchema = z.object({
  status: z.string().optional(),
  type: z.string().optional(),
  /** Category prefix-matched against `type` (e.g. `install`, `skill_push`, `provider`, `cron`). */
  category: z.string().optional(),
  installationId: z.string().optional(),
  profileId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const hermesApiServerRotateSchema = z.object({
  apiKey: z.string().min(16).max(4096).optional(),
});
