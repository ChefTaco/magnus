/** Request bodies of the agent-facing node credential routes (routes/node-enrollment.ts). */
import { z } from 'zod';

const proofSchema = z.object({ timestamp: z.string().regex(/^[1-9][0-9]{12,13}$/), nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
const keySchema = z.string().regex(/^[A-Za-z0-9+/]{59}=$/);
const fqdnSchema = z.string().min(1).max(253);
export const legacyUpgradeRequestSchema = z.object({ fqdn: fqdnSchema, publicKey: keySchema, proof: proofSchema }).strict();
export const enrollRequestSchema = z.object({ token: z.string().regex(/^mne_[A-Za-z0-9_-]{43}$/), fqdn: fqdnSchema, publicKey: keySchema, proof: proofSchema }).strict();
export const rotateRequestSchema = z.object({ fqdn: fqdnSchema, publicKey: keySchema, proof: proofSchema }).strict();
