import { z } from 'zod';
import { commandFenceSchema } from './node-responses.js';
import { evidenceSignatureSchema } from './node-evidence.js';

export const commandReconciliationSchema = z.object({
  nodeFqdn: z.string().min(1).max(253),
  commandId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/), coordination: commandFenceSchema.optional(),
  disposition: z.enum(['effects_verified', 'no_effect_verified']),
  evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  approvalRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,199}$/),
  decisionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  expiresAt: z.number().int().positive().max(8_640_000_000_000_000),
  // COMMAND_RECONCILIATION_SECRET HMAC, for agents without a node key; absent when the server has no such secret.
  signature: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  // The server key's signature for this node (docs/NODE_CREDENTIALS.md); sent only to agents that verify it.
  serverSignature: evidenceSignatureSchema.optional(),
}).strict().refine(value => value.signature !== undefined || value.serverSignature !== undefined, { message: 'A reconciliation decision must be signed' });
