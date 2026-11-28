import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppVariables } from '../types/index.js';

// Node-key enforce mode without a shared node secret: NODE_MANAGER_SECRET is empty. The API
// secret is a random value generated for this run.
const fixture = vi.hoisted(() => ({
  apiValue: (globalThis.crypto.getRandomValues(new Uint8Array(24)) as Uint8Array).reduce((text, byte) => text + byte.toString(16).padStart(2, '0'), ''),
  audit: [] as Array<{ action: string; targetId: string; details?: Record<string, unknown> }>,
}));
const audit = fixture.audit;
vi.mock('../utils/env.js', () => ({ API_SECRET: fixture.apiValue, NODE_MANAGER_SECRET: '' }));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (c: { set(key: string, value: unknown): void }, next: () => Promise<void>) => {
    c.set('user', { userId: 'admin-1', email: 'admin@example.com', role: 'ADMIN' });
    await next();
  },
  requireRole: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUser: (c: { get(key: string): unknown }) => c.get('user'),
}));
vi.mock('../services/audit-service.js', () => ({
  logAuditEvent: async (event: { action: string; targetId: string; details?: Record<string, unknown> }) => { audit.push(event); },
}));

const { errorHandler } = await import('../middleware/error-handler.js');
const { credentialsRouter } = await import('./credentials.js');
const { rotateCredential, getCredentialStatus } = await import('../services/credential-rotation-service.js');
const app = new Hono<AppVariables>().route('/credentials', credentialsRouter).onError(errorHandler);

let tempDir = '';
beforeEach(() => {
  audit.length = 0;
  tempDir = mkdtempSync(join(tmpdir(), 'magnus-credentials-route-'));
  process.env['CREDENTIAL_ROTATION_STATE_PATH'] = join(tempDir, 'credential-rotations.json');
  process.env['CREDENTIAL_ROTATION_KEY'] = 'unit-test-rotation-key-that-is-32-bytes';
});
afterEach(() => {
  delete process.env['CREDENTIAL_ROTATION_STATE_PATH'];
  delete process.env['CREDENTIAL_ROTATION_KEY'];
  rmSync(tempDir, { recursive: true, force: true });
});

describe('shared credential routes in node-key enforce mode', () => {
  it('reports NODE_MANAGER_SECRET as not configured instead of failing', async () => {
    const response = await app.request('/credentials/NODE_MANAGER_SECRET/status');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: {
      name: 'NODE_MANAGER_SECRET', configured: false, activeFingerprint: null, previousFingerprint: null,
      rotatedAt: null, expiresAt: null, gracePeriodMs: null,
    } });
  });

  it('retires a previous value left from an earlier rotation, and audits it', async () => {
    const earlier = rotateCredential('NODE_MANAGER_SECRET', 'earlier-node-secret-that-is-at-least-32-chars', 60_000);
    const response = await app.request('/credentials/NODE_MANAGER_SECRET/retire-previous', { method: 'POST' });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ configured: false, activeFingerprint: null, retiredPreviousFingerprint: earlier.previousFingerprint });
    expect(audit).toEqual([expect.objectContaining({ action: 'credentials.rotate', targetId: 'NODE_MANAGER_SECRET',
      details: expect.objectContaining({ operation: 'retire-previous', configured: false, retiredPreviousFingerprint: earlier.previousFingerprint }) })]);

    const again = await app.request('/credentials/NODE_MANAGER_SECRET/retire-previous', { method: 'POST' });
    expect(((await again.json()) as { data: Record<string, unknown> }).data['retiredPreviousFingerprint']).toBeNull();
  });

  it('lists a leftover NODE_MANAGER_SECRET record as not configured, as its status does', async () => {
    rotateCredential('NODE_MANAGER_SECRET', 'earlier-node-secret-that-is-at-least-32-chars', 60_000);
    const status = ((await (await app.request('/credentials/NODE_MANAGER_SECRET/status')).json()) as { data: unknown }).data;
    const response = await app.request('/credentials/rotations');
    expect(response.status).toBe(200);
    const rotations = ((await response.json()) as { data: Array<{ name: string }> }).data;
    expect(rotations).toEqual([status]);
    expect(rotations[0]).toMatchObject({ name: 'NODE_MANAGER_SECRET', configured: false, activeFingerprint: null, previousFingerprint: null });
  });

  it('keeps API_SECRET status working', async () => {
    const response = await app.request('/credentials/API_SECRET/status');
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: unknown }).data).toEqual(getCredentialStatus('API_SECRET', fixture.apiValue));
  });

  it('answers errors with the ApiError envelope and the same status codes', async () => {
    const unknown = await app.request('/credentials/JWT_SECRET/status');
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ success: false, error: { code: 'UNKNOWN_CREDENTIAL', message: 'Unknown credential: JWT_SECRET' } });
    expect((await app.request('/credentials/JWT_SECRET/retire-previous', { method: 'POST' })).status).toBe(400);
    expect(audit).toEqual([]);

    const rotate = await app.request('/credentials/rotate', { method: 'POST' });
    expect(rotate.status).toBe(410);
    expect(await rotate.json()).toMatchObject({ success: false, error: { code: 'CREDENTIAL_ROTATION_RETIRED' } });
    const rollout = await app.request('/credentials/API_SECRET/rollout', { method: 'POST' });
    expect(rollout.status).toBe(410);
    expect(await rollout.json()).toMatchObject({ success: false, error: { code: 'CREDENTIAL_ROLLOUT_RETIRED' } });
  });
});
