import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { rootControlled } from './embermend-files.js';
export { rootControlled } from './embermend-files.js';
import { z } from 'zod';
import { scanWorkerConfigSchema } from './embermend-scan.js';

export const embermendNodeConfigSchema = z.object({
  version: z.literal(1),
  resources: z.record(z.string().regex(/^[a-zA-Z0-9._-]+$/), z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('file'), path: z.string().startsWith('/'), allowedModes: z.array(z.enum(['0600', '0640', '0700', '0750'])).min(1) }).strict(),
    z.object({ kind: z.literal('service'), unit: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9@_.-]*\.service$/), allowDisable: z.boolean() }).strict(),
    z.object({ kind: z.literal('ssh'), path: z.string().regex(/^\/etc\/ssh\/sshd_config\.d\/[a-zA-Z0-9_-]+\.conf$/), managementProbeId: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('firewall'), protectedPorts: z.array(z.number().int().min(1).max(65535)).min(1), managementProbeId: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('compose'), path: z.string().startsWith('/'), overridePath: z.string().startsWith('/'), service: z.string().regex(/^[a-zA-Z0-9_-]+$/), imageRepository: z.string().regex(/^[a-zA-Z0-9._:/-]+$/), healthUrl: z.url() }).strict(),
  ])),
  securityPackages: z.array(z.string().regex(/^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?$/)),
  trivy: z.object({ path: z.string().startsWith('/'), sha256: z.string().regex(/^[a-f0-9]{64}$/), imageRepositories: z.array(z.string().regex(/^[a-zA-Z0-9._:/-]+$/)).min(1) }).strict().optional(),
  ovalEnabled: z.boolean().default(false),
  reboot: z.object({ managementProbeId: z.string().min(1).max(200), continuationWindowSeconds: z.number().int().min(60).max(900) }).strict().optional(),
  worker: scanWorkerConfigSchema.optional(),
}).strict();
export type EmbermendNodeConfig = z.infer<typeof embermendNodeConfigSchema>;
export async function loadEmbermendConfig(path = process.env['MAGNUS_EMBERMEND_CONFIG'] ?? ''): Promise<EmbermendNodeConfig> {
  if (!path) throw new Error('Embermend node capability is not configured'); await rootControlled(path);
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await fd.stat(); if (!stat.isFile() || stat.size > 131072 || stat.nlink !== 1 || stat.mode & 0o077) throw new Error('Protected configuration required'); return embermendNodeConfigSchema.parse(JSON.parse(await fd.readFile('utf8'))); }
  finally { await fd.close(); }
}
