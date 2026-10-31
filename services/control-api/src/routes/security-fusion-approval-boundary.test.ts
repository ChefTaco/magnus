import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../utils/env.js', () => ({
  IAM_CORE_URL: '', IAM_TOKEN_ISSUER: '', IAM_TOKEN_AUDIENCE: '',
  JWT_SECRET: 'isolated-jwt-fixture-secret-at-least-32',
  API_SECRET: 'isolated-api-fixture-secret-at-least-32',
  MAGNUS_PLUGIN_API_ENABLED: true, MAGNUS_APPROVAL_BRIDGE_CONSUMER: '',
  MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON: '{}', MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256: '',
  MAGNUS_FLEET_CHECK_TOKEN_SHA256: '', MAGNUS_COLLECTOR_TOKEN_SHA256: '',
}));
vi.mock('../services/credential-rotation-service.js', () => ({
  verifyWithRotation: (_: string, expected: string, actual: string) => expected === actual,
}));
import { errorHandler } from '../middleware/error-handler.js';
import { securityFusionRouter } from './security-fusion.js';

const app = new Hono().route('/api/v1/security-fusion', securityFusionRouter).onError(errorHandler);
const headers = { 'x-api-secret': 'isolated-api-fixture-secret-at-least-32' };

beforeEach(() => vi.unstubAllEnvs());
describe('retired local containment approval', () => {
  it.each(['local', 'remote', undefined])('denies ADMIN approve and reject when mode is %s', async mode => {
    if (mode) vi.stubEnv('SECURITY_FUSION_MODE', mode);
    for (const action of ['approve', 'reject']) {
      const response = await app.request(`/api/v1/security-fusion/actions/fixture/${action}`, {
        method: 'POST', headers,
      });
      expect(response.status).toBe(403);
      const body = await response.json() as { error: { code: string } };
      expect(body.error.code).toMatch(/TELEGRAM_(?:APPROVAL|DECISION)_REQUIRED/);
    }
  });
});
