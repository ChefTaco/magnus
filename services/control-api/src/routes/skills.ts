import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { getDb } from '../db/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { logAuditEvent } from '../services/audit-service.js';
import { HttpError } from '../middleware/error-handler.js';
import * as skillService from '../services/skill-service.js';
import * as registryService from '../services/skill-registry-service.js';
import { parseBody } from '../utils/validate.js';
import {
  createSkillSchema,
  updateSkillSchema,
  updateSkillFileSchema,
  pushSkillSchema,
  publishVersionSchema,
  setTagSchema,
} from '../schemas/skills.js';
import { enforceIdempotencyFromHeader } from '../utils/idempotency.js';
import { NodeApiClient } from '../sdk/index.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { buildSkillPublicationBundle } from '../services/skill-publication-bundle.js';
import { isExactInstalledPublication, isSameSkillPublication, nextSkillPublicationCommandId, skillPublicationCommandId,
  type SkillPublicationIdentity } from '../services/skill-publication-state.js';
import { httpIdentity } from '../security/managed-http.js';
import { commandRequestDigest } from '../security/command-request.js';
import { commandFenceSchema } from '../schemas/node-responses.js';
import { retainUnknownResourceCommand } from '../services/command-resource-leases.js';
import { isSkillPublicationNoEffectSettlement } from '../services/skill-publication-settlement.js';

export const skillsRouter = new Hono<AppVariables>();
skillsRouter.use('*', authMiddleware);

// ── List all skills (filesystem, merged with install counts from DB) ──
skillsRouter.get('/', async (c) => {
  const db = getDb();
  const skills = await skillService.listSkills();

  // Gather install counts from DB
  const installations = await db.skillInstallation.findMany({
    select: { skillName: true, nodeId: true, status: true, version: true },
  });

  const installMap = new Map<string, Array<{ nodeId: string; status: string; version: string }>>();
  for (const inst of installations) {
    const list = installMap.get(inst.skillName) ?? [];
    list.push({ nodeId: inst.nodeId, status: inst.status, version: inst.version });
    installMap.set(inst.skillName, list);
  }

  const data = skills.map((s) => ({
    ...s,
    installations: installMap.get(s.name) ?? [],
  }));

  return c.json({ success: true, data });
});

// ── Get a single skill ──
skillsRouter.get('/:name{[a-zA-Z0-9_-]+}', async (c) => {
  const name = c.req.param('name')!;
  const skill = await skillService.getSkill(name);
  if (!skill) throw new HttpError(404, 'NOT_FOUND', 'Skill not found');
  return c.json({ success: true, data: skill });
});

// ── Read a file from a skill directory ──
skillsRouter.get('/:name{[a-zA-Z0-9_-]+}/files/:fileName', async (c) => {
  const name = c.req.param('name')!;
  const fileName = c.req.param('fileName')!;
  const content = await skillService.getSkillFile(name, fileName);
  if (content === null) throw new HttpError(404, 'NOT_FOUND', 'File not found');
  return c.json({ success: true, data: { fileName, content } });
});

// ── Update (or create) a file within a skill directory ──
skillsRouter.put('/:name{[a-zA-Z0-9_-]+}/files/:fileName', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const name = c.req.param('name')!;
  const fileName = c.req.param('fileName')!;
  const body = await parseBody(c, updateSkillFileSchema);

  const skill = await skillService.getSkill(name);
  if (!skill) throw new HttpError(404, 'NOT_FOUND', 'Skill not found');

  await skillService.updateSkillFile(name, fileName, body.content);

  await logAuditEvent({
    action: 'skill.file.update',
    actorId: user.userId,
    targetType: 'skill',
    targetId: name,
    details: { fileName },
  });

  return c.json({ success: true, data: { fileName } });
});

// ── Create a new skill ──
skillsRouter.post('/', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const body = await parseBody(c, createSkillSchema);

  try {
    const skill = await skillService.createSkill({
      name: body.name,
      version: body.version,
      description: body.description,
      author: user.email,
      entryPoint: body.entryPoint,
      dependencies: body.dependencies,
      tags: body.tags,
    });

    await logAuditEvent({
      action: 'skill.create',
      actorId: user.userId,
      targetType: 'skill',
      targetId: skill.name,
      details: { name: body.name, version: body.version },
    });

    return c.json({ success: true, data: skill }, 201);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('already exists')) {
      throw new HttpError(409, 'CONFLICT', err.message);
    }
    throw err;
  }
});

// ── Push skill to nodes ──
skillsRouter.post('/push', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const body = await parseBody(c, pushSkillSchema);

  const nodeIds = body.nodeIds;
  const skillName = body.skillName;

  const skill = await skillService.getSkill(skillName);
  if (!skill) throw new HttpError(404, 'NOT_FOUND', 'Skill not found');

  // Look up registry entry for provenance linking
  const version = body.version ?? skill.version;
  const registryEntry = await db.skillRegistryEntry.findUnique({
    where: { slug: skillName },
    include: { versions: { where: { version }, take: 1 } },
  });
  const publishedVersion = registryEntry?.versions[0];
  if (!registryEntry || !publishedVersion) throw new HttpError(409, 'SKILL_VERSION_UNPUBLISHED',
    'The exact skill version must be published before it can be installed');
  const publication = await buildSkillPublicationBundle({ skillName, version,
    registryContentSha256: publishedVersion.contentHash, registryFilesJson: publishedVersion.files });

  // Fetch node connection details for all target nodes
  const nodes = await db.node.findMany({
    where: { id: { in: nodeIds } },
    select: { id: true, hostname: true, ipAddress: true, port: true, status: true },
  });
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const missing = nodeIds.find((nodeId) => !nodeMap.has(nodeId));
  if (missing) throw new HttpError(404, 'NODE_NOT_FOUND', `Node ${missing} is not in inventory`);

  // Claim after validation/preview/preflight so a rejected retry is not a duplicate.
  await enforceIdempotencyFromHeader(c);
  const installations = await Promise.all(
    nodeIds.map(async (nodeId) => {
      const node = nodeMap.get(nodeId);
      if (!node) throw new HttpError(404, 'NODE_NOT_FOUND', `Node ${nodeId} is not in inventory`);
      const identity: SkillPublicationIdentity = { nodeId, skillName, version,
        versionHash: publishedVersion.contentHash, bundleSha256: publication.bundleSha256,
        treeSha256: publication.treeSha256 };
      const prepared = await db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`skill-publication:${nodeId}:${skillName}`}, 0))`;
        const existing = await tx.skillInstallation.findUnique({ where: { skillName_nodeId: { skillName, nodeId } } });
        const same = !!existing && isSameSkillPublication(existing, identity);
        if (existing && isExactInstalledPublication(existing, identity)) return { kind: 'installed' as const, install: existing };
        if (existing?.status === 'installing' && !same) throw new HttpError(409, 'SKILL_PUBLICATION_BUSY',
          'A different skill publication still owns this installation workflow');

        // A released/no-dispatch lease cannot be reused for admission. Walk a
        // deterministic, evidence-bound retry chain until its exact current
        // generation is either unused or still requires recovery.
        let workflowCommandId = skillPublicationCommandId(identity);
        for (let generation = 0; generation < 64; generation += 1) {
          const lease = await tx.commandResourceLease.findUnique({ where: { commandId: workflowCommandId },
            select: { state: true, settlement: true } });
          if (!lease) {
            if (await tx.remoteCommand.findUnique({ where: { id: workflowCommandId }, select: { id: true } }))
              throw new HttpError(409, 'SKILL_PUBLICATION_BUSY',
                'The exact publication command lost its durable authority record and cannot be replayed');
            break;
          }
          if (lease.state !== 'released'
            || (lease.settlement !== 'not-dispatched' && !isSkillPublicationNoEffectSettlement(lease.settlement))) break;
          workflowCommandId = nextSkillPublicationCommandId(identity, workflowCommandId);
          if (generation === 63) throw new HttpError(409, 'SKILL_PUBLICATION_BUSY',
            'Skill publication exceeded its bounded no-effect retry generations');
        }

        // A prior successor may be bypassed only with durable proof that its
        // dispatch barrier was never crossed. Command status alone cannot prove
        // no effect: failed/cancelled commands can still retain unknown ownership.
        if (existing?.status === 'installed') {
          const latest = await tx.remoteCommand.findFirst({ where: {
            createdBy: `skill-installation:${existing.id}`,
          }, orderBy: { createdAt: 'desc' }, select: { id: true } });
          if (latest && latest.id !== existing.workflowCommandId && latest.id !== workflowCommandId) {
            const latestLease = await tx.commandResourceLease.findUnique({ where: { commandId: latest.id },
              select: { state: true, settlement: true } });
            const provedNoEffect = !!latestLease && latestLease.state === 'released'
              && (latestLease.settlement === 'not-dispatched'
                || isSkillPublicationNoEffectSettlement(latestLease.settlement));
            if (!provedNoEffect) throw new HttpError(409, 'SKILL_PUBLICATION_BUSY',
              'A prior successor has unresolved or effect evidence that must be correlated before another publication');
          }
          return { kind: 'successor' as const, install: existing, workflowCommandId };
        }

        const install = await tx.skillInstallation.upsert({
          where: { skillName_nodeId: { skillName, nodeId } },
          update: { status: 'installing', version, registryEntryId: registryEntry.id,
            versionHash: publishedVersion.contentHash, bundleSha256: publication.bundleSha256,
            treeSha256: publication.treeSha256, workflowCommandId,
            workflowRequestSha256: null, workflowReceiptSha256: null, installedAt: null, error: null },
          create: { skillName, nodeId, version, status: 'installing', registryEntryId: registryEntry.id,
            versionHash: publishedVersion.contentHash, bundleSha256: publication.bundleSha256,
            treeSha256: publication.treeSha256, workflowCommandId },
        });
        return { kind: 'attempt' as const, install, workflowCommandId };
      });
      const install = prepared.install;
      if (prepared.kind === 'installed') return { nodeId, status: install.status, installationId: install.id };
      const candidateCommandId = prepared.workflowCommandId;
      try {
        const client = new NodeApiClient({ baseUrl: getNodeBaseUrl(node.ipAddress, node.port),
          resourceNodeId: node.id, resourceActorId: `skill-installation:${install.id}`, nodeToken: getNodeManagerSecret() });
        const payload = { skillName, version, bundleSha256: publication.bundleSha256, bundle: publication.bundle };
        const priorLease = await db.commandResourceLease.findUnique({ where: { commandId: candidateCommandId } });
        let evidence; let publishedAt: Date;
        if (priorLease) {
          const command = await db.remoteCommand.findUnique({ where: { id: candidateCommandId } });
          const coordination = commandFenceSchema.parse(JSON.parse(priorLease.coordinationJson));
          const commandIdentity = { ...httpIdentity(candidateCommandId, 'POST', '/skills/install', JSON.stringify(payload),
            command?.timeoutSeconds ?? 0), coordination };
          if (!command || command.nodeId !== node.id || priorLease.nodeId !== node.id
            || priorLease.ownerActor !== `skill-installation:${install.id}`
            || command.command !== commandIdentity.command || command.args !== JSON.stringify(commandIdentity.args)
            || commandRequestDigest(commandIdentity) !== priorLease.requestSha256)
            throw new Error('Retained skill workflow identity differs from the requested publication');
          if (priorLease.state === 'reserved') {
            await retainUnknownResourceCommand(candidateCommandId);
            throw new Error('Skill publication ended before dispatch and committed no effect');
          }
          if (['running', 'unknown', 'released'].includes(priorLease.state)) {
            const recovered = await client.recoverSkillBundle(payload, { leaseId: priorLease.id,
              commandId: candidateCommandId, nodeId: node.id, nodeFqdn: node.hostname,
              requestSha256: priorLease.requestSha256, timeoutSeconds: command.timeoutSeconds, coordination });
            const installed = recovered.response.data;
            if (!recovered.response.success || installed.skillName !== skillName || installed.version !== version
              || installed.nodeId !== node.id || installed.status !== 'installed'
              || installed.bundleSha256 !== publication.bundleSha256 || installed.treeSha256 !== publication.treeSha256
              || installed.commandId !== recovered.evidence.commandId
              || installed.requestSha256 !== recovered.evidence.commandSha256)
              throw new Error('Recovered skill publication differs from the exact workflow and bundle');
            evidence = recovered.evidence; publishedAt = new Date(installed.publishedAt);
          } else throw new Error('Skill publication owner state is not recoverable');
        } else {
          const result = await client.publishSkillBundle(payload, candidateCommandId);
          const installed = result.response.data;
          if (!result.response.success || installed.skillName !== skillName || installed.version !== version
            || installed.nodeId !== node.id || installed.status !== 'installed'
            || installed.bundleSha256 !== publication.bundleSha256 || installed.treeSha256 !== publication.treeSha256
            || installed.commandId !== result.evidence.commandId || installed.requestSha256 !== result.evidence.commandSha256)
            throw new Error('Skill publication result differs from the exact workflow, bundle or signed receipt');
          evidence = result.evidence; publishedAt = new Date(installed.publishedAt);
        }
        const successorWhere = prepared.kind === 'successor' ? { id: install.id, status: 'installed',
          version: install.version, registryEntryId: install.registryEntryId, versionHash: install.versionHash,
          bundleSha256: install.bundleSha256,
          treeSha256: install.treeSha256, workflowCommandId: install.workflowCommandId,
          workflowRequestSha256: install.workflowRequestSha256,
          workflowReceiptSha256: install.workflowReceiptSha256, installedAt: install.installedAt, error: install.error }
          : { id: install.id, workflowCommandId: evidence.commandId, status: 'installing',
              version, registryEntryId: registryEntry.id, versionHash: publishedVersion.contentHash,
              bundleSha256: publication.bundleSha256, treeSha256: publication.treeSha256,
              workflowReceiptSha256: null };
        const changed = await db.skillInstallation.updateMany({ where: successorWhere,
          data: { status: 'installed', version, registryEntryId: registryEntry.id,
            versionHash: publishedVersion.contentHash, bundleSha256: publication.bundleSha256,
            treeSha256: publication.treeSha256, workflowCommandId: evidence.commandId,
            installedAt: publishedAt, workflowRequestSha256: evidence.commandSha256,
            workflowReceiptSha256: evidence.receiptSha256, error: null } });
        if (changed.count !== 1) {
          const settled = await db.skillInstallation.findUnique({ where: { id: install.id } });
          if (!settled || !isExactInstalledPublication(settled, identity, evidence))
            throw new Error('Skill publication workflow changed before receipt correlation');
        }
        await logAuditEvent({ action: 'skill.install.receipt', actorId: user.userId,
          targetType: 'skill-installation', targetId: install.id, details: { nodeId, skillName, version,
            bundleSha256: publication.bundleSha256, treeSha256: publication.treeSha256,
            commandId: evidence.commandId, commandSha256: evidence.commandSha256,
            receiptSha256: evidence.receiptSha256 } }).catch(() => {
          console.warn(`[skills] Installed receipt for "${skillName}" was persisted but its audit append failed`);
        });
        return { nodeId, status: 'installed', installationId: install.id };
      } catch (error) {
        const lease = await db.commandResourceLease.findUnique({ where: { commandId: candidateCommandId } });
        const uncertain = lease && ['reserved', 'running', 'unknown'].includes(lease.state);
        if (prepared.kind === 'attempt') await db.skillInstallation.updateMany({ where: { id: install.id,
          workflowCommandId: candidateCommandId, status: 'installing', version,
          versionHash: publishedVersion.contentHash, bundleSha256: publication.bundleSha256,
          treeSha256: publication.treeSha256, workflowReceiptSha256: null },
          data: { status: uncertain ? 'installing' : 'failed',
            error: uncertain ? 'Publication outcome is unresolved; inspect the exact workflow receipt before retrying'
              : 'Publication failed before a verified installed receipt' } });
        console.warn(`[skills] Failed to publish "${skillName}" on node ${nodeId}`);
        return { nodeId, status: uncertain ? 'installing' : 'failed', installationId: install.id };
      }
    }),
  );

  await logAuditEvent({
    action: 'skill.push',
    actorId: user.userId,
    targetType: 'skill',
    targetId: skillName,
    details: { nodeIds, version, bundleSha256: publication.bundleSha256, treeSha256: publication.treeSha256 },
  });

  return c.json({ success: true, data: { installations } }, 201);
});

// ── Get installations for a node ──
skillsRouter.get('/installations/:nodeId', async (c) => {
  const db = getDb();
  const nodeId = c.req.param('nodeId')!;

  const installations = await db.skillInstallation.findMany({
    where: { nodeId },
  });

  return c.json({ success: true, data: installations });
});

// ── Update skill manifest ──
skillsRouter.patch('/:name{[a-zA-Z0-9_-]+}', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const name = c.req.param('name')!;
  const body = await parseBody(c, updateSkillSchema);

  const existing = await skillService.getSkill(name);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Skill not found');

  const skill = await skillService.updateSkill(name, {
    version: body.version,
    description: body.description,
    entryPoint: body.entryPoint,
    tags: body.tags,
    dependencies: body.dependencies,
  });

  await logAuditEvent({
    action: 'skill.update',
    actorId: user.userId,
    targetType: 'skill',
    targetId: name,
    details: { name, version: body.version, description: body.description, entryPoint: body.entryPoint },
  });

  return c.json({ success: true, data: skill });
});

// ── Delete skill ──
skillsRouter.delete('/:name{[a-zA-Z0-9_-]+}', requireRole('ADMIN'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const name = c.req.param('name')!;

  const existing = await skillService.getSkill(name);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Skill not found');

  // Remove DB installations, then delete skill directory
  await db.skillInstallation.deleteMany({ where: { skillName: name } });
  await skillService.deleteSkill(name);

  await logAuditEvent({
    action: 'skill.delete',
    actorId: user.userId,
    targetType: 'skill',
    targetId: name,
    details: { name: existing.name, version: existing.version },
  });

  return c.json({ success: true, data: { deleted: true } });
});

// ════════════════════════════════════════════════
//  Registry — versioned skill lifecycle
// ════════════════════════════════════════════════

// ── List all registry entries ──
skillsRouter.get('/registry', async (c) => {
  const data = await registryService.listRegistryEntries();
  return c.json({ success: true, data });
});

// ── Sync filesystem skills into registry ──
skillsRouter.post('/registry/sync', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);

  const result = await registryService.syncFromFilesystem(user.userId);

  await logAuditEvent({
    action: 'skill.registry.sync',
    actorId: user.userId,
    targetType: 'skill_registry',
    targetId: 'all',
    details: { created: result.created.length, updated: result.updated.length, skipped: result.skipped.length },
  });

  return c.json({ success: true, data: result });
});

// ── Get single registry entry ──
skillsRouter.get('/registry/:slug', async (c) => {
  const slug = c.req.param('slug')!;
  const data = await registryService.getRegistryEntry(slug);
  if (!data) throw new HttpError(404, 'NOT_FOUND', 'Skill not found in registry');
  return c.json({ success: true, data });
});

// ── Publish a new version ──
skillsRouter.post('/registry/:slug/publish', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const slug = c.req.param('slug')!;
  const body = await parseBody(c, publishVersionSchema);

  try {
    const result = await registryService.publishVersion({
      slug,
      version: body.version,
      changelog: body.changelog,
      tagNames: body.tags,
      publishedBy: user.userId,
    });

    await logAuditEvent({
      action: 'skill.registry.publish',
      actorId: user.userId,
      targetType: 'skill_registry',
      targetId: slug,
      details: { version: body.version },
    });

    return c.json({ success: true, data: result }, 201);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('already exists')) {
      throw new HttpError(409, 'CONFLICT', err.message);
    }
    if (err instanceof Error && err.message.includes('not found')) {
      throw new HttpError(404, 'NOT_FOUND', err.message);
    }
    throw err;
  }
});

// ── Get version history for a skill ──
skillsRouter.get('/registry/:slug/versions', async (c) => {
  const slug = c.req.param('slug')!;
  const data = await registryService.getVersions(slug);
  return c.json({ success: true, data });
});

// ── Get version detail ──
skillsRouter.get('/registry/:slug/versions/:version', async (c) => {
  const slug = c.req.param('slug')!;
  const version = c.req.param('version')!;
  const data = await registryService.getVersionDetail(slug, version);
  if (!data) throw new HttpError(404, 'NOT_FOUND', 'Version not found');
  return c.json({ success: true, data });
});

// ── Set/move a tag ──
skillsRouter.post('/registry/:slug/tags', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const slug = c.req.param('slug')!;
  const body = await parseBody(c, setTagSchema);

  try {
    const data = await registryService.setTag(slug, body.tag, body.versionId);

    await logAuditEvent({
      action: 'skill.registry.tag',
      actorId: user.userId,
      targetType: 'skill_registry',
      targetId: slug,
      details: { tag: body.tag, versionId: body.versionId },
    });

    return c.json({ success: true, data });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('not found')) {
      throw new HttpError(404, 'NOT_FOUND', err.message);
    }
    throw err;
  }
});

// ── Delete registry entry ──
skillsRouter.delete('/registry/:slug', requireRole('ADMIN'), async (c) => {
  const user = getUser(c);
  const slug = c.req.param('slug')!;

  try {
    await registryService.deleteRegistryEntry(slug);

    await logAuditEvent({
      action: 'skill.registry.delete',
      actorId: user.userId,
      targetType: 'skill_registry',
      targetId: slug,
      details: {},
    });

    return c.json({ success: true, data: { deleted: true } });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('not found')) {
      throw new HttpError(404, 'NOT_FOUND', err.message);
    }
    throw err;
  }
});
