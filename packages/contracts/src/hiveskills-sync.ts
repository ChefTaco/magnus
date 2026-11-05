import { z } from 'zod';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
const version = z.string().regex(/^v?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i);
export const HiveSkillsPublicationEntrySchema = z.object({
  slug, name: z.string().min(1).max(120), version,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  compatibility: z.object({ minHermesVersion: version.nullable(), maxHermesVersion: version.nullable() }).strict(),
  archiveUrl: z.url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.search || url.search === '?channel=canary'); }),
}).strict();
/** Public archive identities only. Credentials and host paths never enter jobs. */
export const HiveSkillsPublicationSchema = z.object({
  schemaVersion: z.literal(1),
  channel: z.enum(['stable', 'canary']),
  skills: z.array(HiveSkillsPublicationEntrySchema).max(1000),
}).strict();
export type HiveSkillsPublication = z.infer<typeof HiveSkillsPublicationSchema>;
export const HiveSkillsSyncInputSchema = z.object({
  target: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  registryId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  publicationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  manifest: HiveSkillsPublicationSchema,
}).strict();
export type HiveSkillsSyncInput = z.infer<typeof HiveSkillsSyncInputSchema>;

export const HiveSkillsTargetPostureSchema = z.object({
  ready: z.boolean(), registryId: slug, target: slug,
  configurationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  clientSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  reason: z.enum(['ready', 'unavailable', 'privilege_required']),
}).strict();
export type HiveSkillsTargetPosture = z.infer<typeof HiveSkillsTargetPostureSchema>;
