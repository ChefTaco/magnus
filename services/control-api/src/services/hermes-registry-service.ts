import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';

/**
 * Hosts allowed to pull registry deployments, from `MAGNUS_REGISTRY_DEPLOY_HOSTS`:
 * a comma-separated list of short hostnames with an optional rollout stage,
 * for example `canary:0,web-1:1,web-2:2`. A host without a stage is stage 0.
 * Stage-0 hosts are canaries; a plugin release reaches stage N only after every
 * lower stage has applied it. Unset (the default) disables registry pulls.
 */
export function registryRolloutStages(raw = process.env['MAGNUS_REGISTRY_DEPLOY_HOSTS'] ?? ''): Map<string, number> {
  const stages = new Map<string, number>();
  for (const entry of raw.split(',').map(value => value.trim().toLowerCase()).filter(Boolean)) {
    const [host, stage] = entry.split(':');
    if (!host || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(host)) continue;
    const parsed = stage === undefined ? 0 : Number(stage);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 99) stages.set(host, parsed);
  }
  return stages;
}
/**
 * Hosts that may submit registry changes but never receive deployments, from
 * `MAGNUS_REGISTRY_SUBMIT_ONLY_HOSTS` (comma-separated short hostnames).
 */
export function isSubmitOnlyHost(host: string): boolean {
  const configured = (process.env['MAGNUS_REGISTRY_SUBMIT_ONLY_HOSTS'] ?? '').split(',')
    .map(value => value.trim().toLowerCase()).filter(Boolean);
  return Boolean(host) && configured.includes(host.toLowerCase());
}
/** Optional DNS suffix under which managed nodes are reachable (`MAGNUS_NODE_DNS_SUFFIX`). */
function nodeDnsSuffix(): string {
  return (process.env['MAGNUS_NODE_DNS_SUFFIX'] ?? '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
}
/** Whether a short hostname is configured to receive registry deployments. */
export function isDeployHost(host: string): boolean {
  return registryRolloutStages().has(host.toLowerCase());
}
export const registryKind = z.enum(['skill', 'plugin', 'mcp']);
export const identity = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/).refine(s => !s.includes('..'));
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const file = z.object({ path: z.string().min(1).max(240), contentBase64: z.string().max(3_000_000), sha256: z.string().regex(/^[a-f0-9]{64}$/), mode: z.union([z.literal(420), z.literal(493)]) }).strict();
const safeSourceUrl = z.string().url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; });
export const skillArtifact = z.object({ format: z.literal('magnus-hermes-skill-v1'), installPath: z.string().min(1).max(240), files: z.array(file).min(1).max(256) }).strict();
export const pluginArtifact = z.object({ format: z.literal('magnus-hermes-plugin-v1'), sourceUrl: safeSourceUrl, commit: z.string().regex(/^[a-f0-9]{40}$/), capabilities: z.array(identity), dependencies: z.array(identity), declaredTools: z.array(identity).default([]), declaredHooks: z.array(identity).default([]), desktopComponent: z.boolean().default(false), pluginType: z.enum(['general', 'memory-provider', 'context-engine', 'transport', 'provider']), files: z.array(file).min(1).max(256) }).strict();
export const mcpArtifact = z.object({ format: z.literal('magnus-hermes-mcp-v1'), sourceUrl: safeSourceUrl, commit: z.string().regex(/^[a-f0-9]{40}$/), ownerHost: identity,
  adapter: z.literal('systemd-user-tree-v1'), serviceUnit: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*\.service$/),
  healthProbe: z.string().url(), rollbackAdapter: z.literal('symlink-restore-v1'), files: z.array(file).min(1).max(256) }).strict();
export type RegistryKind = z.infer<typeof registryKind>;

export function validateArtifact(kind: RegistryKind, value: unknown): string {
  const artifact = kind === 'skill' ? skillArtifact.parse(value) : kind === 'plugin' ? pluginArtifact.parse(value) : mcpArtifact.parse(value);
  const paths = new Set<string>();
  let size = 0;
  for (const entry of artifact.files) {
    const parts = entry.path.split('/');
    if (entry.path.startsWith('/') || entry.path.includes('\\') || parts.some(s => !s || s === '.' || s === '..') || paths.has(entry.path))
      throw new HttpError(400, 'INVALID_ARTIFACT', 'Artifact has an unsafe or duplicate path');
    paths.add(entry.path);
    const bytes = Buffer.from(entry.contentBase64, 'base64');
    if (bytes.toString('base64') !== entry.contentBase64 || digest(bytes) !== entry.sha256)
      throw new HttpError(400, 'INVALID_ARTIFACT', 'Artifact file hash does not match its bytes');
    size += bytes.length;
  }
  if (size > 3 * 1024 * 1024) throw new HttpError(400, 'INVALID_ARTIFACT', 'Artifact is too large');
  if (kind === 'skill' && !paths.has('SKILL.md')) throw new HttpError(400, 'INVALID_ARTIFACT', 'Hermes skill requires SKILL.md');
  if (kind === 'skill' && (artifact as z.infer<typeof skillArtifact>).installPath.split('/').some(part => !identity.safeParse(part).success))
    throw new HttpError(400, 'INVALID_ARTIFACT', 'Skill install path has an unsafe segment');
  if (kind === 'plugin' && !paths.has('plugin.yaml')) throw new HttpError(400, 'INVALID_ARTIFACT', 'Hermes plugin requires plugin.yaml');
  if (kind === 'mcp' && !isDeployHost((artifact as z.infer<typeof mcpArtifact>).ownerHost.toLowerCase()))
    throw new HttpError(400, 'INVALID_ARTIFACT', 'MCP backend owner must be a named target');
  if (kind === 'mcp') {
    const backend = artifact as z.infer<typeof mcpArtifact>;
    const probe = new URL(backend.healthProbe);
    const allowed = probe.hostname === '127.0.0.1' || probe.hostname === 'localhost'
      || (Boolean(nodeDnsSuffix()) && probe.hostname === `${backend.ownerHost.toLowerCase()}.${nodeDnsSuffix()}`);
    if (!allowed || (probe.protocol !== 'https:' && !(probe.protocol === 'http:' && probe.hostname === '127.0.0.1'))
      || probe.username || probe.password) throw new HttpError(400, 'INVALID_ARTIFACT', 'MCP health probe must be local to the owning host');
  }
  if (kind === 'skill') {
    const content = Buffer.from(artifact.files.find(f => f.path === 'SKILL.md')!.contentBase64, 'base64').toString('utf8');
    if (!content.startsWith('---\n') || !/\nname:\s*[^\n]+/.test(content) || !/\ndescription:\s*[^\n]+/.test(content))
      throw new HttpError(400, 'INVALID_ARTIFACT', 'SKILL.md must have name and description frontmatter');
  }
  return JSON.stringify(artifact);
}

export function scanArtifact(kind: RegistryKind, serialized: string): string | null {
  // Admission scans fail closed on obvious credential exfiltration and embedded
  // private material. A passing scan is never an execution sandbox.
  const artifact = JSON.parse(serialized) as { files: Array<{ contentBase64: string }> };
  for (const entry of artifact.files) {
    const content = Buffer.from(entry.contentBase64, 'base64').toString('utf8');
    if (/-----BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY-----|(?:AKIA|ASIA)[A-Z0-9]{16}|curl[^\n|]*\|\s*(?:sh|bash)|wget[^\n|]*\|\s*(?:sh|bash)/i.test(content))
      return 'suspicious-content';
  }
  if (kind === 'plugin' && /"commit":"0{40}"/.test(serialized)) return 'invalid-source';
  return null;
}

export async function authenticateRegistryToken(raw: string | undefined, scope: 'pull' | 'submit') {
  if (!raw || !/^[a-f0-9]{64}$/.test(raw)) throw new HttpError(401, 'UNAUTHORIZED', 'Registry credential required');
  const hash = digest(raw);
  const client = await getDb().hermesRegistryClient.findUnique({ where: { tokenSha256: hash } });
  // Uniform comparison also protects accidental plaintext-token regressions.
  if (!client || !timingSafeEqual(Buffer.from(client.tokenSha256), Buffer.from(hash)) || !client.enabled || client.revokedAt)
    throw new HttpError(401, 'UNAUTHORIZED', 'Registry credential rejected');
  const [node, installation] = await Promise.all([
    getDb().node.findUnique({ where: { id: client.nodeId } }),
    getDb().hermesInstallation.findUnique({ where: { id: client.installationId } }),
  ]);
  if (!node || !installation || installation.nodeId !== node.id || node.hostname.toLowerCase() !== installation.hostname.toLowerCase())
    throw new HttpError(403, 'REGISTRY_IDENTITY_MISMATCH', 'Registry credential is not bound to this installation');
  const host = node.hostname.split('.')[0]!.toLowerCase();
  if (scope === 'pull' && (!client.canPull || !isDeployHost(host))) throw new HttpError(403, 'REGISTRY_PULL_DISABLED', 'This host may not receive registry deployments');
  if (scope === 'submit' && !client.canSubmit) throw new HttpError(403, 'REGISTRY_SUBMIT_DISABLED', 'This host may not submit changes');
  return { client, node, installation, host };
}

export async function enrollClient(nodeId: string, installationId: string, canSubmit = true) {
  const db = getDb();
  const [node, installation] = await Promise.all([db.node.findUnique({ where: { id: nodeId } }), db.hermesInstallation.findUnique({ where: { id: installationId } })]);
  if (!node || !installation || installation.nodeId !== nodeId) throw new HttpError(400, 'INVALID_TARGET', 'Installation must belong to enrolled node');
  const host = node.hostname.split('.')[0]!.toLowerCase();
  const canPull = isDeployHost(host);
  if (!canPull && !isSubmitOnlyHost(host)) throw new HttpError(403, 'REGISTRY_DISABLED', 'New hosts default to registry disabled');
  const token = randomBytes(32).toString('hex');
  await db.hermesRegistryClient.upsert({ where: { nodeId_installationId: { nodeId, installationId } },
    create: { nodeId, installationId, tokenSha256: digest(token), canPull, canSubmit },
    update: { tokenSha256: digest(token), canPull, canSubmit, enabled: true, revokedAt: null },
  });
  return { token, host, canPull, canSubmit };
}

export async function publishRevision(input: { kind: RegistryKind; slug: string; artifact: unknown; metadata?: Record<string, unknown>; sourceHost?: string; publishedBy: string; baseRevision?: number }) {
  const db = getDb();
  const serialized = validateArtifact(input.kind, input.artifact);
  const hash = digest(serialized);
  const scan = scanArtifact(input.kind, serialized);
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`hermes-registry:${input.kind}:${input.slug}`}, 0))`;
    const latest = await tx.hermesRegistryRevision.findFirst({ where: { kind: input.kind, slug: input.slug }, orderBy: { revision: 'desc' } });
    if (latest?.sha256 === hash) return { revision: latest, duplicate: true };
    const installPathChanged = input.kind === 'skill' && latest
      && skillArtifact.parse(JSON.parse(latest.artifactJson)).installPath !== skillArtifact.parse(input.artifact).installPath;
    const conflicts = installPathChanged || input.baseRevision !== undefined && input.baseRevision !== (latest?.revision ?? 0);
    let status = scan ? 'quarantined' : conflicts ? 'conflict' : 'published';
    const active = input.kind === 'plugin' ? await tx.hermesRegistryRevision.findFirst({ where: { kind: input.kind, slug: input.slug, status: 'published' }, orderBy: { revision: 'desc' } }) : null;
    if (input.kind === 'plugin' && status === 'published') {
      const next = pluginArtifact.parse(input.artifact);
      if (!active && (next.capabilities.length || next.dependencies.length || next.declaredTools.length || next.declaredHooks.length || next.desktopComponent))
        status = 'needs-consent';
      else if (active) {
        const old = pluginArtifact.parse(JSON.parse(active.artifactJson));
        if (JSON.stringify([...old.capabilities].sort()) !== JSON.stringify([...next.capabilities].sort())
        || JSON.stringify([...old.dependencies].sort()) !== JSON.stringify([...next.dependencies].sort())
        || JSON.stringify([...old.declaredTools].sort()) !== JSON.stringify([...next.declaredTools].sort())
        || JSON.stringify([...old.declaredHooks].sort()) !== JSON.stringify([...next.declaredHooks].sort())
        || old.desktopComponent !== next.desktopComponent) status = 'needs-consent';
      }
    }
    if (input.kind === 'mcp' && latest && status === 'published') {
      const old = mcpArtifact.parse(JSON.parse(latest.artifactJson));
      const next = mcpArtifact.parse(input.artifact);
      if (old.sourceUrl !== next.sourceUrl || old.ownerHost !== next.ownerHost || old.adapter !== next.adapter
        || old.serviceUnit !== next.serviceUnit || old.healthProbe !== next.healthProbe || old.rollbackAdapter !== next.rollbackAdapter)
        status = 'needs-consent';
    }
    const revision = await tx.hermesRegistryRevision.create({ data: { kind: input.kind, slug: input.slug, revision: (latest?.revision ?? 0) + 1,
      sha256: hash, artifactJson: serialized, metadataJson: JSON.stringify({ ...input.metadata,
        consentRequiresPreinstalledTarget: active ? (JSON.parse(active.metadataJson) as Record<string, unknown>)['consentRequiresPreinstalledTarget'] === true : false,
        admissionReason: scan ?? (conflicts ? 'base-revision-conflict' : undefined) }),
      sourceHost: input.sourceHost, publishedBy: input.publishedBy, status } });
    return { revision, duplicate: false };
  });
}

export async function desiredManifest(installationId: string) {
  const db = getDb();
  const installation = await db.hermesInstallation.findUnique({ where: { id: installationId }, include: { profiles: true } });
  if (!installation) throw new HttpError(404, 'NOT_FOUND', 'Hermes installation not found');
  const profiles = new Map(installation.profiles.map(profile => [profile.id, profile]));
  const targets = await db.hermesRegistryTarget.findMany({ where: { installationId, enabled: true }, orderBy: [{ kind: 'asc' }, { slug: 'asc' }] });
  const components = [];
  for (const target of targets) {
    let revision = await db.hermesRegistryRevision.findFirst({ where: { kind: target.kind, slug: target.slug,
      ...(target.pinnedRevision === null ? { status: 'published' } : { revision: target.pinnedRevision, status: 'published' }) }, orderBy: { revision: 'desc' } });
    if (target.kind === 'plugin' && target.pinnedRevision === null && revision && revision.revision !== target.observedRevision) {
      const host = installation.hostname.split('.')[0]!.toLowerCase();
      const rollout = registryRolloutStages();
      const stage = rollout.get(host);
      if (stage === undefined) continue;
      if (stage > 0) {
        const prior = await db.hermesRegistryTarget.findMany({ where: { kind: 'plugin', slug: target.slug, enabled: true, pinnedRevision: null } });
        const priorInstallations = await db.hermesInstallation.findMany({ where: { id: { in: prior.map(row => row.installationId) } }, select: { id: true, hostname: true } });
        const hosts = new Map(priorInstallations.map(row => [row.id, row.hostname.split('.')[0]!.toLowerCase()]));
        const canaryPresent = prior.some(row => rollout.get(hosts.get(row.installationId) ?? '') === 0);
        const waiting = !canaryPresent || prior.some(row => (rollout.get(hosts.get(row.installationId) ?? '') ?? 99) < stage
          && (row.observedRevision !== revision!.revision || row.status !== 'applied'));
        if (waiting) revision = target.observedRevision === null ? null : await db.hermesRegistryRevision.findFirst({ where: {
          kind: 'plugin', slug: target.slug, revision: target.observedRevision, status: 'published' } });
      }
    }
    if (revision) components.push({ kind: target.kind, slug: target.slug, profileId: target.profileId,
      profileHome: target.profileId ? profiles.get(target.profileId)?.profileHome ?? '' : installation.hermesHome,
      ...(target.kind === 'skill' ? { installPath: skillArtifact.parse(JSON.parse(revision.artifactJson)).installPath } : {}),
      hermesBin: installation.hermesBin,
      revision: revision.revision, sha256: revision.sha256,
      status: target.status, observedRevision: target.observedRevision });
  }
  return components;
}

export async function assignSkillTargets(slug: string, tags: string[], authorProfileId = '', sourceHost = ''): Promise<number> {
  const db = getDb();
  const profiles = await db.hermesProfile.findMany({ include: { installation: { select: { hostname: true } } } });
  const matches = profiles.filter(profile => {
    if (!isDeployHost(profile.installation.hostname.split('.')[0]!.toLowerCase())) return false;
    try { const meta = JSON.parse(profile.metadata) as { groups?: string[] }; return tags.some(tag => meta.groups?.includes(tag)); }
    catch { return false; }
  });
  const targets = matches.length ? matches : profiles.filter(profile => profile.id === authorProfileId && !isSubmitOnlyHost(sourceHost));
  for (const profile of targets) await db.hermesRegistryTarget.upsert({
    where: { kind_slug_installationId_profileId: { kind: 'skill', slug, installationId: profile.installationId, profileId: profile.id } },
    create: { kind: 'skill', slug, installationId: profile.installationId, profileId: profile.id }, update: {},
  });
  if (!matches.length && !targets.length && !authorProfileId && isDeployHost(sourceHost)) {
    const installation = await db.hermesInstallation.findFirst({ where: { OR: [{ hostname: sourceHost }, { hostname: { startsWith: `${sourceHost}.` } }] },
      orderBy: { updatedAt: 'desc' } });
    if (installation && installation.hostname.split('.')[0]?.toLowerCase() === sourceHost) {
      await db.hermesRegistryTarget.upsert({
        where: { kind_slug_installationId_profileId: { kind: 'skill', slug, installationId: installation.id, profileId: '' } },
        create: { kind: 'skill', slug, installationId: installation.id, profileId: '' }, update: {},
      });
      return 1;
    }
  }
  return targets.length;
}
