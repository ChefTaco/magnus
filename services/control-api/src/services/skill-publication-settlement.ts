import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db/index.js';

const noEffectSchema = z.object({
  success: z.literal(false),
  error: z.object({ code: z.literal('SKILL_PUBLICATION_NOT_COMMITTED'), message: z.string() }).strict(),
  data: z.object({
    skillName: z.string(), version: z.string(), bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
    commandId: z.string(), requestSha256: z.string().regex(/^[a-f0-9]{64}$/), effect: z.literal('none'),
  }).strict(),
}).strict();

const MARKER_PREFIX = 'signed-skill-no-effect:';

export function isSkillPublicationNoEffectSettlement(value: string | null): boolean {
  return typeof value === 'string' && new RegExp(`^${MARKER_PREFIX}[a-f0-9]{64}$`).test(value);
}

/** Promote an already signature-verified generic settlement only after its
 * exact typed node response proves that this publication committed no effect. */
export async function correlateSkillPublicationNoEffect(input: {
  commandId: string;
  requestSha256: string;
  skillName: string;
  version: string;
  bundleSha256: string;
  responseBody: string;
}): Promise<void> {
  const response = noEffectSchema.parse(JSON.parse(input.responseBody));
  if (response.data.commandId !== input.commandId || response.data.requestSha256 !== input.requestSha256
    || response.data.skillName !== input.skillName || response.data.version !== input.version
    || response.data.bundleSha256 !== input.bundleSha256)
    throw new Error('Skill publication no-effect response differs from the exact workflow');
  const marker = `${MARKER_PREFIX}${createHash('sha256').update(input.responseBody).digest('hex')}`;
  const db = getDb();
  const changed = await db.commandResourceLease.updateMany({ where: { commandId: input.commandId,
    requestSha256: input.requestSha256, state: 'released', settlement: 'signed-command-result' },
  data: { settlement: marker } });
  if (changed.count === 1) return;
  const current = await db.commandResourceLease.findUnique({ where: { commandId: input.commandId } });
  if (!current || current.requestSha256 !== input.requestSha256 || current.state !== 'released'
    || current.settlement !== marker)
    throw new Error('Signed skill publication no-effect settlement changed before correlation');
}
