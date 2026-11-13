import { z } from 'zod';

/** Ed25519 signature of node evidence or a server decision (security/node-evidence.ts); checked there, shaped here. */
export const evidenceSignatureSchema = z.object({
  alg: z.literal('ed25519'),
  v: z.literal(1),
  nodeId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  keyId: z.string().regex(/^[a-f0-9]{64}$/),
  sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict();
export type EvidenceSignatureValue = z.infer<typeof evidenceSignatureSchema>;
