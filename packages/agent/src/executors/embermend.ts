import { Hono } from 'hono';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { embermendOperationSchema, embermendCanonical, embermendResultPointerSchema } from '@hivemagnus/magnus-contracts/embermend';
import { requirePrivileged } from '../privileged.js';
import { managedExecution } from '../security/managed-context.js';
import { ExecutionSupervisor } from './execution-supervisor.js';
import { loadEmbermendConfig } from './embermend-config.js';
import { logger } from '../utils/logger.js';
import { readJson } from './execution-supervisor-state.js';
import { embermendNativeResultSchema } from '@hivemagnus/magnus-contracts/embermend';
import { workerContainerGone } from './embermend-scan.js';

export const embermendRoutes = new Hono();
embermendRoutes.get('/results/:operationId', async c => {
  const directory = resolve(process.env['AGENT_INSTALL_DIR'] ?? process.cwd(), '.magnus/embermend-results');
  const key = z.string().regex(/^[a-f0-9]{64}$/).parse(c.req.query('resultKey'));
  const value = await readJson<unknown>(directory, key + '.json', 8 * 1024 * 1024);
  if (!value) return c.json({ success: false, error: { code: 'RESULT_UNAVAILABLE' } }, 404);
  return c.json(embermendNativeResultSchema.parse(value));
});
embermendRoutes.get('/capabilities', async c => {
  const configured = await loadEmbermendConfig().catch(() => null);
  const os = await readFile('/etc/os-release', 'utf8').catch(() => '');
  const platform = /^ID=ubuntu$/m.test(os) && /^VERSION_ID="24.04"$/m.test(os) ? 'ubuntu-24.04' : 'unsupported';
  const ready = platform === 'ubuntu-24.04' && configured && process.env['MAGNUS_EXECUTION_SUPERVISOR_ENABLED'] === 'true' && process.env['MAGNUS_AGENT_PRIVILEGED'] !== 'false';
  const kinds = configured ? Object.values(configured.resources).map(resource => resource.kind) : [];
  const actions = ready ? ['inventory.v1', ...(configured.trivy ? ['image-vulnerabilities.v1'] : []), ...(configured.ovalEnabled && await access('/usr/bin/oscap', constants.X_OK).then(() => true, () => false) ? ['ubuntu-oval.v1'] : []), ...(kinds.includes('file') ? ['file-mode.v1', 'configuration-recover.v1'] : []), ...(kinds.includes('ssh') ? ['ssh-policy.v1', 'configuration-recover.v1'] : []), ...(kinds.includes('firewall') ? ['firewall-rule.v1'] : []), ...(kinds.includes('service') ? ['service-state.v1', 'restart-service.v1'] : []), ...(kinds.includes('compose') ? ['compose-deploy.v1', 'configuration-recover.v1'] : []), ...(configured.securityPackages.length ? ['security-update-preview.v1', 'security-update.v1'] : []), ...(configured.worker ? ['repository-scan.v1', 'repository-prepare.v1', 'repository-source.v1'] : [])] : [];
  return c.json({ success: true, data: { protocol: 1, platform, targetKind: 'host', actions: [...new Set(actions)] } });
});
embermendRoutes.post('/action', requirePrivileged('embermend'), async c => {
  const request = embermendOperationSchema.parse(await c.req.json()); const context = managedExecution.getStore();
  if (!context || !context.coordination || process.env['MAGNUS_EXECUTION_SUPERVISOR_ENABLED'] !== 'true') return c.json({ success: false, error: { code: 'MANAGED_SUPERVISOR_REQUIRED' } }, 403);
  const config = await loadEmbermendConfig();
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const worker = join(dirname(fileURLToPath(import.meta.url)), 'embermend-worker.js');
  const commandId = 'embermend-' + createHash('sha256').update(context.commandId + ':' + context.requestSha256).digest('hex');
  const agentCgroup = await readFile('/proc/self/cgroup', 'utf8');
  const agentUnit = agentCgroup.split('/').find(part => part.trim().endsWith('.service'))?.trim() ?? '';
  const observation = await new ExecutionSupervisor().run({ commandId, command: quote('/usr/bin/node'), args: [quote(worker)], timeoutSeconds: 780, coordination: context.coordination, environment: { EMBERMEND_AGENT_UNIT: agentUnit, EMBERMEND_REQUEST: JSON.stringify(request), MAGNUS_EMBERMEND_CONFIG: process.env['MAGNUS_EMBERMEND_CONFIG'] ?? '', NODE_MANAGER_PORT: process.env['NODE_MANAGER_PORT'] ?? '4100', AGENT_INSTALL_DIR: process.env['AGENT_INSTALL_DIR'] ?? process.cwd() } });
  if (['repository-scan.v1', 'repository-prepare.v1', 'repository-source.v1'].includes(request.action.version)) {
    const inner = z.object({ request: z.object({ operationId: z.string().optional(), id: z.string().optional() }).passthrough() }).passthrough().parse(request.action.parameters).request;
    const id = inner.operationId ?? inner.id;
    if (!id || !config.worker || !await workerContainerGone(config.worker, id)) return c.json({ success: false, error: { code: 'DETACHED_WORKER_COMPLETION_UNKNOWN' } }, 503);
  }
  if (observation.state !== 'completed' || observation.evidence.groupEmpty !== true || !observation.result || observation.result.truncated || observation.result.exitCode === 70) {
    logger.warn('Embermend supervised completion is uncertain; original receipt retained');
    return c.json({ success: false, error: { code: 'EXECUTION_UNKNOWN' } }, 503);
  }
  if (observation.result.exitCode !== 0) return c.json({ success: false, data: { exitCode: observation.result.exitCode } }, 422);
  const pointer = embermendResultPointerSchema.parse({ success: true, data: JSON.parse(observation.result.stdout) });
  const expectedKey = createHash('sha256').update(request.operationId + ':' + createHash('sha256').update(embermendCanonical(request)).digest('hex')).digest('hex');
  if (pointer.data.resultKey !== expectedKey) throw new Error('Native result request binding differs');
  return c.json(pointer);
});
