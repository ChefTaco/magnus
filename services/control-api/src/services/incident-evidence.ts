import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';

export function evidenceEnvelope(value: Record<string, unknown>, maxBytes = 100000) {
  const json = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(json) > maxBytes)
    throw new HttpError(413, 'EVIDENCE_LIMIT', 'Narrow the incident evidence request');
  return {
    schemaVersion: 1,
    sha256: createHash('sha256').update(json).digest('hex'),
    bytes: Buffer.byteLength(json),
    json,
    markdown: `# Magnus incident evidence\n\nIncident: ${String(value.incidentId)}\n\nSHA-256: ${createHash('sha256').update(json).digest('hex')}\n\nThis packet records observations and ordering, not causality. Command text, stdout, logs, credentials, and private case content are excluded.\n\n\`\`\`json\n${json}\n\`\`\`\n`,
  };
}
export function currentReleaseEvidence(file = resolve(import.meta.dirname, '../../release-manifest.json')) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) return null;
    const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const keys = ['commit', 'sourceTreeSha256', 'releaseTreeSha256', 'distTreeSha256', 'prismaSchemaSha256'];
    const result: Record<string, string> = {};
    for (const key of keys) {
      const field = value[key];
      if (typeof field !== 'string' || !(key === 'commit' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(field)) return null;
      result[key] = field;
    }
    return { ...result, context: 'Current Control API release; not proof of the release active during this incident' };
  } catch { return null; }
}

export async function exportIncidentEvidence(id: string) {
  const db = getDb();
  const incident = await db.anomalyEvent.findUnique({ where: { id } });
  if (!incident) throw new HttpError(404, 'NOT_FOUND', 'Incident not found');
  const start = new Date(incident.firstSeenAt.getTime() - 3600000);
  const end = new Date((incident.resolvedAt ?? incident.lastSeenAt).getTime() + 3600000);
  const [health, commands, targets] = await Promise.all([
    db.healthSnapshot.findMany({
      where: { nodeId: incident.nodeId, timestamp: { gte: start, lte: end } },
      take: 20,
      orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        timestamp: true,
        cpuUsagePercent: true,
        memoryPercent: true,
        source: true,
      },
    }),
    db.remoteCommand.findMany({
      where: { nodeId: incident.nodeId, createdAt: { gte: start, lte: end } },
      take: 20,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        status: true,
        createdAt: true,
        completedAt: true,
        correlationId: true,
        result: { select: { exitCode: true } },
      },
    }),
    db.rolloutTarget.findMany({
      where: { nodeId: incident.nodeId, startedAt: { gte: start, lte: end } },
      take: 20,
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, rolloutId: true, status: true, commandId: true, evidence: true },
    }),
  ]);
  const release = currentReleaseEvidence();
  return evidenceEnvelope({
    incidentId: id,
    nodeId: incident.nodeId,
    incident,
    window: { start, end },
    health,
    commands,
    rollouts: targets.map((t) => {
      let e: Record<string, unknown> = {};
      try {
        e = JSON.parse(t.evidence);
      } catch {
        /* missing */
      }
      return {
        id: t.id,
        rolloutId: t.rolloutId,
        status: t.status,
        commandId: t.commandId,
        heartbeatAt: e['heartbeatAt'] ?? null,
        agentVersion: e['agentVersion'] ?? null,
        verifiedAt: e['verifiedAt'] ?? null,
      };
    }),
    limits: { health: 20, commands: 20, targets: 20, maxBytes: 100000 },
    release,
    missing: release ? ['Attach the historical release manifest if the incident preceded this deployment'] : ['Current release manifest unavailable; attach an independently verified deployment manifest'],
    redaction:
      'Allowlisted metadata only; no raw commands, outputs, logs, secrets or asserted cause',
  });
}
