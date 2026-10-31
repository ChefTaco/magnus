import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { parseBody } from '../utils/validate.js';
import { logAuditEvent } from '../services/audit-service.js';
import {
  credentialPoolAttachSchema,
  credentialPoolCreateSchema,
  credentialPoolUpdateSchema,
  hermesCronJobCreateSchema,
  hermesCronJobUpdateSchema,
  hermesHookCreateSchema,
  hermesHookUpdateSchema,
  hermesPluginCreateSchema,
  hermesRoleApplySchema,
  hermesRoleCreateSchema,
  hermesRoleUpdateSchema,
  mcpServerAttachSchema,
  mcpServerCreateSchema,
  mcpServerUpdateSchema,
  messagingBindingCreateSchema,
  messagingBindingUpdateSchema,
  providerConfigSchema,
  skillAssignmentCreateSchema,
  skillAssignmentUpdateSchema,
  toolsetPolicyCreateSchema,
  toolsetPolicyUpdateSchema,
} from '../schemas/orchestra.js';
import * as svc from '../services/orchestra-resources-service.js';
import {
  applySkillBundle,
  auditSkillCatalogEntry,
  cancelHermesJob,
  getOrchestraCapabilityInventory,
  getOrchestraOverview,
  getSkillCatalog,
  installCatalogSkill,
  previewSkillBundle,
  quarantineCatalogSkill,
} from '../services/orchestra-extras-service.js';

export const orchestraRouter = new Hono<AppVariables>();

orchestraRouter.use('*', authMiddleware);

// ── Overview, catalog, job cancel ───────────────────────────────────────────
orchestraRouter.get('/overview', async (c) => {
  const data = await getOrchestraOverview();
  return c.json({ success: true, data });
});

orchestraRouter.get('/capabilities', async (c) => {
  const data = await getOrchestraCapabilityInventory();
  return c.json({ success: true, data });
});

orchestraRouter.get('/skill-catalog', async (c) => {
  const data = await getSkillCatalog();
  return c.json({ success: true, data });
});


orchestraRouter.get('/skill-catalog/:slug/audit', async (c) => {
  const slug = requiredParam('slug', c.req.param('slug'));
  const data = await auditSkillCatalogEntry(slug);
  return c.json({ success: true, data });
});

orchestraRouter.post('/skill-catalog/install', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const body = await c.req.json().catch(() => ({})) as { slug?: string; installationId?: string; profileId?: string | null; pinnedVersion?: string | null; source?: string };
  if (!body.slug || !body.installationId) throw new HttpError(400, 'VALIDATION_ERROR', 'slug and installationId are required');
  const data = await installCatalogSkill({ ...body, slug: body.slug, installationId: body.installationId, actorId: user.userId });
  await logAuditEvent({ action: 'orchestra.skill_catalog.install', actorId: user.userId, targetType: 'hermes-skill-assignment', targetId: data.id, details: { slug: body.slug, installationId: body.installationId, profileId: body.profileId ?? null } });
  return c.json({ success: true, data }, 201);
});

orchestraRouter.post('/skill-catalog/:slug/quarantine', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const slug = requiredParam('slug', c.req.param('slug'));
  const data = await quarantineCatalogSkill(slug, user.userId);
  await logAuditEvent({ action: 'orchestra.skill_catalog.quarantine', actorId: user.userId, targetType: 'hermes-skill', targetId: slug, details: data });
  return c.json({ success: true, data });
});

orchestraRouter.post('/skill-bundles/preview', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { slugs?: string[]; installationId?: string; profileId?: string | null };
  const slugs = Array.isArray(body.slugs) ? body.slugs.filter((slug): slug is string => typeof slug === 'string' && slug.trim().length > 0) : [];
  const data = await previewSkillBundle({ slugs, installationId: body.installationId, profileId: body.profileId ?? null });
  return c.json({ success: true, data });
});

orchestraRouter.post('/skill-bundles/apply', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const body = await c.req.json().catch(() => ({})) as { slugs?: string[]; installationId?: string; profileId?: string | null };
  const slugs = Array.isArray(body.slugs) ? body.slugs.filter((slug): slug is string => typeof slug === 'string' && slug.trim().length > 0) : [];
  if (!body.installationId || slugs.length === 0) throw new HttpError(400, 'VALIDATION_ERROR', 'installationId and slugs are required');
  const data = await applySkillBundle({ slugs, installationId: body.installationId, profileId: body.profileId ?? null, actorId: user.userId });
  await logAuditEvent({ action: 'orchestra.skill_bundle.apply', actorId: user.userId, targetType: 'hermes-installation', targetId: body.installationId, details: { slugs, profileId: body.profileId ?? null, count: data.count } });
  return c.json({ success: true, data }, 201);
});

orchestraRouter.post('/jobs/:id/cancel', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  const data = await cancelHermesJob(id, user.userId);
  await logAuditEvent({ action: 'orchestra.job.cancel', actorId: user.userId, targetType: 'hermes-operation-job', targetId: id, details: { status: data.status } });
  return c.json({ success: true, data });
});

orchestraRouter.post('/providers/test', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const body = await c.req.json().catch(() => ({})) as { installationId?: string; profileId?: string | null; provider?: string };
  if (!body.installationId || !body.provider) throw new HttpError(400, 'VALIDATION_ERROR', 'installationId and provider are required');
  await logAuditEvent({ action: 'orchestra.provider_config.test', actorId: user.userId, targetType: 'hermes-provider-config', targetId: body.installationId, details: { provider: body.provider, profileId: body.profileId ?? null } });
  return c.json({
    success: true,
    data: {
      status: 'pending',
      message: 'Provider test request accepted. Live agent ping arrives in a follow-up release; the audit trail records this attempt.',
    },
  }, 202);
});

function requiredParam(name: string, value: string | undefined): string {
  if (!value) throw new HttpError(400, 'VALIDATION_ERROR', `${name} is required`);
  return value;
}

// ── Skill assignments ──────────────────────────────────────────────────────
orchestraRouter.get('/skill-assignments', async (c) => {
  const installationId = c.req.query('installationId');
  const profileId = c.req.query('profileId');
  const data = await svc.listSkillAssignments({ installationId, profileId });
  return c.json({ success: true, data });
});

orchestraRouter.post('/skill-assignments', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const body = await parseBody(c, skillAssignmentCreateSchema);
  const created = await svc.createSkillAssignment({ ...body, actorId: user.userId });
  await logAuditEvent({ action: 'orchestra.skill_assignment.create', actorId: user.userId, targetType: 'hermes-skill-assignment', targetId: created.id, details: { installationId: body.installationId, skillSlug: body.skillSlug } });
  return c.json({ success: true, data: created }, 201);
});

orchestraRouter.patch('/skill-assignments/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  const body = await parseBody(c, skillAssignmentUpdateSchema);
  const updated = await svc.updateSkillAssignment(id, body);
  await logAuditEvent({ action: 'orchestra.skill_assignment.update', actorId: user.userId, targetType: 'hermes-skill-assignment', targetId: id, details: body });
  return c.json({ success: true, data: updated });
});

orchestraRouter.delete('/skill-assignments/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  await svc.deleteSkillAssignment(id);
  await logAuditEvent({ action: 'orchestra.skill_assignment.delete', actorId: user.userId, targetType: 'hermes-skill-assignment', targetId: id, details: {} });
  return c.json({ success: true });
});

// ── Toolset policies ────────────────────────────────────────────────────────
orchestraRouter.get('/toolset-policies', async (c) => {
  const data = await svc.listToolsetPolicies({ installationId: c.req.query('installationId'), profileId: c.req.query('profileId') });
  return c.json({ success: true, data });
});

orchestraRouter.put('/toolset-policies', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const body = await parseBody(c, toolsetPolicyCreateSchema);
  const row = await svc.upsertToolsetPolicy({ ...body, actorId: user.userId });
  await logAuditEvent({ action: 'orchestra.toolset_policy.upsert', actorId: user.userId, targetType: 'hermes-toolset-policy', targetId: row.id, details: { installationId: body.installationId, toolset: body.toolset } });
  return c.json({ success: true, data: row });
});

orchestraRouter.patch('/toolset-policies/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  const body = await parseBody(c, toolsetPolicyUpdateSchema);
  const row = await svc.updateToolsetPolicyById(id, body);
  await logAuditEvent({ action: 'orchestra.toolset_policy.update', actorId: user.userId, targetType: 'hermes-toolset-policy', targetId: id, details: {} });
  return c.json({ success: true, data: row });
});

orchestraRouter.delete('/toolset-policies/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  await svc.deleteToolsetPolicy(id);
  await logAuditEvent({ action: 'orchestra.toolset_policy.delete', actorId: user.userId, targetType: 'hermes-toolset-policy', targetId: id, details: {} });
  return c.json({ success: true });
});

// ── Roles ───────────────────────────────────────────────────────────────────
orchestraRouter.get('/roles', async (c) => {
  const data = await svc.listHermesRoles();
  return c.json({ success: true, data });
});

orchestraRouter.get('/roles/:id', async (c) => {
  const data = await svc.getHermesRole(requiredParam('id', c.req.param('id')));
  if (!data) throw new HttpError(404, 'NOT_FOUND', 'Hermes role not found');
  return c.json({ success: true, data });
});

orchestraRouter.get('/roles/:id/child-preview', async c => {
  const db = (await import('../db/index.js')).getDb();
  const role = await db.hermesRole.findUnique({ where: { id: requiredParam('id', c.req.param('id')) } });
  const installationId = c.req.query('installationId');
  const profileId = c.req.query('profileId') ?? '';
  if (!role || !installationId) throw new HttpError(400, 'INVALID_PREVIEW', 'Role and installationId are required');
  const installation = await db.hermesInstallation.findUnique({ where: { id: installationId } });
  if (!installation) throw new HttpError(404, 'NOT_FOUND', 'Installation not found');
  const profile = profileId ? await db.hermesProfile.findFirst({ where: { id: profileId, installationId } }) : null;
  if (profileId && !profile) throw new HttpError(400, 'INVALID_PROFILE', 'Profile is not on the selected installation');
  const skills = JSON.parse(role.skillsJson) as string[];
  const toolsets = JSON.parse(role.toolsetsJson) as string[];
  const targets = await db.hermesRegistryTarget.findMany({ where: { installationId, profileId, kind: 'skill', slug: { in: skills } } });
  const bySlug = new Map(targets.map(target => [target.slug, target]));
  let observed: { skills?: Array<{ slug?: string; enabled?: boolean }>; toolSurface?: Array<{ platform: string; enabled: string[] }>;
    toolSurfaceObservedAt?: string } = {};
  try { observed = JSON.parse(installation.rawStatus) as typeof observed; } catch { /* unavailable */ }
  let profileCapabilities: typeof observed = {};
  try { profileCapabilities = JSON.parse(profile?.capabilities ?? '{}') as typeof observed; } catch { /* unavailable */ }
  const platform = (c.req.query('platform') ?? 'cli').toLowerCase();
  const actualInheritedTools = (profileCapabilities.toolSurface ?? observed.toolSurface ?? [])
    .find(surface => surface.platform === platform)?.enabled ?? [];
  const nativeNames: Record<string, string> = { terminal: 'Terminal & Processes', file_edit: 'File Operations',
    web_search: 'Web Search & Scraping', delegation: 'Task Delegation', browser: 'Browser Automation',
    image_gen: 'Image Generation', skills: 'Skills', cron: 'Cron Jobs' };
  const inheritedToolsets = toolsets.filter(toolset => actualInheritedTools.some(name => name.endsWith(nativeNames[toolset] ?? '\u0000')));
  const installedSkills = skills.map(slug => {
    const target = bySlug.get(slug);
    const loaded = (profileCapabilities.skills ?? observed.skills ?? []).some(skill => skill.slug === slug && skill.enabled);
    return { slug, revision: target?.observedRevision ?? null, assigned: !!target, loaded, ready: !!target && target.status === 'applied' && loaded };
  });
  const missingToolsets = toolsets.filter(toolset => !inheritedToolsets.includes(toolset));
  return c.json({ success: true, data: { roleId: role.id, installationId, profileId, ready: installedSkills.every(skill => skill.ready) && missingToolsets.length === 0,
    skills: installedSkills, requiredToolsets: toolsets, missingToolsets, inheritedToolsets, platform, actualInheritedTools,
    toolSurfaceObservedAt: profileCapabilities.toolSurfaceObservedAt ?? observed.toolSurfaceObservedAt ?? null,
    toolAccessBoundary: 'Native delegate_task inherits the parent tool surface; role instructions do not narrow permissions.',
    briefing: `${role.name}: ${role.description}\nUse these skills: ${skills.join(', ') || '(none)'}. Required toolsets: ${toolsets.join(', ') || '(none)'}.` } });
});

orchestraRouter.post('/roles', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const body = await parseBody(c, hermesRoleCreateSchema);
  const row = await svc.createHermesRole({ ...body, actorId: user.userId });
  await logAuditEvent({ action: 'orchestra.role.create', actorId: user.userId, targetType: 'hermes-role', targetId: row.id, details: { name: body.name } });
  return c.json({ success: true, data: row }, 201);
});

orchestraRouter.patch('/roles/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  const body = await parseBody(c, hermesRoleUpdateSchema);
  const row = await svc.updateHermesRole(id, body);
  await logAuditEvent({ action: 'orchestra.role.update', actorId: user.userId, targetType: 'hermes-role', targetId: id, details: {} });
  return c.json({ success: true, data: row });
});

orchestraRouter.delete('/roles/:id', requireRole('ADMIN'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  await svc.deleteHermesRole(id);
  await logAuditEvent({ action: 'orchestra.role.delete', actorId: user.userId, targetType: 'hermes-role', targetId: id, details: {} });
  return c.json({ success: true });
});

orchestraRouter.post('/roles/:id/apply', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  const body = await parseBody(c, hermesRoleApplySchema);
  const row = await svc.applyHermesRole(id, { ...body, actorId: user.userId });
  await logAuditEvent({ action: 'orchestra.role.apply', actorId: user.userId, targetType: 'hermes-role', targetId: id, details: { installationId: body.installationId, profileId: body.profileId } });
  return c.json({ success: true, data: row }, 202);
});

// ── Provider configs ────────────────────────────────────────────────────────
orchestraRouter.get('/providers', async (c) => {
  const installationId = c.req.query('installationId');
  const profileId = c.req.query('profileId') ?? null;
  if (!installationId) throw new HttpError(400, 'VALIDATION_ERROR', 'installationId is required');
  const data = await svc.getProviderConfig(installationId, profileId);
  return c.json({ success: true, data });
});

orchestraRouter.put('/providers', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const body = await parseBody(c, providerConfigSchema);
  const row = await svc.upsertProviderConfig({ ...body, actorId: user.userId });
  await logAuditEvent({ action: 'orchestra.provider_config.upsert', actorId: user.userId, targetType: 'hermes-provider-config', targetId: row.id, details: { installationId: body.installationId, profileId: body.profileId } });
  return c.json({ success: true, data: row });
});

// ── Credential pools ────────────────────────────────────────────────────────
orchestraRouter.get('/credential-pools', async (c) => {
  const data = await svc.listCredentialPools();
  return c.json({ success: true, data });
});

orchestraRouter.post('/credential-pools', requireRole('ADMIN'), async (c) => {
  const user = getUser(c);
  const body = await parseBody(c, credentialPoolCreateSchema);
  const row = await svc.createCredentialPool({ ...body, actorId: user.userId });
  await logAuditEvent({ action: 'orchestra.credential_pool.create', actorId: user.userId, targetType: 'hermes-credential-pool', targetId: row.id, details: { name: body.name, provider: body.provider } });
  return c.json({ success: true, data: row }, 201);
});

orchestraRouter.patch('/credential-pools/:id', requireRole('ADMIN'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  const body = await parseBody(c, credentialPoolUpdateSchema);
  const row = await svc.updateCredentialPool(id, body);
  await logAuditEvent({ action: 'orchestra.credential_pool.update', actorId: user.userId, targetType: 'hermes-credential-pool', targetId: id, details: {} });
  return c.json({ success: true, data: row });
});

orchestraRouter.delete('/credential-pools/:id', requireRole('ADMIN'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  await svc.deleteCredentialPool(id);
  await logAuditEvent({ action: 'orchestra.credential_pool.delete', actorId: user.userId, targetType: 'hermes-credential-pool', targetId: id, details: {} });
  return c.json({ success: true });
});

orchestraRouter.post('/credential-pools/:id/attach', requireRole('ADMIN'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  const body = await parseBody(c, credentialPoolAttachSchema);
  const row = await svc.attachCredentialPool(id, { ...body, actorId: user.userId });
  await logAuditEvent({ action: 'orchestra.credential_pool.attach', actorId: user.userId, targetType: 'hermes-credential-pool', targetId: id, details: { installationId: body.installationId } });
  return c.json({ success: true, data: row }, 202);
});

orchestraRouter.delete('/credential-pools/attachments/:attachmentId', requireRole('ADMIN'), async (c) => {
  const user = getUser(c);
  const attachmentId = requiredParam('attachmentId', c.req.param('attachmentId'));
  await svc.detachCredentialPool(attachmentId);
  await logAuditEvent({ action: 'orchestra.credential_pool.detach', actorId: user.userId, targetType: 'hermes-credential-pool-attachment', targetId: attachmentId, details: {} });
  return c.json({ success: true });
});

// ── MCP servers ─────────────────────────────────────────────────────────────
orchestraRouter.get('/mcp-servers', async (c) => {
  const data = await svc.listMcpServers();
  return c.json({ success: true, data });
});

orchestraRouter.post('/mcp-servers', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const body = await parseBody(c, mcpServerCreateSchema);
  const row = await svc.createMcpServer({ ...body, actorId: user.userId });
  await logAuditEvent({ action: 'orchestra.mcp_server.create', actorId: user.userId, targetType: 'hermes-mcp-server', targetId: row.id, details: { name: body.name, transport: body.transport } });
  return c.json({ success: true, data: row }, 201);
});

orchestraRouter.patch('/mcp-servers/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  const body = await parseBody(c, mcpServerUpdateSchema);
  const row = await svc.updateMcpServer(id, body);
  await logAuditEvent({ action: 'orchestra.mcp_server.update', actorId: user.userId, targetType: 'hermes-mcp-server', targetId: id, details: {} });
  return c.json({ success: true, data: row });
});

orchestraRouter.delete('/mcp-servers/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  await svc.deleteMcpServer(id);
  await logAuditEvent({ action: 'orchestra.mcp_server.delete', actorId: user.userId, targetType: 'hermes-mcp-server', targetId: id, details: {} });
  return c.json({ success: true });
});

orchestraRouter.post('/mcp-servers/:id/attach', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  const body = await parseBody(c, mcpServerAttachSchema);
  const row = await svc.attachMcpServer(id, { ...body, actorId: user.userId });
  await logAuditEvent({ action: 'orchestra.mcp_server.attach', actorId: user.userId, targetType: 'hermes-mcp-server', targetId: id, details: { installationId: body.installationId } });
  return c.json({ success: true, data: row }, 202);
});

orchestraRouter.delete('/mcp-servers/attachments/:attachmentId', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const attachmentId = requiredParam('attachmentId', c.req.param('attachmentId'));
  await svc.detachMcpServer(attachmentId);
  await logAuditEvent({ action: 'orchestra.mcp_server.detach', actorId: user.userId, targetType: 'hermes-mcp-server-attachment', targetId: attachmentId, details: {} });
  return c.json({ success: true });
});

// ── Messaging bindings ──────────────────────────────────────────────────────
orchestraRouter.get('/messaging-bindings', async (c) => {
  const data = await svc.listMessagingBindings({ installationId: c.req.query('installationId'), profileId: c.req.query('profileId') });
  return c.json({ success: true, data });
});

orchestraRouter.post('/messaging-bindings', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const body = await parseBody(c, messagingBindingCreateSchema);
  const row = await svc.createMessagingBinding({ ...body, actorId: user.userId });
  await logAuditEvent({ action: 'orchestra.messaging_binding.create', actorId: user.userId, targetType: 'hermes-messaging-binding', targetId: row.id, details: { installationId: body.installationId, platform: body.platform } });
  return c.json({ success: true, data: row }, 201);
});

orchestraRouter.patch('/messaging-bindings/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  const body = await parseBody(c, messagingBindingUpdateSchema);
  const row = await svc.updateMessagingBinding(id, body);
  await logAuditEvent({ action: 'orchestra.messaging_binding.update', actorId: user.userId, targetType: 'hermes-messaging-binding', targetId: id, details: {} });
  return c.json({ success: true, data: row });
});

orchestraRouter.delete('/messaging-bindings/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  await svc.deleteMessagingBinding(id);
  await logAuditEvent({ action: 'orchestra.messaging_binding.delete', actorId: user.userId, targetType: 'hermes-messaging-binding', targetId: id, details: {} });
  return c.json({ success: true });
});

// ── Hermes cron jobs ────────────────────────────────────────────────────────
orchestraRouter.get('/cron-jobs', async (c) => {
  const data = await svc.listHermesCronJobs({ installationId: c.req.query('installationId'), profileId: c.req.query('profileId') });
  return c.json({ success: true, data });
});

orchestraRouter.post('/cron-jobs', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const body = await parseBody(c, hermesCronJobCreateSchema);
  const row = await svc.createHermesCronJob({ ...body, actorId: user.userId });
  await logAuditEvent({ action: 'orchestra.cron_job.create', actorId: user.userId, targetType: 'hermes-cron-job', targetId: row.id, details: { installationId: body.installationId, name: body.name } });
  return c.json({ success: true, data: row }, 201);
});

orchestraRouter.patch('/cron-jobs/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  const body = await parseBody(c, hermesCronJobUpdateSchema);
  const row = await svc.updateHermesCronJob(id, body);
  await logAuditEvent({ action: 'orchestra.cron_job.update', actorId: user.userId, targetType: 'hermes-cron-job', targetId: id, details: {} });
  return c.json({ success: true, data: row });
});

orchestraRouter.delete('/cron-jobs/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  await svc.deleteHermesCronJob(id);
  await logAuditEvent({ action: 'orchestra.cron_job.delete', actorId: user.userId, targetType: 'hermes-cron-job', targetId: id, details: {} });
  return c.json({ success: true });
});

// ── Plugins ─────────────────────────────────────────────────────────────────
orchestraRouter.get('/plugins', async (c) => {
  const data = await svc.listHermesPlugins({ installationId: c.req.query('installationId'), profileId: c.req.query('profileId') });
  return c.json({ success: true, data });
});

orchestraRouter.post('/plugins', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const body = await parseBody(c, hermesPluginCreateSchema);
  const row = await svc.installHermesPlugin({ ...body, actorId: user.userId });
  await logAuditEvent({ action: 'orchestra.plugin.install', actorId: user.userId, targetType: 'hermes-plugin-install', targetId: row.id, details: { installationId: body.installationId, pluginSlug: body.pluginSlug } });
  return c.json({ success: true, data: row }, 201);
});

orchestraRouter.delete('/plugins/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  await svc.removeHermesPlugin(id);
  await logAuditEvent({ action: 'orchestra.plugin.remove', actorId: user.userId, targetType: 'hermes-plugin-install', targetId: id, details: {} });
  return c.json({ success: true });
});

// ── Hooks ───────────────────────────────────────────────────────────────────
orchestraRouter.get('/hooks', async (c) => {
  const data = await svc.listHermesHooks({ installationId: c.req.query('installationId'), profileId: c.req.query('profileId') });
  return c.json({ success: true, data });
});

orchestraRouter.post('/hooks', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const body = await parseBody(c, hermesHookCreateSchema);
  const row = await svc.createHermesHook({ ...body, actorId: user.userId });
  await logAuditEvent({ action: 'orchestra.hook.create', actorId: user.userId, targetType: 'hermes-hook', targetId: row.id, details: { installationId: body.installationId, event: body.event } });
  return c.json({ success: true, data: row }, 201);
});

orchestraRouter.patch('/hooks/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  const body = await parseBody(c, hermesHookUpdateSchema);
  const row = await svc.updateHermesHook(id, body);
  await logAuditEvent({ action: 'orchestra.hook.update', actorId: user.userId, targetType: 'hermes-hook', targetId: id, details: {} });
  return c.json({ success: true, data: row });
});

orchestraRouter.delete('/hooks/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const id = requiredParam('id', c.req.param('id'));
  await svc.deleteHermesHook(id);
  await logAuditEvent({ action: 'orchestra.hook.delete', actorId: user.userId, targetType: 'hermes-hook', targetId: id, details: {} });
  return c.json({ success: true });
});
