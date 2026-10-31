import { z } from 'zod';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { boundedJson } from './application-probes.js';
const reviewedText = z
  .string()
  .trim()
  .min(5)
  .max(1200)
  .refine(
    (s) =>
      !/(?:https?:\/\/|bearer\s|password\s*[:=]|token\s*[:=]|secret\s*[:=]|-----BEGIN|\beyJ[A-Za-z0-9_-]+\.)/i.test(
        s,
      ),
    'Remove credentials, URLs, raw logs and private evidence from the reviewed text',
  );
export const lessonSchema = z
  .object({
    incidentId: z.string().min(1).max(200),
    symptom: reviewedText,
    cause: reviewedText,
    runbookVersion: z.enum(['diagnostics.v1', 'restart-service.v1']),
    evidenceIds: z
      .array(z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/))
      .min(1)
      .max(20),
    expiresAt: z.string().datetime(),
    reviewed: z.literal(true),
  })
  .strict()
  .refine(
    (v) =>
      Date.parse(v.expiresAt) > Date.now() && Date.parse(v.expiresAt) - Date.now() <= 90 * 86400000,
    'Review expiry must be within 90 days',
  );
function connection() {
  const url = process.env['MAGNUS_LESSONS_HIVEMEM_URL'];
  const token = process.env['MAGNUS_LESSONS_HIVEMEM_TOKEN'];
  const workspace = process.env['MAGNUS_LESSONS_WORKSPACE'];
  if (!url || !token || !workspace || workspace === 'default') return null;
  const base = new URL(url);
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  )
    throw new Error('Lesson memory requires a dedicated HTTPS origin');
  if (token === process.env['HIVEMEM_TOKEN'])
    throw new Error('Use a dedicated lesson credential, not the general memory token');
  return { base, token, workspace };
}
async function request(path: string, method: string, body?: unknown) {
  const config = connection();
  if (!config)
    throw new HttpError(
      409,
      'UNCONFIGURED',
      'Configure a dedicated lesson workspace and non-admin credential',
    );
  const res = await fetch(new URL(path, config.base), {
    method,
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new HttpError(502, 'LESSON_MEMORY_FAILED', 'Scoped lesson memory request failed');
  }
  return res.status === 204 ? {} : ((await boundedJson(res)) as Record<string, unknown>);
}
export async function publishLesson(input: z.infer<typeof lessonSchema>, actorId: string) {
  const db = getDb();
  const incident = await db.anomalyEvent.findUnique({ where: { id: input.incidentId } });
  if (!incident) throw new HttpError(404, 'NOT_FOUND', 'Incident not found');
  const evidence = await db.remediationExecution.findMany({
    where: { id: { in: input.evidenceIds }, anomalyEventId: input.incidentId, status: 'completed' },
  });
  if (
    !evidence.length ||
    !evidence.some((e) => {
      try {
        return JSON.parse(e.input).runbookVersion === input.runbookVersion;
      } catch {
        return false;
      }
    })
  )
    throw new HttpError(
      400,
      'LESSON_EVIDENCE',
      'Select a completed matching runbook execution for this incident',
    );
  const row = await db.incidentLesson.create({
    data: {
      incidentId: incident.id,
      nodeId: incident.nodeId,
      symptom: input.symptom,
      cause: input.cause,
      runbookVersion: input.runbookVersion,
      evidenceIds: JSON.stringify(evidence.map((e) => e.id)),
      reviewedBy: actorId,
      expiresAt: new Date(input.expiresAt),
    },
  });
  const config = connection();
  if (!config) return { ...row, publication: 'unconfigured' };
  // One explicit attempt. Ambiguous transport failure retains the local review and
  // is never automatically re-published, avoiding duplicate external memories.
  try {
    const memory = await request('/v1/memories', 'POST', {
      content: JSON.stringify({
        lessonId: row.id,
        symptom: row.symptom,
        cause: row.cause,
        runbookVersion: row.runbookVersion,
        evidenceIds: evidence.map((e) => e.id),
        reviewedBy: actorId,
      }),
      type: 'procedural',
      scope: 'private',
      source: 'user_feedback',
      workspace_id: config.workspace,
      expires_at: input.expiresAt,
      sensitivity: 'internal',
      redaction_policy: 'redact',
      tags: ['magnus-reviewed-lesson'],
      metadata: { magnus_lesson_id: row.id },
    });
    if (typeof memory['id'] !== 'string' || !memory['id'])
      throw new Error('Invalid memory receipt');
    await db.incidentLesson.update({ where: { id: row.id }, data: { memoryId: memory['id'] } });
    return { ...row, memoryId: memory['id'], publication: 'published' };
  } catch {
    return {
      ...row,
      publication: 'unknown',
      message: 'Review the scoped memory receipt before any retry',
    };
  }
}
export async function lessonSuggestions(query: string) {
  // The local approved ledger is the admission boundary. Expired, superseded,
  // unrelated or model-invented memories cannot become execution authority.
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2)
    .slice(0, 20);
  const rows = await getDb().incidentLesson.findMany({
    where: { supersededAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return {
    advisoryOnly: true,
    lessons: rows
      .filter((r) => terms.some((t) => `${r.symptom} ${r.cause}`.toLowerCase().includes(t)))
      .slice(0, 10),
  };
}
export async function supersedeLesson(id: string) {
  const row = await getDb().incidentLesson.update({
    where: { id },
    data: { supersededAt: new Date() },
  });
  let publication = 'invalidated-locally';
  if (row.memoryId) {
    try {
      await request(`/v1/memories/${encodeURIComponent(row.memoryId)}`, 'DELETE');
      publication = 'invalidated';
    } catch {
      publication = 'remote-invalidation-pending';
    }
  }
  return { id, publication };
}
export async function reconcileLessonInvalidations() {
  if (!connection()) return;
  const rows = await getDb().incidentLesson.findMany({
    where: {
      memoryId: { not: null },
      OR: [{ supersededAt: { not: null } }, { expiresAt: { lte: new Date() } }],
    },
    take: 10,
  });
  for (const row of rows) {
    try {
      await request(`/v1/memories/${encodeURIComponent(row.memoryId!)}`, 'DELETE');
      await getDb().incidentLesson.update({ where: { id: row.id }, data: { memoryId: null } });
    } catch {
      /* Retry deletion; never re-publish. */
    }
  }
}
