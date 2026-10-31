import { getDb } from '../db/index.js';
import { NodeApiClient } from '../sdk/index.js';
import type { RoleApplicationStep } from '../types/index.js';
import { enqueueCommand } from '../queue/workers.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';

// ─── Role Application Service ───
// Orchestrates multi-step apply/remove of roles on nodes.

const CONTROL_API_URL = process.env['CONTROL_API_URL'] ?? 'https://localhost:4000';
import { getNodeManagerSecret } from '../utils/env.js';

/** Ensure the 'system' user exists — required as FK target for RemoteCommand.createdBy. */
let systemUserEnsured = false;
async function ensureSystemUser(): Promise<void> {
  if (systemUserEnsured) return;
  const db = getDb();
  const existing = await db.user.findUnique({ where: { id: 'system' } });
  if (!existing) {
    await db.user.create({
      data: {
        id: 'system',
        email: 'system@magnus.local',
        name: 'System',
        password: randomBytes(32).toString('hex'),
        role: 'ADMIN',
        active: true,
      },
    }).catch(() => {
      // Another concurrent call may have created it — ignore unique constraint errors
    });
  }
  systemUserEnsured = true;
}

interface ApplyContext {
  applicationId: string;
  nodeId: string;
  roleId: string;
  nodeBaseUrl: string;
  nodeToken: string;
}

/** Update a single step's status in the RoleApplication record. */
async function updateStep(
  applicationId: string,
  stepName: string,
  update: Partial<RoleApplicationStep>,
): Promise<void> {
  const db = getDb();
  const app = await db.roleApplication.findUnique({ where: { id: applicationId } });
  if (!app) return;

  const steps = JSON.parse(app.steps as string) as RoleApplicationStep[];
  const step = steps.find((s) => s.name === stepName);
  if (step) {
    Object.assign(step, update);
  }

  await db.roleApplication.update({
    where: { id: applicationId },
    data: { steps: JSON.stringify(steps) },
  });
}

/** Dispatch a command to a node and wait for the result. */
async function dispatchAndWait(
  ctx: ApplyContext,
  command: string,
  args: string[] = [],
  timeoutSeconds = 300,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const db = getDb();

  // Ensure the 'system' user exists (FK target for createdBy)
  await ensureSystemUser();

  // Create a RemoteCommand record
  const idempotencyKey = `role-${ctx.applicationId}-${nanoid()}`;
  const cmd = await db.remoteCommand.create({
    data: {
      nodeId: ctx.nodeId,
      command,
      args: JSON.stringify(args),
      timeoutSeconds,
      status: 'QUEUED',
      riskLevel: 'medium',
      idempotencyKey,
      createdBy: 'system',
    },
  });

  // Dispatch to queue
  const node = await db.node.findUnique({ where: { id: ctx.nodeId } });
  if (!node) throw new Error(`Node ${ctx.nodeId} not found`);
  await enqueueCommand(cmd.id);

  // Poll for completion (max wait = timeoutSeconds + 30s buffer)
  const deadline = Date.now() + (timeoutSeconds + 30) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const updated = await db.remoteCommand.findUnique({
      where: { id: cmd.id },
      include: { result: true },
    });
    if (updated && ['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED'].includes(updated.status)) {
      return {
        exitCode: updated.result?.exitCode ?? 1,
        stdout: updated.result?.stdout ?? '',
        stderr: updated.result?.stderr ?? '',
      };
    }
  }

  return { exitCode: 124, stdout: '', stderr: 'Timed out waiting for command result' };
}

/** Write a file to the node via the node-manager API.
 * Falls back to base64+command when the agent lacks /files/write (404). */
async function writeFileToNode(
  ctx: ApplyContext,
  filePath: string,
  content: string,
): Promise<void> {
  const client = new NodeApiClient({ baseUrl: ctx.nodeBaseUrl, nodeToken: ctx.nodeToken, resourceNodeId: ctx.nodeId });
  try {
    await client.writeFile({ filePath, content, createIfMissing: true });
  } catch (err: unknown) {
    // If the agent is old and doesn't have /files/write (404),
    // write via the command executor using base64 decode.
    const is404 =
      err && typeof err === 'object' && 'response' in err
        ? (err as { response: { status: number } }).response.status === 404
        : false;
    if (!is404) throw err;

    const b64 = Buffer.from(content, 'utf-8').toString('base64');
    const parentDir = filePath.replace(/\/[^/]+$/, '');
    const sq = (s: string): string => "'" + s.replace(/'/g, "'\\''" ) + "'";
    const cmd = `mkdir -p ${sq(parentDir)} && printf '%s' ${sq(b64)} | base64 -d > ${sq(filePath)}`;
    const result = await dispatchAndWait(ctx, 'bash', ['-c', cmd], 30);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || 'Failed to write file via command fallback');
    }
  }
}

// ─── Apply Role ───

export async function applyRole(applicationId: string): Promise<void> {
  const db = getDb();
  const application = await db.roleApplication.findUnique({
    where: { id: applicationId },
    include: { role: true, node: true },
  });
  if (!application) throw new Error('RoleApplication not found');

  const { role, node } = application;
  const ctx: ApplyContext = {
    applicationId,
    nodeId: node.id,
    roleId: role.id,
    nodeBaseUrl: getNodeBaseUrl(node.ipAddress, node.port),
    nodeToken: getNodeManagerSecret(),
  };

  // Build step list based on what the role configures
  const stepDefs: Array<{ name: string; condition: boolean }> = [
    { name: 'apt-packages', condition: (JSON.parse(role.aptPackages as string) as string[]).length > 0 },
    { name: 'npm-packages', condition: (JSON.parse(role.npmPackages as string) as string[]).length > 0 },
    { name: 'deploy-files', condition: (JSON.parse(role.libraryFileIds as string) as string[]).length > 0 },
    { name: 'deploy-skills', condition: (JSON.parse(role.skillNames as string) as string[]).length > 0 },
    { name: 'write-env', condition: Object.keys(JSON.parse(role.envConfig as string) as Record<string, string>).length > 0 },
    { name: 'docker-setup', condition: role.dockerEnabled },
    { name: 'firewall-setup', condition: role.firewallEnabled },
  ];

  const steps: RoleApplicationStep[] = stepDefs.map((s) => ({
    name: s.name,
    status: s.condition ? 'pending' : 'skipped',
  }));

  await db.roleApplication.update({
    where: { id: applicationId },
    data: {
      status: 'running',
      startedAt: new Date(),
      steps: JSON.stringify(steps),
    },
  });

  try {
    // 1. Apt packages
    const aptPkgs = JSON.parse(role.aptPackages as string) as string[];
    if (aptPkgs.length > 0) {
      await updateStep(applicationId, 'apt-packages', { status: 'running', startedAt: new Date().toISOString() });
      const result = await dispatchAndWait(
        ctx,
        'bash',
        ['-c', `DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq ${aptPkgs.join(' ')}`],
        600,
      );
      if (result.exitCode !== 0) {
        await updateStep(applicationId, 'apt-packages', { status: 'failed', error: result.stderr.slice(0, 500), completedAt: new Date().toISOString() });
        throw new Error(`apt install failed: ${result.stderr.slice(0, 200)}`);
      }
      await updateStep(applicationId, 'apt-packages', { status: 'completed', completedAt: new Date().toISOString() });
    }

    // 2. npm packages
    const npmPkgs = JSON.parse(role.npmPackages as string) as string[];
    if (npmPkgs.length > 0) {
      await updateStep(applicationId, 'npm-packages', { status: 'running', startedAt: new Date().toISOString() });
      const result = await dispatchAndWait(
        ctx,
        'bash',
        ['-c', `npm install -g ${npmPkgs.join(' ')}`],
        300,
      );
      if (result.exitCode !== 0) {
        await updateStep(applicationId, 'npm-packages', { status: 'failed', error: result.stderr.slice(0, 500), completedAt: new Date().toISOString() });
        throw new Error(`npm install failed: ${result.stderr.slice(0, 200)}`);
      }
      await updateStep(applicationId, 'npm-packages', { status: 'completed', completedAt: new Date().toISOString() });
    }

    // 3. Deploy Library files
    const fileIds = JSON.parse(role.libraryFileIds as string) as string[];
    if (fileIds.length > 0) {
      await updateStep(applicationId, 'deploy-files', { status: 'running', startedAt: new Date().toISOString() });
      for (const fileId of fileIds) {
        const libFile = await db.libraryFile.findUnique({ where: { id: fileId } });
        if (libFile) {
          const targetPath = `/opt/magnus/roles/${role.name}/${libFile.fileName}`;
          await writeFileToNode(ctx, targetPath, libFile.content);
        }
      }
      await updateStep(applicationId, 'deploy-files', { status: 'completed', completedAt: new Date().toISOString() });
    }

    // 4. Deploy skills
    const skillNames = JSON.parse(role.skillNames as string) as string[];
    if (skillNames.length > 0) {
      await updateStep(applicationId, 'deploy-skills', { status: 'running', startedAt: new Date().toISOString() });
      for (const skillName of skillNames) {
        // Create or update skill installation record
        await db.skillInstallation.upsert({
          where: { skillName_nodeId: { skillName, nodeId: ctx.nodeId } },
          create: {
            skillName,
            nodeId: ctx.nodeId,
            version: '1.0.0',
            status: 'installed',
            installedAt: new Date(),
          },
          update: {
            status: 'installed',
            installedAt: new Date(),
          },
        });
      }
      await updateStep(applicationId, 'deploy-skills', { status: 'completed', completedAt: new Date().toISOString() });
    }

    // 5. Write .env config
    const envConfig = JSON.parse(role.envConfig as string) as Record<string, string>;
    if (Object.keys(envConfig).length > 0) {
      await updateStep(applicationId, 'write-env', { status: 'running', startedAt: new Date().toISOString() });
      const envContent = Object.entries(envConfig)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n';
      await writeFileToNode(ctx, `/opt/magnus/roles/${role.name}/.env`, envContent);
      await updateStep(applicationId, 'write-env', { status: 'completed', completedAt: new Date().toISOString() });
    }

    // 6. Docker setup
    if (role.dockerEnabled) {
      await updateStep(applicationId, 'docker-setup', { status: 'running', startedAt: new Date().toISOString() });

      // Ensure Docker is installed
      await dispatchAndWait(ctx, 'bash', ['-c', 'command -v docker || (apt-get update -qq && apt-get install -y -qq docker.io)'], 300);

      // Write Dockerfile
      const dockerUser = role.dockerNonRoot ? '\nRUN useradd -m magnus\nUSER magnus' : '';
      const baseImage = role.dockerImage ?? 'node:22-slim';
      const dockerfile = `FROM ${baseImage}
WORKDIR /app
COPY . /app${dockerUser}
ENTRYPOINT ["bash", "-c", "source .env 2>/dev/null; exec \\"$@\\"", "--"]
CMD ["node", "."]
`;
      await writeFileToNode(ctx, `/opt/magnus/roles/${role.name}/Dockerfile`, dockerfile);

      // Build and run container
      const containerName = `magnus-role-${role.name}`;
      const dockerVolumes = JSON.parse(role.dockerVolumes as string) as string[];
      const volumeFlags = dockerVolumes.map((v: string) => `-v ${v}`).join(' ');
      const volumeStr = volumeFlags ? ` ${volumeFlags}` : '';
      await dispatchAndWait(
        ctx,
        'bash',
        ['-c', `cd /opt/magnus/roles/${role.name} && docker build -t ${containerName} . && docker rm -f ${containerName} 2>/dev/null; docker run -d --name ${containerName} --restart unless-stopped --network host${volumeStr} ${containerName}`],
        300,
      );

      await updateStep(applicationId, 'docker-setup', { status: 'completed', completedAt: new Date().toISOString() });
    }

    // 7. Firewall setup
    if (role.firewallEnabled) {
      await updateStep(applicationId, 'firewall-setup', { status: 'running', startedAt: new Date().toISOString() });

      const agentPort = node.port || 4100;
      const controlApiHost = new URL(CONTROL_API_URL).hostname;

      // Build UFW script
      const lines = [
        'ufw --force reset',
        'ufw default deny incoming',
        'ufw default allow outgoing',
        `ufw allow ${agentPort}/tcp comment "Magnus agent"`,
        'ufw allow 22/tcp comment "SSH"',
        `ufw allow from ${controlApiHost} comment "Magnus control-api"`,
      ];

      if (role.firewallMode === 'restrictive') {
        // Block RFC-1918 private ranges (after allow rules take precedence)
        lines.push(
          'ufw deny from 10.0.0.0/8',
          'ufw deny from 172.16.0.0/12',
          'ufw deny from 192.168.0.0/16',
        );
      } else if (role.firewallMode === 'custom') {
        const customRules = JSON.parse(role.firewallAllowRules as string) as string[];
        for (const rule of customRules) {
          // Rules can be "80/tcp", "443/tcp", "10.0.0.0/8", etc.
          if (rule.includes('/') && !rule.includes('.')) {
            lines.push(`ufw allow ${rule}`);
          } else {
            lines.push(`ufw allow from ${rule}`);
          }
        }
      }
      // 'permissive' mode = no extra deny/allow rules

      lines.push('ufw --force enable');

      const result = await dispatchAndWait(ctx, 'bash', ['-c', lines.join(' && ')], 120);
      if (result.exitCode !== 0) {
        await updateStep(applicationId, 'firewall-setup', { status: 'failed', error: result.stderr.slice(0, 500), completedAt: new Date().toISOString() });
        throw new Error(`UFW setup failed: ${result.stderr.slice(0, 200)}`);
      }
      await updateStep(applicationId, 'firewall-setup', { status: 'completed', completedAt: new Date().toISOString() });
    }

    // All done
    await db.roleApplication.update({
      where: { id: applicationId },
      data: { status: 'completed', completedAt: new Date() },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await db.roleApplication.update({
      where: { id: applicationId },
      data: { status: 'failed', error: message, completedAt: new Date() },
    });
  }
}

// ─── Remove Role ───

export async function removeRole(applicationId: string): Promise<void> {
  const db = getDb();
  const application = await db.roleApplication.findUnique({
    where: { id: applicationId },
    include: { role: true, node: true },
  });
  if (!application) throw new Error('RoleApplication not found');

  const { role, node } = application;
  const ctx: ApplyContext = {
    applicationId,
    nodeId: node.id,
    roleId: role.id,
    nodeBaseUrl: getNodeBaseUrl(node.ipAddress, node.port),
    nodeToken: getNodeManagerSecret(),
  };

  const steps: RoleApplicationStep[] = [
    { name: 'stop-services', status: 'pending' },
    { name: 'remove-docker', status: role.dockerEnabled ? 'pending' : 'skipped' },
    { name: 'remove-files', status: 'pending' },
    { name: 'remove-skills', status: (JSON.parse(role.skillNames as string) as string[]).length > 0 ? 'pending' : 'skipped' },
    { name: 'reset-firewall', status: role.firewallEnabled ? 'pending' : 'skipped' },
    { name: 'cleanup', status: 'pending' },
  ];

  await db.roleApplication.update({
    where: { id: applicationId },
    data: { status: 'running', startedAt: new Date(), steps: JSON.stringify(steps) },
  });

  try {
    // 1. Stop Orchestra / services
    await updateStep(applicationId, 'stop-services', { status: 'running', startedAt: new Date().toISOString() });
    if (role.dockerEnabled) {
      const containerName = `magnus-role-${role.name}`;
      await dispatchAndWait(ctx, 'bash', ['-c', `docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null; true`], 60);
    }
    // Try to stop Orchestra process if running outside Docker
    await dispatchAndWait(ctx, 'bash', ['-c', 'pkill -f magnus-agent 2>/dev/null; true'], 30);
    await updateStep(applicationId, 'stop-services', { status: 'completed', completedAt: new Date().toISOString() });

    // 2. Remove Docker artifacts
    if (role.dockerEnabled) {
      await updateStep(applicationId, 'remove-docker', { status: 'running', startedAt: new Date().toISOString() });
      const containerName = `magnus-role-${role.name}`;
      await dispatchAndWait(ctx, 'bash', ['-c', `docker rmi ${containerName} 2>/dev/null; true`], 60);
      await updateStep(applicationId, 'remove-docker', { status: 'completed', completedAt: new Date().toISOString() });
    }

    // 3. Remove deployed files
    await updateStep(applicationId, 'remove-files', { status: 'running', startedAt: new Date().toISOString() });
    await dispatchAndWait(ctx, 'rm', ['-rf', `/opt/magnus/roles/${role.name}`], 30);
    await updateStep(applicationId, 'remove-files', { status: 'completed', completedAt: new Date().toISOString() });

    // 4. Remove skills
    const skillNames = JSON.parse(role.skillNames as string) as string[];
    if (skillNames.length > 0) {
      await updateStep(applicationId, 'remove-skills', { status: 'running', startedAt: new Date().toISOString() });
      for (const skillName of skillNames) {
        await db.skillInstallation.deleteMany({
          where: { skillName, nodeId: ctx.nodeId },
        });
      }
      await updateStep(applicationId, 'remove-skills', { status: 'completed', completedAt: new Date().toISOString() });
    }

    // 5. Reset firewall
    if (role.firewallEnabled) {
      await updateStep(applicationId, 'reset-firewall', { status: 'running', startedAt: new Date().toISOString() });
      await dispatchAndWait(ctx, 'bash', ['-c', 'ufw --force reset && ufw --force disable'], 60);
      await updateStep(applicationId, 'reset-firewall', { status: 'completed', completedAt: new Date().toISOString() });
    }

    // 6. Cleanup — clear roleId from node
    await updateStep(applicationId, 'cleanup', { status: 'running', startedAt: new Date().toISOString() });
    await db.node.update({
      where: { id: ctx.nodeId },
      data: { roleId: null },
    });
    await updateStep(applicationId, 'cleanup', { status: 'completed', completedAt: new Date().toISOString() });

    await db.roleApplication.update({
      where: { id: applicationId },
      data: { status: 'completed', completedAt: new Date() },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await db.roleApplication.update({
      where: { id: applicationId },
      data: { status: 'failed', error: message, completedAt: new Date() },
    });
  }
}
