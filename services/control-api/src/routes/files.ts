import { clientErrorMessage } from '../utils/safe-errors.js';
import { Hono } from 'hono';
import path from 'node:path';
import type { AppVariables } from '../types/index.js';
import { getDb } from '../db/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { logAuditEvent } from '../services/audit-service.js';
import { NodeApiClient } from '../sdk/index.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { HttpError } from '../middleware/error-handler.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { parseBody } from '../utils/validate.js';
import { fileUpdateSchema } from '../schemas/files.js';
import { enforceIdempotencyFromHeader } from '../utils/idempotency.js';

/** POSIX single-quote a string for safe shell interpolation. */
function sq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export const filesRouter = new Hono<AppVariables>();
filesRouter.use('*', authMiddleware);

const STALE_THRESHOLD_MS = Number(process.env['STALE_NODE_THRESHOLD_MS'] ?? 120_000);

function isNodeStale(lastHeartbeatAt: Date | null): boolean {
  return !lastHeartbeatAt || Date.now() - lastHeartbeatAt.getTime() > STALE_THRESHOLD_MS;
}

const BLOCKED_PREFIXES = ['/proc/', '/sys/', '/dev/'];
const SENSITIVE_PREFIXES = ['/etc/', '/root/', '/var/lib/', '/var/spool/', '/boot/', '/usr/', '/bin/', '/sbin/', '/lib/', '/lib64/'];

/**
 * The one spelling of a requested path that policy is judged on and the agent is sent:
 * absolute, with `.`/`//` collapsed. `..` segments and NUL bytes are refused, not resolved.
 */
export function normalizeNodePath(filePath: string): string {
  if (filePath.includes('\0')) throw new HttpError(400, 'BLOCKED_PATH', 'File path must not contain NUL bytes');
  if (!filePath.startsWith('/')) throw new HttpError(400, 'BLOCKED_PATH', 'File path must be absolute');
  if (filePath.split('/').includes('..')) throw new HttpError(400, 'BLOCKED_PATH', 'File path must not contain .. segments');
  const normalized = path.posix.normalize(filePath);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

export function pathPolicy(filePath: string): 'safe-app-path' | 'sensitive-system-path' | 'blocked-path' {
  if (filePath === '/' || BLOCKED_PREFIXES.some((prefix) => filePath === prefix.slice(0, -1) || filePath.startsWith(prefix))) {
    return 'blocked-path';
  }
  if (SENSITIVE_PREFIXES.some((prefix) => filePath === prefix.replace(/\/$/, '') || filePath.startsWith(prefix))
    || filePath.split('/').includes('.ssh')) {
    return 'sensitive-system-path';
  }
  return 'safe-app-path';
}

// ── Push file update to nodes ──
filesRouter.post('/update', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const body = await parseBody(c, fileUpdateSchema);

  const nodeIds = body.nodeIds;
  const filePath = normalizeNodePath(body.filePath);
  const content = body.content;

  const policy = pathPolicy(filePath);
  if (policy === 'blocked-path') {
    throw new HttpError(400, 'BLOCKED_PATH', `File path is blocked by policy: ${filePath}`);
  }
  // System configuration, credentials and binaries change only with an ADMIN's authority.
  if (policy === 'sensitive-system-path' && user.role !== 'ADMIN') {
    throw new HttpError(403, 'SENSITIVE_PATH_ADMIN_ONLY', `Writing ${filePath} requires the ADMIN role`);
  }

  const nodes = await db.node.findMany({
    where: { id: { in: nodeIds }, status: 'ONLINE' },
  });

  const staleTargets = nodes.filter((node) => isNodeStale(node.lastHeartbeatAt));
  if (staleTargets.length > 0) {
    throw new HttpError(
      409,
      'STALE_NODE_BLOCKED',
      `File update blocked for stale node(s): ${staleTargets.map((node) => node.name).join(', ')}`,
    );
  }

  if (body.previewOnly) {
    return c.json({
      success: true,
      data: {
        previewOnly: true,
        filePath,
        policy,
        targetCount: nodes.length,
        backupPlanned: body.backup,
        contentBytes: Buffer.byteLength(content, 'utf-8'),
      },
    });
  }

  // Claim after validation/preview/preflight so a rejected retry is not a duplicate.
  await enforceIdempotencyFromHeader(c);
  const tasks = await Promise.all(
    nodes.map(async (node) => {
      const task = await db.filePatchTask.create({
        data: {
          nodeId: node.id,
          filePath,
          direction: 'push',
          content,
          status: 'pending',
          createdBy: user.userId,
        },
      });

      // Dispatch to node agent
      const client = new NodeApiClient({
        baseUrl: getNodeBaseUrl(node.ipAddress, node.port),
        resourceNodeId: node.id, resourceActorId: 'system:file-api',
        nodeToken: getNodeManagerSecret(),
      });

      try {
        // The agent judges the path first and only then makes the backup and writes, so a
        // refused write leaves nothing behind. Agents without that guarantee are refused.
        await client.writeFile({
          filePath,
          content,
          createIfMissing: body.createIfMissing ?? true,
          backup: body.backup,
        });

        await db.filePatchTask.update({
          where: { id: task.id },
          data: { status: 'completed', completedAt: new Date() },
        });
        return { ...task, status: 'completed' };
      } catch (err: unknown) {
        const message = clientErrorMessage(err, 'File update failed');
        await db.filePatchTask.update({
          where: { id: task.id },
          data: { status: 'failed', error: message },
        });
        return { ...task, status: 'failed', error: message };
      }
    }),
  );

  await logAuditEvent({
    action: 'file.update',
    actorId: user.userId,
    targetType: 'file',
    targetId: filePath,
    details: { nodeIds, filePath, policy },
  });

  // If every task failed, return 502 so the dashboard can show an error
  const allFailed = tasks.length > 0 && tasks.every((t) => t.status === 'failed');
  const statusCode = allFailed ? 502 : 201;
  return c.json({ success: !allFailed, data: tasks }, statusCode);
});

// ── Read file from a node ──
filesRouter.get('/read', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const nodeId = c.req.query('nodeId');
  const requestedPath = c.req.query('filePath');

  if (!nodeId || !requestedPath) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'nodeId and filePath are required');
  }
  const filePath = normalizeNodePath(requestedPath);

  const node = await db.node.findUnique({ where: { id: nodeId } });
  if (!node) throw new HttpError(404, 'NOT_FOUND', 'Node not found');

  const client = new NodeApiClient({
    baseUrl: getNodeBaseUrl(node.ipAddress, node.port),
        resourceNodeId: node.id, resourceActorId: 'system:file-api',
    nodeToken: getNodeManagerSecret(),
  });

  let responseData: unknown;

  try {
    const response = await client.readFile(filePath);
    responseData = response.data;
  } catch (err: unknown) {
    // Fallback: if the node-manager doesn't have /files/read (404 on older
    // agents), read the file via the command executor using `cat`.
    const is404 =
      err && typeof err === 'object' && 'response' in err
        ? (err as { response: { status: number } }).response.status === 404
        : false;

    if (!is404) throw err;

    const cmdRes = await client.executeCommand({
      commandId: `file-read-${Date.now()}`,
      command: `cat ${sq(filePath)}`,
      args: [],
      timeoutSeconds: 10,
    });
    const result = cmdRes.data;
    if (result.exitCode !== 0) {
      throw new HttpError(500, 'FILE_READ_ERROR', result.stderr || 'Failed to read file');
    }
    responseData = {
      nodeId: node.id,
      filePath,
      content: result.stdout,
      checksum: '',
      sizeBytes: result.stdout.length,
      modifiedAt: new Date().toISOString(),
    };
  }

  await logAuditEvent({
    action: 'file.read',
    actorId: user.userId,
    targetType: 'file',
    targetId: filePath,
    details: { nodeId },
  });

  return c.json({ success: true, data: responseData });
});
