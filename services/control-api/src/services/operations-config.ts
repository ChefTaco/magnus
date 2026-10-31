import { readFileSync, lstatSync } from 'node:fs';
import { z } from 'zod';

const safeId = z.string().regex(/^[a-zA-Z0-9._/-]{1,160}$/);
const probePath = z
  .string()
  .regex(/^\/[a-zA-Z0-9/_.-]*$/)
  .refine((v) => !v.includes('..') && !v.startsWith('//'));
export const applicationConfigSchema = z
  .object({
    id: safeId,
    projectId: safeId,
    serviceId: safeId,
    nodeId: safeId,
    baseUrl: z
      .string()
      .url()
      .refine((value) => {
        const u = new URL(value);
        return (
          u.protocol === 'https:' &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash &&
          u.pathname === '/'
        );
      }, 'Use an HTTPS origin without credentials'),
    healthPath: probePath,
    readinessPath: probePath.optional(),
    queuePath: probePath.optional(),
    canaryModel: z
      .string()
      .regex(/^[a-zA-Z0-9._:/-]{1,160}$/)
      .optional(),
    maxQueueAgeMs: z.number().int().min(1000).max(86400000).default(300000),
    tokenEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]+$/)
      .optional(),
    kind: z
      .enum(['http', 'workflow-queue', 'backend-pool', 'hive-router', 'hivemem'])
      .default('http'),
    restartService: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,100}\.service$/)
      .refine((v) => !/ssh|tailscale|fail2ban|firewall/i.test(v))
      .optional(),
    dependsOn: z.array(safeId).max(100).default([]),
  })
  .strict();
export type ApplicationConfig = z.infer<typeof applicationConfigSchema>;
export function getApplicationConfigs(): ApplicationConfig[] {
  const file = process.env['MAGNUS_APPLICATION_PROBES_FILE'];
  if (!file) return [];
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128000 || stat.mode & 0o022)
    throw new Error('Unsafe application probe configuration');
  const parsed = z
    .object({
      schemaVersion: z.literal(1),
      applications: z.array(applicationConfigSchema).max(100),
    })
    .strict()
    .parse(JSON.parse(readFileSync(file, 'utf8')));
  if (new Set(parsed.applications.map((a) => a.id)).size !== parsed.applications.length)
    throw new Error('Duplicate application probe ID');
  return parsed.applications;
}
