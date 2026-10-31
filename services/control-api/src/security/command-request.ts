import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { commandFenceSchema } from '../schemas/node-responses.js';

export interface CommandRequest {
  commandId: string; command: string; args: string[]; workingDirectory?: string;
  environment?: Record<string, string>; timeoutSeconds: number;
  coordination?: z.infer<typeof commandFenceSchema>;
}

// Canonical wire digest mirrored by the independently packaged node agent.
// Cross-package fixtures guard compatibility without a runtime workspace import.
export function commandRequestDigest(input: CommandRequest): string {
  return createHash('sha256').update(JSON.stringify({ commandId: input.commandId, command: input.command, args: input.args,
    workingDirectory: input.workingDirectory ?? null,
    environment: Object.fromEntries(Object.entries(input.environment ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    timeoutSeconds: input.timeoutSeconds, coordination: input.coordination ? {
      version: 1, resourceKey: input.coordination.resourceKey, fence: input.coordination.fence, expiresAt: input.coordination.expiresAt,
    } : null })).digest('hex');
}
