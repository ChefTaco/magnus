import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';

/** Signature domain prefix for approval assertions; the signed message is `<prefix>.v<version>\n<canonical payload>`. */
export const DEFAULT_APPROVAL_ASSERTION_DOMAIN = 'magnus.approval-assertion';
export const approvalAssertionDomainPattern = /^[a-z0-9](?:[a-z0-9.-]{0,98}[a-z0-9])?$/;
/**
 * Accepted signature domain prefixes, in preference order. The first one is the
 * domain this server would sign with. `MAGNUS_APPROVAL_ASSERTION_DOMAINS`
 * (comma-separated) lets older signers that use another prefix keep working.
 */
export function approvalAssertionDomains(value = process.env['MAGNUS_APPROVAL_ASSERTION_DOMAINS']): string[] {
  if (value === undefined || value.trim() === '') return [DEFAULT_APPROVAL_ASSERTION_DOMAIN];
  const domains = value.split(',').map(item => item.trim()).filter(Boolean);
  if (!domains.length || domains.some(domain => !approvalAssertionDomainPattern.test(domain)))
    throw new Error('MAGNUS_APPROVAL_ASSERTION_DOMAINS must list domain prefixes made of a-z, 0-9, "." and "-"');
  return [...new Set(domains)];
}
/** The exact bytes signed for an approval payload under a domain prefix. */
export function approvalSigningMessage(payload: ApprovalPayload, domain = approvalAssertionDomains()[0]!): Buffer {
  return Buffer.from(`${domain}.v${payload.version}\n` + approvalPayloadCanonical(payload));
}

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const payloadFields = {
  proposal_id: identifier, proposal_revision: z.number().int().positive(),
  plan_sha256: digest, decision: z.enum(['approve', 'reject']), decision_id: identifier,
  decided_at: z.number().int().positive(), expires_at: z.number().int().positive(),
  actor_binding_sha256: digest, execution_id: identifier.nullable(),
} as const;
function validateBinding(p: { decision: 'approve' | 'reject'; execution_id: string | null }, context: z.RefinementCtx) {
  if ((p.decision === 'approve') !== (p.execution_id !== null)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Approval execution binding is invalid' });
}
const v2PayloadSchema = z.object({ version: z.literal(2), ...payloadFields }).strict().superRefine(validateBinding);
const v3PayloadSchema = z.object({
  version: z.literal(3), source_channel: z.enum(['telegram', 'iphone']), ...payloadFields,
}).strict().superRefine(validateBinding);
export const approvalPayloadSchema = z.union([v2PayloadSchema, v3PayloadSchema]);
export const approvalAssertionSchema = z.object({ payload: approvalPayloadSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export type ApprovalPayload = z.infer<typeof approvalPayloadSchema>;

/** Python ensure_ascii=True compatible canonical JSON; order is deliberate. */
export function approvalCanonicalJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, char => '\\u'+char.charCodeAt(0).toString(16).padStart(4, '0'));
}
export function approvalPayloadCanonical(p: ApprovalPayload): string {
  return approvalCanonicalJson({ version: p.version, ...(p.version === 3 ? { source_channel: p.source_channel } : {}), proposal_id: p.proposal_id, proposal_revision: p.proposal_revision,
    plan_sha256: p.plan_sha256, decision: p.decision, decision_id: p.decision_id, decided_at: p.decided_at,
    expires_at: p.expires_at, actor_binding_sha256: p.actor_binding_sha256, execution_id: p.execution_id });
}
export function approvalDigest(value: unknown): string { return createHash('sha256').update(approvalCanonicalJson(value)).digest('hex'); }
export function verifyApprovalAssertion(raw: unknown): { payload: ApprovalPayload; assertionSha256: string } {
  const parsed = approvalAssertionSchema.safeParse(raw);
  const channel = parsed.success && parsed.data.payload.version === 3 ? parsed.data.payload.source_channel : 'telegram';
  const actor = process.env[channel === 'iphone' ? 'APPROVAL_IPHONE_ACTOR_SHA256' : 'APPROVAL_TELEGRAM_ACTOR_SHA256'] ?? '';
  if (!parsed.success || !/^[a-f0-9]{64}$/.test(actor))
    throw new HttpError(403, 'APPROVAL_ASSERTION_REQUIRED', 'A configured, signed approval decision is required');
  const { payload, signature } = parsed.data;
  const canonical = approvalPayloadCanonical(payload);
  let valid = false;
  try {
    const inline = process.env['APPROVAL_SIGNER_PUBLIC_KEY_PEM'];
    const encoded = process.env['APPROVAL_SIGNER_PUBLIC_KEY_B64'];
    const path = process.env['APPROVAL_SIGNER_PUBLIC_KEY_PATH'];
    if (!inline && !encoded && !path) throw new Error('missing key');
    const key = createPublicKey(inline ?? (encoded
      ? { key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' }
      : readFileSync(path!, 'utf8')));
    const signatureBytes = Buffer.from(signature, 'base64url');
    valid = key.asymmetricKeyType === 'ed25519' && approvalAssertionDomains()
      .some(domain => verify(null, approvalSigningMessage(payload, domain), key, signatureBytes));
  } catch { valid = false; }
  if (!valid || !timingSafeEqual(Buffer.from(actor, 'hex'), Buffer.from(payload.actor_binding_sha256, 'hex')))
    throw new HttpError(403, 'APPROVAL_ASSERTION_INVALID', 'Approval decision authentication failed');
  return { payload, assertionSha256: createHash('sha256').update(canonical+'\n'+signature).digest('hex') };
}
export function requireFreshApproval(p: ApprovalPayload, now = Date.now()) {
  if (p.decided_at > now + 30_000 || p.expires_at <= now || p.decided_at >= p.expires_at
    || p.expires_at - p.decided_at > 15 * 60_000)
    throw new HttpError(409, 'APPROVAL_ASSERTION_EXPIRED', 'Approval decision is expired or has an invalid lifetime');
}
