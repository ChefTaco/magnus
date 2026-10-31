import { Hono } from 'hono';
import { z } from 'zod';
import type { AppVariables } from '../types/index.js';
import { getDb } from '../db/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { parseBody } from '../utils/validate.js';
import { logAuditEvent } from '../services/audit-service.js';
import { authenticateRegistryToken, assignSkillTargets, desiredManifest, enrollClient, identity, publishRevision, registryKind, isDeployHost } from '../services/hermes-registry-service.js';
import { requestCoreSlot, settleCoreSlot } from '../services/hermes-core-rollout.js';
import { refreshTrackedSources } from '../services/hermes-plugin-source.js';

export const hermesRegistryRouter = new Hono<AppVariables>();
const client = (c: { req: { header: (name: string) => string | undefined } }, scope: 'pull' | 'submit') =>
  authenticateRegistryToken(c.req.header('x-hermes-registry-token'), scope);

hermesRegistryRouter.post('/clients', authMiddleware, requireRole('ADMIN'), async c => {
  const body = await parseBody(c, z.object({ nodeId: z.string(), installationId: z.string(), canSubmit: z.boolean().default(true) }));
  const result = await enrollClient(body.nodeId, body.installationId, body.canSubmit);
  await logAuditEvent({ action: 'hermes.registry.enroll', actorId: getUser(c).userId, targetType: 'hermes-installation', targetId: body.installationId,
    details: { host: result.host, canPull: result.canPull, canSubmit: result.canSubmit } });
  return c.json({ success: true, data: result }, 201);
});

hermesRegistryRouter.get('/manifest', async c => {
  const { installation } = await client(c, 'pull');
  return c.json({ success: true, data: { installationId: installation.id, components: await desiredManifest(installation.id) } });
});

hermesRegistryRouter.post('/core/slot', async c => {
  const { host, installation } = await client(c, 'pull');
  return c.json({ success: true, data: { ...await requestCoreSlot(host, installation.id), hermesHome: installation.hermesHome,
    hermesBin: installation.hermesBin } });
});

hermesRegistryRouter.post('/core/receipts', async c => {
  const { host, installation } = await client(c, 'pull');
  const body = await parseBody(c, z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), status: z.enum(['applied', 'failed']),
    evidence: z.object({ beforeVersion: z.string().max(100).optional(), afterVersion: z.string().max(100).optional(),
      beforeGatewayActive: z.boolean().optional(), afterGatewayActive: z.boolean().optional(), backupSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      nativeReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), toolCheck: z.boolean().optional(), pluginCheck: z.boolean().optional(),
      error: z.string().max(500).optional() }) }));
  return c.json({ success: true, data: await settleCoreSlot(host, installation.id, body) });
});

hermesRegistryRouter.get('/profiles', async c => {
  const { installation } = await client(c, 'submit');
  const profiles = await getDb().hermesProfile.findMany({ where: { installationId: installation.id }, select: { id: true, profileHome: true } });
  return c.json({ success: true, data: { installationId: installation.id, hermesBin: installation.hermesBin,
    profiles: profiles.length ? profiles : [{ id: '', profileHome: installation.hermesHome }] } });
});

hermesRegistryRouter.post('/tool-surface', async c => {
  const { installation } = await client(c, 'pull');
  const body = await parseBody(c, z.object({ profileId: z.string().default(''), surface: z.array(z.object({
    platform: identity, enabled: z.array(z.string().min(1).max(120)).max(250),
  })).min(1).max(16) }));
  const profile = body.profileId ? await getDb().hermesProfile.findFirst({ where: { id: body.profileId, installationId: installation.id } }) : null;
  if (body.profileId && !profile) throw new HttpError(403, 'INVALID_PROFILE', 'Tool surface profile is not on this installation');
  if (profile) {
    let capabilities: Record<string, unknown> = {};
    try { capabilities = JSON.parse(profile.capabilities) as Record<string, unknown>; } catch { /* replace malformed inventory */ }
    await getDb().hermesProfile.update({ where: { id: profile.id }, data: { capabilities: JSON.stringify({ ...capabilities,
      toolSurface: body.surface, toolSurfaceObservedAt: new Date().toISOString() }) } });
  } else {
    let raw: Record<string, unknown> = {};
    try { raw = JSON.parse(installation.rawStatus) as Record<string, unknown>; } catch { /* replace malformed inventory */ }
    await getDb().hermesInstallation.update({ where: { id: installation.id }, data: { rawStatus: JSON.stringify({ ...raw,
      toolSurface: body.surface, toolSurfaceObservedAt: new Date().toISOString() }) } });
  }
  return c.json({ success: true, data: { profileId: body.profileId, platforms: body.surface.length } });
});

hermesRegistryRouter.get('/policy', async c => {
  const { installation } = await client(c, 'pull');
  const profiles = await getDb().hermesProfile.findMany({ where: { installationId: installation.id }, select: { id: true, profileHome: true } });
  const homes = new Map(profiles.map(profile => [profile.id, profile.profileHome]));
  const rows = await getDb().hermesToolsetPolicy.findMany({ where: { installationId: installation.id } });
  const policies = rows.map(row => {
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(row.metadata) as Record<string, unknown>; } catch { /* malformed metadata is ignored */ }
    const platforms = Array.isArray(metadata['platforms']) ? metadata['platforms'].filter(value => typeof value === 'string' && identity.safeParse(value).success) : ['cli'];
    return { id: row.id, profileId: row.profileId, profileHome: row.profileId ? homes.get(row.profileId) ?? '' : installation.hermesHome,
      hermesBin: installation.hermesBin, toolset: row.toolset, enabled: row.enabled, platforms, approvalMode: row.approvalMode,
      perToolHooks: JSON.parse(row.perToolHooks) as unknown, allowList: JSON.parse(row.allowList) as unknown,
      denyList: JSON.parse(row.denyList) as unknown };
  }).filter(row => !!row.profileHome);
  return c.json({ success: true, data: { policies } });
});

hermesRegistryRouter.post('/policy/receipts', async c => {
  const { installation } = await client(c, 'pull');
  const body = await parseBody(c, z.object({ id: z.string(), status: z.enum(['applied', 'failed', 'unsupported']), error: z.string().max(500).optional() }));
  const row = await getDb().hermesToolsetPolicy.findUnique({ where: { id: body.id } });
  if (!row || row.installationId !== installation.id) throw new HttpError(403, 'INVALID_POLICY', 'Policy is outside this installation');
  await getDb().hermesToolsetPolicy.update({ where: { id: row.id }, data: { status: body.status, lastSyncedAt: new Date(),
    metadata: JSON.stringify({ ...JSON.parse(row.metadata) as Record<string, unknown>, lastRegistryError: body.error ?? null }) } });
  return c.json({ success: true, data: { id: row.id, status: body.status } });
});

hermesRegistryRouter.get('/artifacts/:kind/:slug/:revision', async c => {
  const { installation } = await client(c, 'pull');
  const kind = registryKind.parse(c.req.param('kind'));
  const slug = identity.parse(c.req.param('slug'));
  const number = z.coerce.number().int().positive().parse(c.req.param('revision'));
  const allowed = (await desiredManifest(installation.id)).some(item => item.kind === kind && item.slug === slug && item.revision === number);
  if (!allowed) throw new HttpError(403, 'REGISTRY_TARGET_REQUIRED', 'Artifact is not assigned to this installation');
  const revision = await getDb().hermesRegistryRevision.findUnique({ where: { kind_slug_revision: { kind, slug, revision: number } } });
  if (!revision || revision.status !== 'published') throw new HttpError(404, 'NOT_FOUND', 'Published artifact not found');
  return c.json({ success: true, data: { kind, slug, revision: number, sha256: revision.sha256, artifact: JSON.parse(revision.artifactJson) } });
});

hermesRegistryRouter.post('/capture', async c => {
  const { installation, host } = await client(c, 'submit');
  const body = await parseBody(c, z.object({ slug: identity, profileId: z.string().default(''), artifact: z.unknown().optional(),
    baseRevision: z.number().int().nonnegative().optional(), tags: z.array(identity).max(32).default([]) }));
  if (body.profileId && !(await getDb().hermesProfile.findFirst({ where: { id: body.profileId, installationId: installation.id } })))
    throw new HttpError(403, 'INVALID_PROFILE', 'Profile does not belong to this installation');
  const result = await publishRevision({ kind: 'skill', slug: body.slug, artifact: body.artifact, metadata: { tags: body.tags, authorProfileId: body.profileId },
    sourceHost: host, publishedBy: `node:${installation.id}`, baseRevision: body.baseRevision });
  if (!result.duplicate && result.revision.status === 'published') {
    await assignSkillTargets(body.slug, body.tags, body.profileId, host);
  }
  await logAuditEvent({ action: 'hermes.registry.capture', actorId: `node:${installation.id}`, targetType: 'hermes-skill', targetId: body.slug,
    details: { revision: result.revision.revision, status: result.revision.status, duplicate: result.duplicate, host } });
  return c.json({ success: true, data: { revision: result.revision.revision, sha256: result.revision.sha256, status: result.revision.status, duplicate: result.duplicate } }, result.duplicate ? 200 : 201);
});

hermesRegistryRouter.post('/receipts', async c => {
  const { installation, node } = await client(c, 'pull');
  const body = await parseBody(c, z.object({ kind: registryKind, slug: identity, profileId: z.string().default(''), revision: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), status: z.enum(['applied', 'drifted', 'failed', 'busy', 'unsupported']), details: z.record(z.string(), z.unknown()).default({}) }));
  const target = await getDb().hermesRegistryTarget.findUnique({ where: { kind_slug_installationId_profileId: {
    kind: body.kind, slug: body.slug, installationId: installation.id, profileId: body.profileId } } });
  const revision = await getDb().hermesRegistryRevision.findUnique({ where: { kind_slug_revision: { kind: body.kind, slug: body.slug, revision: body.revision } } });
  if (!target || !revision || revision.sha256 !== body.sha256) throw new HttpError(403, 'REGISTRY_RECEIPT_INVALID', 'Receipt does not match an assigned revision');
  const desired = (await desiredManifest(installation.id)).find(item => item.kind === body.kind && item.slug === body.slug
    && item.profileId === body.profileId);
  if (!desired || desired.revision !== body.revision || desired.sha256 !== body.sha256)
    throw new HttpError(409, 'REGISTRY_RECEIPT_STALE', 'Receipt no longer matches the desired immutable revision');
  const data = await getDb().hermesRegistryReceipt.create({ data: { nodeId: node.id, installationId: installation.id, profileId: body.profileId,
    kind: body.kind, slug: body.slug, revision: body.revision, sha256: body.sha256, status: body.status,
    detailsJson: JSON.stringify(body.details) } });
  await getDb().hermesRegistryTarget.update({ where: { id: target.id }, data: { observedRevision: body.status === 'applied' ? body.revision : target.observedRevision,
    status: body.status, lastReceiptAt: data.createdAt, error: body.status === 'applied' ? null : String(body.details['error'] ?? body.status).slice(0, 500) } });
  return c.json({ success: true, data: { receiptId: data.id } }, 201);
});

hermesRegistryRouter.post('/inventory', async c => {
  const { installation } = await client(c, 'pull');
  const item = z.object({ profileId: z.string().default(''), kind: z.enum(['plugin', 'mcp']), slug: identity,
    pluginType: z.enum(['general', 'memory-provider', 'context-engine', 'transport', 'provider']).nullable().default(null),
    sourceKind: z.enum(['bundled', 'git', 'pip', 'local', 'remote', 'unknown']), sourceUrl: z.string().url().nullable().default(null),
    commit: z.string().regex(/^[a-f0-9]{40}$/).nullable().default(null), version: z.string().max(100).nullable().default(null),
    status: z.string().max(100) });
  const body = await parseBody(c, z.object({ items: z.array(item).max(500) }));
  for (const observed of body.items) {
    if (observed.sourceUrl) {
      const source = new URL(observed.sourceUrl);
      if (source.protocol !== 'https:' || source.username || source.password || source.search || source.hash)
        throw new HttpError(400, 'INVALID_SOURCE', 'Inventory source URL must be public and free of credentials');
    }
    if (observed.profileId && !(await getDb().hermesProfile.findFirst({ where: { id: observed.profileId, installationId: installation.id } })))
      throw new HttpError(403, 'INVALID_PROFILE', 'Inventory profile is not on this installation');
    await getDb().hermesRegistryInventory.upsert({ where: { installationId_profileId_kind_slug: { installationId: installation.id,
      profileId: observed.profileId, kind: observed.kind, slug: observed.slug } },
    create: { installationId: installation.id, ...observed }, update: { ...observed, observedAt: new Date() } });
  }
  return c.json({ success: true, data: { count: body.items.length } });
});

hermesRegistryRouter.post('/revisions', authMiddleware, requireRole('ADMIN', 'OPERATOR'), async c => {
  const body = await parseBody(c, z.object({ kind: registryKind, slug: identity, artifact: z.unknown().optional(), metadata: z.record(z.string(), z.unknown()).default({}), baseRevision: z.number().int().nonnegative().optional() }));
  if (body.artifact === undefined) throw new HttpError(400, 'INVALID_ARTIFACT', 'Artifact is required');
  const result = await publishRevision({ ...body, artifact: body.artifact, publishedBy: getUser(c).userId });
  await logAuditEvent({ action: 'hermes.registry.publish', actorId: getUser(c).userId, targetType: body.kind, targetId: body.slug,
    details: { revision: result.revision.revision, status: result.revision.status } });
  return c.json({ success: true, data: { revision: result.revision.revision, sha256: result.revision.sha256, status: result.revision.status, duplicate: result.duplicate } }, 201);
});

hermesRegistryRouter.post('/sources/refresh', authMiddleware, requireRole('ADMIN', 'OPERATOR'), async c => {
  const results = await refreshTrackedSources();
  await logAuditEvent({ action: 'hermes.registry.publish', actorId: getUser(c).userId, targetType: 'hermes-plugin-source', targetId: 'refresh',
    details: { results: results.map(row => ({ kind: row.kind, slug: row.slug, status: row.status, commit: row.commit })) } });
  return c.json({ success: true, data: results });
});

hermesRegistryRouter.post('/targets', authMiddleware, requireRole('ADMIN', 'OPERATOR'), async c => {
  const body = await parseBody(c, z.object({ kind: registryKind, slug: identity, installationId: z.string(), profileId: z.string().default(''),
    pinnedRevision: z.number().int().positive().nullable().default(null), enabled: z.boolean().default(true) }));
  const installation = await getDb().hermesInstallation.findUnique({ where: { id: body.installationId } });
  if (!installation || !isDeployHost(installation.hostname.split('.')[0]!.toLowerCase()))
    throw new HttpError(403, 'REGISTRY_PULL_DISABLED', 'Only named rollout hosts may be assigned');
  if (body.profileId && !(await getDb().hermesProfile.findFirst({ where: { id: body.profileId, installationId: body.installationId } })))
    throw new HttpError(400, 'INVALID_PROFILE', 'Profile is not on the target installation');
  if (body.pinnedRevision !== null && !(await getDb().hermesRegistryRevision.findFirst({ where: {
    kind: body.kind, slug: body.slug, revision: body.pinnedRevision, status: 'published' } })))
    throw new HttpError(400, 'INVALID_PIN', 'Pinned revision is not published');
  if (body.kind === 'plugin' && body.enabled) {
    const release = await getDb().hermesRegistryRevision.findFirst({ where: { kind: 'plugin', slug: body.slug, status: 'published',
      ...(body.pinnedRevision === null ? {} : { revision: body.pinnedRevision }) }, orderBy: { revision: 'desc' } });
    if (!release) throw new HttpError(400, 'INVALID_TARGET', 'Plugin has no published release');
    if ((JSON.parse(release.metadataJson) as Record<string, unknown>)['consentRequiresPreinstalledTarget'] === true) {
      const commit = (JSON.parse(release.artifactJson) as { commit: string }).commit;
      const installed = await getDb().hermesRegistryInventory.findUnique({ where: { installationId_profileId_kind_slug: {
        installationId: body.installationId, profileId: body.profileId, kind: 'plugin', slug: body.slug } } });
      if (!installed || installed.commit !== commit || !/^(enabled|loaded|active)$/i.test(installed.status.trim()))
        throw new HttpError(409, 'CONSENT_NOT_INSTALLED', 'Target must install the consented plugin commit interactively before enrollment');
    }
  }
  if (body.kind === 'mcp') {
    const release = await getDb().hermesRegistryRevision.findFirst({ where: { kind: 'mcp', slug: body.slug, status: 'published',
      ...(body.pinnedRevision === null ? {} : { revision: body.pinnedRevision }) }, orderBy: { revision: 'desc' } });
    if (!release || (JSON.parse(release.artifactJson) as { ownerHost: string }).ownerHost.toLowerCase() !== installation.hostname.split('.')[0]!.toLowerCase())
      throw new HttpError(403, 'MCP_OWNER_MISMATCH', 'MCP backend must be assigned to its owning host');
  }
  const row = await getDb().hermesRegistryTarget.upsert({ where: { kind_slug_installationId_profileId: { kind: body.kind, slug: body.slug,
    installationId: body.installationId, profileId: body.profileId } }, create: body, update: { pinnedRevision: body.pinnedRevision, enabled: body.enabled, status: 'pending' } });
  await logAuditEvent({ action: 'hermes.registry.target', actorId: getUser(c).userId, targetType: body.kind, targetId: body.slug,
    details: { installationId: body.installationId, profileId: body.profileId, pinnedRevision: body.pinnedRevision, enabled: body.enabled } });
  return c.json({ success: true, data: row });
});

hermesRegistryRouter.post('/revisions/:kind/:slug/:revision/consent', authMiddleware, requireRole('ADMIN'), async c => {
  const kind = registryKind.parse(c.req.param('kind'));
  const slug = identity.parse(c.req.param('slug'));
  const revision = z.coerce.number().int().positive().parse(c.req.param('revision'));
  if (kind === 'skill') throw new HttpError(400, 'INVALID_CONSENT', 'Skill conflicts require a new reviewed revision');
  const body = await parseBody(c, z.object({ evidence: z.string().min(20).max(2000) }));
  const row = await getDb().hermesRegistryRevision.findUnique({ where: { kind_slug_revision: { kind, slug, revision } } });
  if (!row || row.status !== 'needs-consent') throw new HttpError(409, 'CONSENT_NOT_PENDING', 'Revision is not waiting for consent');
  if (kind === 'plugin') {
    const release = JSON.parse(row.artifactJson) as { commit: string };
    const targets = await getDb().hermesRegistryTarget.findMany({ where: { kind: 'plugin', slug, enabled: true } });
    const observed = await getDb().hermesRegistryInventory.findMany({ where: { kind: 'plugin', slug, commit: release.commit } });
    const missing = targets.filter(target => !observed.some(item => item.installationId === target.installationId
      && item.profileId === target.profileId && /^(enabled|loaded|active)$/i.test(item.status.trim())));
    if (missing.length) throw new HttpError(409, 'CONSENT_NOT_INSTALLED',
      'Each enabled target must first install this commit and grant capabilities interactively');
  }
  await getDb().hermesRegistryRevision.update({ where: { id: row.id }, data: { status: 'published', metadataJson: JSON.stringify({
    ...JSON.parse(row.metadataJson) as Record<string, unknown>, consentEvidence: body.evidence, consentBy: getUser(c).userId,
    consentRequiresPreinstalledTarget: kind === 'plugin' }) } });
  await logAuditEvent({ action: 'hermes.registry.publish', actorId: getUser(c).userId, targetType: kind, targetId: slug,
    details: { revision, consentRecorded: true } });
  return c.json({ success: true, data: { kind, slug, revision, status: 'published' } });
});

hermesRegistryRouter.put('/profile-groups/:profileId', authMiddleware, requireRole('ADMIN', 'OPERATOR'), async c => {
  const profileId = identity.parse(c.req.param('profileId'));
  const body = await parseBody(c, z.object({ groups: z.array(identity).max(32) }));
  const profile = await getDb().hermesProfile.findUnique({ where: { id: profileId }, include: { installation: true } });
  if (!profile || !isDeployHost(profile.installation.hostname.split('.')[0]!.toLowerCase()))
    throw new HttpError(403, 'REGISTRY_PULL_DISABLED', 'Profile is not on a named rollout host');
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(profile.metadata) as Record<string, unknown>; } catch { /* replace malformed metadata */ }
  await getDb().hermesProfile.update({ where: { id: profileId }, data: { metadata: JSON.stringify({ ...metadata, groups: [...new Set(body.groups)] }) } });
  await logAuditEvent({ action: 'hermes.registry.target', actorId: getUser(c).userId, targetType: 'hermes-profile', targetId: profileId,
    details: { groups: body.groups } });
  return c.json({ success: true, data: { profileId, groups: body.groups } });
});

hermesRegistryRouter.get('/status', authMiddleware, async c => {
  const [targets, clients, revisions, inventory, coreRollouts] = await Promise.all([
    getDb().hermesRegistryTarget.findMany({ orderBy: { updatedAt: 'desc' } }),
    getDb().hermesRegistryClient.findMany({ select: { nodeId: true, installationId: true, canPull: true, canSubmit: true, enabled: true, revokedAt: true } }),
    getDb().hermesRegistryRevision.findMany({ select: { kind: true, slug: true, revision: true, sha256: true, status: true, sourceHost: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 500 }),
    getDb().hermesRegistryInventory.findMany({ orderBy: { observedAt: 'desc' }, take: 1000 }),
    getDb().hermesCoreRollout.findMany({ include: { hosts: true }, orderBy: { createdAt: 'desc' }, take: 10 }),
  ]);
  return c.json({ success: true, data: { targets, clients, revisions, inventory, coreRollouts } });
});
