import { Hono } from 'hono';
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

function pathPolicy(filePath: string): 'safe-app-path' | 'sensitive-system-path' | 'blocked-path' {
  if (filePath.includes('..') || filePath.trim() === '/' || filePath.startsWith('/proc/') || filePath.startsWith('/sys/')) {
    return 'blocked-path';
  }
  if (filePath.startsWith('/etc/') || filePath.startsWith('/root/') || filePath.startsWith('/var/lib/')) {
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
  const filePath = body.filePath;
  const content = body.content;

  const nodes = await db.node.findMany({
    where: { id: { in: nodeIds }, status: 'ONLINE' },
  });

  const policy = pathPolicy(filePath);
  if (policy === 'blocked-path') {
    throw new HttpError(400, 'BLOCKED_PATH', `File path is blocked by policy: ${filePath}`);
  }

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
        if (body.backup) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          await client.executeCommand({
            commandId: `file-backup-${Date.now()}`,
            command: `if [ -f ${sq(filePath)} ]; then cp -p ${sq(filePath)} ${sq(`${filePath}.magnus-backup.${stamp}`)}; fi`,
            args: [],
            timeoutSeconds: 15,
          }).catch(() => {
            // Backup is best-effort for compatibility with restricted paths;
            // the write path below will still report any real failure.
          });
        }

        try {
          await client.writeFile({
            filePath,
            content,
            createIfMissing: body.createIfMissing ?? true,
          });
        } catch (writeErr: unknown) {
          // Fallback: if the agent is old and doesn't have /files/write (404),
          // write via the command executor using base64 decode piped to tee.
          const is404 =
            writeErr &&
            typeof writeErr === 'object' &&
            'response' in writeErr
              ? (writeErr as { response: { status: number } }).response.status === 404
              : false;

          if (!is404) throw writeErr;

          // Encode content as base64 to avoid shell escaping issues with
          // arbitrary file content (quotes, newlines, special chars, etc.)
          const b64 = Buffer.from(content, 'utf-8').toString('base64');
          const parentDir = filePath.replace(/\/[^/]+$/, '');
          const mkdirPrefix = body.createIfMissing !== false
            ? `mkdir -p ${sq(parentDir)} && `
            : '';
          const pipeRes = await client.executeCommand({
            commandId: `file-write-${Date.now()}`,
            command: `${mkdirPrefix}printf '%s' ${sq(b64)} | base64 -d > ${sq(filePath)}`,
            args: [],
            timeoutSeconds: 15,
          });
          if (pipeRes.data.exitCode !== 0) {
            throw new Error(pipeRes.data.stderr || 'Failed to write file via command fallback');
          }
        }

        await db.filePatchTask.update({
          where: { id: task.id },
          data: { status: 'completed', completedAt: new Date() },
        });
        return { ...task, status: 'completed' };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
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
    details: { nodeIds, filePath },
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
  const filePath = c.req.query('filePath');

  if (!nodeId || !filePath) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'nodeId and filePath are required');
  }

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
