import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { logAuditEvent } from '../services/audit-service.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { HttpError } from '../middleware/error-handler.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { parseBody } from '../utils/validate.js';
import { quickCommandSchema } from '../schemas/commands.js';
import { safeParse } from '../utils/validate.js';
import { quickCommandResponseSchema } from '../schemas/node-responses.js';
import { NodeApiClient } from '../sdk/node-api-client.js';

export const quickCommandRouter = new Hono<AppVariables>();
quickCommandRouter.use('*', authMiddleware);

/**
 * Execute a command on a node synchronously (bypasses the BullMQ queue).
 * Ideal for quick admin commands where you want to see results immediately.
 */
quickCommandRouter.post(
  '/:nodeId/exec',
  requireRole('ADMIN', 'OPERATOR'),
  async (c) => {
    const db = getDb();
    const user = getUser(c);
    const nodeId = c.req.param('nodeId')!;
    const body = await parseBody(c, quickCommandSchema);

    const node = await db.node.findUnique({ where: { id: nodeId } });
    if (!node) throw new HttpError(404, 'NOT_FOUND', 'Node not found');
    if (node.status !== 'ONLINE') {
      throw new HttpError(409, 'INVALID_STATE', `Node is ${node.status}, must be ONLINE`);
    }

    const commandId = `cmd-${nanoid()}`;
    const timeoutSeconds = body.timeoutSeconds ?? 120;

    try {
      const client = new NodeApiClient({
        baseUrl: getNodeBaseUrl(node.ipAddress, node.port),
        resourceNodeId: node.id, resourceActorId: user.userId,
        nodeToken: getNodeManagerSecret(),
        timeout: (timeoutSeconds + 5) * 1_000,
      });

      const rawResponse = await client.executeCommand({
        commandId,
        command: body.command,
        args: body.args ?? [],
        workingDirectory: body.workingDirectory,
        timeoutSeconds,
      });

      // Validate response shape from node-manager
      const parsed = safeParse(rawResponse, quickCommandResponseSchema);
      if (!parsed.success) {
        throw new Error(`Invalid response from node-manager: ${parsed.error}`);
      }
      const response = parsed.data;

      await logAuditEvent({
        action: 'command.quick_exec',
        actorId: user.userId,
        targetType: 'node',
        targetId: nodeId,
        details: {
          command: body.command,
          args: body.args ?? [],
          exitCode: response.data.exitCode,
          durationMs: response.data.durationMs,
        },
      });

      return c.json({ success: true, data: response.data });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to execute command on node';
      throw new HttpError(502, 'NODE_EXEC_FAILED', message);
    }
  },
);
