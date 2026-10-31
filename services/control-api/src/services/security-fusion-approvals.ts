import { HttpError } from '../middleware/error-handler.js';
import { approvalDigest } from '../security/approval-assertion.js';

const PLAN_FIELDS = ['plan_id','revision','action','targets','steps','risk','rollback','evidence','expires_at'] as const;

function configuration() {
  const base = process.env['SECURITY_FUSION_API_URL']?.replace(/\/$/u, '');
  const token = process.env['SECURITY_APPROVAL_BRIDGE_TOKEN'];
  if (!base && !token) return null;
  if (!base || !token || token.length < 32) throw new HttpError(503, 'CONTAINMENT_APPROVAL_UNAVAILABLE', 'Security Fusion approval bridge is not fully configured');
  let parsed: URL;
  try { parsed = new URL(base); } catch { throw new HttpError(503, 'CONTAINMENT_APPROVAL_UNAVAILABLE', 'Security Fusion approval bridge origin is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname)
    throw new HttpError(503, 'CONTAINMENT_APPROVAL_UNAVAILABLE', 'Security Fusion approval bridge requires a fixed HTTPS origin');
  return { base, token };
}

function validatePlan(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(502, 'INVALID_CONTAINMENT_PLAN', 'Security Fusion returned an invalid containment plan');
  const item = raw as Record<string, unknown>;
  if (Object.keys(item).length !== PLAN_FIELDS.length + 1 || PLAN_FIELDS.some(key => !(key in item))
    || typeof item['plan_sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(item['plan_sha256'])
    || typeof item['plan_id'] !== 'string' || !item['plan_id'].startsWith('containment:')
    || typeof item['action'] !== 'string' || !item['action'].startsWith('security.containment.'))
    throw new HttpError(502, 'INVALID_CONTAINMENT_PLAN', 'Security Fusion returned an invalid containment plan');
  const view = Object.fromEntries(PLAN_FIELDS.map(key => [key, item[key]]));
  if (approvalDigest(view) !== item['plan_sha256']) throw new HttpError(502, 'INVALID_CONTAINMENT_PLAN', 'Security Fusion containment plan digest is invalid');
  return item;
}

async function request(path: string, init?: RequestInit) {
  const config = configuration();
  if (!config) return null;
  try {
    const response = await fetch(config.base + '/api/v1/security-fusion' + path, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    const text = await response.text();
    if (text.length > 65_536) throw new Error('oversize');
    const body = JSON.parse(text) as { success?: boolean; data?: unknown; error?: { code?: string; message?: string } };
    if (!response.ok || body.success !== true) {
      const status = [400, 403, 404, 409].includes(response.status) ? response.status : 502;
      throw new HttpError(status, body.error?.code ?? 'CONTAINMENT_APPROVAL_UNAVAILABLE', body.error?.message ?? 'Security Fusion approval bridge rejected the request');
    }
    return body.data;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'CONTAINMENT_APPROVAL_UNAVAILABLE', 'Security Fusion approval bridge is unavailable');
  }
}

export async function listSecurityFusionApprovalPlans() {
  const data = await request('/approval-plans');
  if (data === null) return [];
  if (!data || typeof data !== 'object' || !Array.isArray((data as { plans?: unknown }).plans)
    || (data as { plans: unknown[] }).plans.length > 20)
    throw new HttpError(502, 'INVALID_CONTAINMENT_PLAN', 'Security Fusion returned an invalid plan list');
  return (data as { plans: unknown[] }).plans.map(validatePlan);
}

export async function getSecurityFusionApprovalPlan(planId: string) {
  const data = await request('/approval-plans/' + encodeURIComponent(planId));
  if (data === null) throw new HttpError(503, 'CONTAINMENT_APPROVAL_UNAVAILABLE', 'Security Fusion approval bridge is not configured');
  return validatePlan(data);
}

export async function forwardSecurityFusionApproval(raw: unknown) {
  const data = await request('/approval-decisions', { method: 'POST', body: JSON.stringify(raw) });
  if (data === null) throw new HttpError(503, 'CONTAINMENT_APPROVAL_UNAVAILABLE', 'Security Fusion approval bridge is not configured');
  return data;
}
