import { optional } from '../utils/optional.js';
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
import { commandCompletionRequestDescriptor } from '../security/command-completion-registry.js';

export const quickCommandRouter = new Hono<AppVariables>();
quickCommandRouter.use('*', authMiddleware);

/**
 * Run an exact registered finite diagnostic synchronously through managed
 * admission. Unsupported shell operations are refused before creating work.
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

    const timeoutSeconds = body.timeoutSeconds ?? 120;
    const args = body.args ?? [];
    // Only the existing fixed status button has a relative spelling alias. No
    // shell strings, changed argv, CWD or timeout acquire this diagnostic scope.
    const command = body.command === 'systemctl' && timeoutSeconds === 15 && body.workingDirectory === undefined
      && JSON.stringify(args) === JSON.stringify(['status', 'magnus-agent', '--no-pager'])
      ? '/usr/bin/systemctl' : body.command;
    if (!commandCompletionRequestDescriptor({ command, args, timeoutSeconds, ...optional('workingDirectory', body.workingDirectory) }))
      throw new HttpError(409, 'QUICK_COMMAND_UNAVAILABLE',
        'This quick command has no reviewed completion boundary. Use node diagnostics or a supported managed operation. No command was registered or executed.');
    const commandId = `cmd-${nanoid()}`;

    try {
      const client = new NodeApiClient({
        baseUrl: getNodeBaseUrl(node.ipAddress, node.port),
        resourceNodeId: node.id, resourceActorId: user.userId,
        nodeToken: getNodeManagerSecret(),
        timeout: (timeoutSeconds + 5) * 1_000,
      });

      const rawResponse = await client.executeCommand({ commandId, command, args, ...optional("workingDirectory", body.workingDirectory), timeoutSeconds });

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
      if (err instanceof HttpError) throw err;
      const message =
        err instanceof Error ? err.message : 'Failed to execute command on node';
      throw new HttpError(502, 'NODE_EXEC_FAILED', message);
    }
  },
);
