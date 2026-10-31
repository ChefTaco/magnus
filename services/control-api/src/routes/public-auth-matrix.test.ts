import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppVariables } from '../types/index.js';
import { errorHandler } from '../middleware/error-handler.js';
import { ardentRouter } from './ardent.js';
import { healthRouter } from './health.js';
import { heartbeatRouter } from './heartbeat.js';
import { terminalTicketRouter } from './terminal-ticket.js';

function createMatrixApp(): Hono<AppVariables> {
  const app = new Hono<AppVariables>();
  app.onError(errorHandler);
  app.route('/ardent', ardentRouter);
  app.route('/health', healthRouter);
  app.route('/heartbeat', heartbeatRouter);
  app.route('/terminal', terminalTicketRouter);
  return app;
}

describe('Control API public/auth route matrix', () => {
  it('keeps only a minimal dependency-free health response public', async () => {
    const response = await createMatrixApp().request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { service: 'magnus-control-api', status: 'ok' },
    });
  });

  it.each([
    '/ardent/requests/396c43a3-4ca6-4c77-8bda-aa442a1afc81',
    '/ardent/requests/396c43a3-4ca6-4c77-8bda-aa442a1afc81/evidence',
    '/ardent/requests/396c43a3-4ca6-4c77-8bda-aa442a1afc81/artifacts/package',
    '/health/details',
    '/health/dependencies',
    '/health/forecast/at-risk',
    '/health/node-id/forecast',
    '/heartbeat/stream/stats',
  ])('rejects unauthenticated detail request %s', async (path) => {
    const response = await createMatrixApp().request(path);
    expect(response.status).toBe(401);
  });

  it('keeps the retired Redis stream heartbeat ingress closed', async () => {
    const response = await createMatrixApp().request('/heartbeat/stream', {
      method: 'POST', headers: { 'x-node-token': 'fixture', 'content-type': 'application/json' }, body: '{}',
    });
    expect(response.status).toBe(410);
    expect((await response.json()).error.code).toBe('HEARTBEAT_STREAM_RETIRED');
  });

  it('rejects unauthenticated terminal ticket creation before reading the body', async () => {
    const response = await createMatrixApp().request('/terminal/ticket', { method: 'POST' });
    expect(response.status).toBe(401);
  });
});
