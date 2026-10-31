import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { registryRolloutStages } from './hermes-registry-service.js';

const exec = promisify(execFile);
const REPOSITORY = 'https://github.com/NousResearch/hermes-agent.git';
let cache: { expiresAt: number; tag: string; commit: string; bootstrapScriptSha256: string } | null = null;

export async function stableRelease(): Promise<{ tag: string; commit: string; bootstrapScriptSha256: string }> {
  if (cache && cache.expiresAt > Date.now()) return { tag: cache.tag, commit: cache.commit, bootstrapScriptSha256: cache.bootstrapScriptSha256 };
  const response = await fetch('https://api.github.com/repos/NousResearch/hermes-agent/releases/latest', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'magnus-hermes-registry' }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new HttpError(503, 'UPSTREAM_UNAVAILABLE', 'Stable Hermes release feed is unavailable');
  const data = await response.json() as { tag_name?: string; draft?: boolean; prerelease?: boolean };
  if (data.draft || data.prerelease || !/^v20\d{2}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/.test(data.tag_name ?? ''))
    throw new HttpError(503, 'UPSTREAM_INVALID', 'Stable Hermes release record is invalid');
  const tag = data.tag_name!;
  const { stdout } = await exec('git', ['ls-remote', '--tags', REPOSITORY, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { timeout: 15_000, maxBuffer: 16_384 });
  const rows = stdout.trim().split('\n').map(row => row.split('\t'));
  const commit = rows.find(row => row[1] === `refs/tags/${tag}^{}`)?.[0] ?? rows.find(row => row[1] === `refs/tags/${tag}`)?.[0];
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw new HttpError(503, 'UPSTREAM_INVALID', 'Stable Hermes release commit could not be verified');
  const script = await fetch(`https://raw.githubusercontent.com/NousResearch/hermes-agent/${commit}/scripts/install.sh`, { signal: AbortSignal.timeout(10_000) });
  if (!script.ok) throw new HttpError(503, 'UPSTREAM_INVALID', 'Pinned Hermes bootstrap script is unavailable');
  const bytes = Buffer.from(await script.arrayBuffer());
  if (bytes.length > 200_000 || !bytes.toString('utf8').startsWith('#!/usr/bin/env bash'))
    throw new HttpError(503, 'UPSTREAM_INVALID', 'Pinned Hermes bootstrap script is invalid');
  const bootstrapScriptSha256 = createHash('sha256').update(bytes).digest('hex');
  cache = { tag, commit, bootstrapScriptSha256, expiresAt: Date.now() + 15 * 60_000 };
  return { tag, commit, bootstrapScriptSha256 };
}

export async function requestCoreSlot(host: string, installationId: string) {
  const release = await stableRelease();
  const db = getDb();
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('hermes-core-rollout', 0))`;
    let active = await tx.hermesCoreRollout.findFirst({ where: { status: 'active' }, orderBy: { createdAt: 'desc' }, include: { hosts: true } });
    if (!active) {
      const existing = await tx.hermesCoreRollout.findUnique({ where: { id: release.commit }, include: { hosts: true } });
      if (existing?.status === 'completed') return { allowed: false, status: 'current', tag: release.tag, commit: release.commit, bootstrapScriptSha256: release.bootstrapScriptSha256 };
      if (existing?.status === 'blocked') return { allowed: false, status: 'blocked', tag: existing.tag, commit: existing.id, bootstrapScriptSha256: release.bootstrapScriptSha256 };
      const installations = await tx.hermesInstallation.findMany({ select: { id: true, hostname: true, updatedAt: true }, orderBy: { updatedAt: 'desc' } });
      active = await tx.hermesCoreRollout.create({ data: { id: release.commit, tag: release.tag, bootstrapScriptSha256: release.bootstrapScriptSha256,
        hosts: { create: [...registryRolloutStages()].map(([hostname, stage]) => ({ hostname, stage,
          installationId: installations.find(row => row.hostname.split('.')[0]?.toLowerCase() === hostname)?.id ?? '' })) } }, include: { hosts: true } });
    }
    const target = active.hosts.find(row => row.hostname === host);
    if (!target || !registryRolloutStages().has(host)) throw new HttpError(403, 'REGISTRY_PULL_DISABLED', 'Host is outside the core rollout');
    if (target.installationId && target.installationId !== installationId)
      throw new HttpError(403, 'REGISTRY_IDENTITY_MISMATCH', 'Core slot belongs to a different installation');
    if (target.status === 'applied') return { allowed: false, status: 'applied', tag: active.tag, commit: active.id, bootstrapScriptSha256: active.bootstrapScriptSha256 };
    if (active.hosts.some(row => row.stage < target.stage && row.status !== 'applied'))
      return { allowed: false, status: 'waiting', tag: active.tag, commit: active.id, bootstrapScriptSha256: active.bootstrapScriptSha256 };
    if (target.status === 'running' && target.leaseExpiresAt && target.leaseExpiresAt > new Date())
      return { allowed: false, status: 'busy', tag: active.tag, commit: active.id, bootstrapScriptSha256: active.bootstrapScriptSha256 };
    await tx.hermesCoreRolloutHost.update({ where: { id: target.id }, data: { installationId, status: 'running',
      leaseExpiresAt: new Date(Date.now() + 2 * 60 * 60_000) } });
    return { allowed: true, status: 'running', tag: active.tag, commit: active.id, bootstrapScriptSha256: active.bootstrapScriptSha256 };
  });
}

export async function settleCoreSlot(host: string, installationId: string, input: { commit: string; status: 'applied' | 'failed';
  evidence: { beforeVersion?: string; afterVersion?: string; beforeGatewayActive?: boolean; afterGatewayActive?: boolean;
    backupSha256?: string; nativeReceiptSha256?: string; toolCheck?: boolean; pluginCheck?: boolean; error?: string } }) {
  const db = getDb();
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('hermes-core-rollout', 0))`;
    const rollout = await tx.hermesCoreRollout.findUnique({ where: { id: input.commit }, include: { hosts: true } });
    const target = rollout?.hosts.find(row => row.hostname === host && row.installationId === installationId);
    if (!rollout || rollout.status !== 'active' || !target || target.status !== 'running')
      throw new HttpError(409, 'CORE_SLOT_INVALID', 'No active core slot belongs to this host');
    if (input.status === 'applied' && (input.evidence.afterGatewayActive && !input.evidence.beforeGatewayActive
      || input.evidence.toolCheck !== true || input.evidence.pluginCheck !== true || !/^[a-f0-9]{64}$/.test(input.evidence.nativeReceiptSha256 ?? '')))
      throw new HttpError(400, 'CORE_RECEIPT_INVALID', 'Core update checks are incomplete or started an inactive gateway');
    await tx.hermesCoreRolloutHost.update({ where: { id: target.id }, data: { status: input.status, leaseExpiresAt: null,
      evidenceJson: JSON.stringify(input.evidence) } });
    if (input.status === 'failed') await tx.hermesCoreRollout.update({ where: { id: rollout.id }, data: { status: 'blocked' } });
    else if (rollout.hosts.every(row => row.id === target.id || row.status === 'applied'))
      await tx.hermesCoreRollout.update({ where: { id: rollout.id }, data: { status: 'completed' } });
    return { rolloutId: rollout.id, host, status: input.status };
  });
}
