import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorHandler, HttpError } from './error-handler.js';

const prismaText = 'Invalid `prisma.remediationRule.create()` invocation in\n/opt/magnus/dist/services/remediation-service.js:113:1\nUnique constraint failed on the fields: (`name`)';

function appThrowing(error: Error) {
  const app = new Hono();
  app.onError(errorHandler);
  app.get('/', () => { throw error; });
  return app;
}

async function responseTo(error: Error) {
  const response = await appThrowing(error).request('/');
  return { status: response.status, body: await response.json() as { success: boolean; error: { code: string; message: string } } };
}

describe('global error handler', () => {
  afterEach(() => vi.restoreAllMocks());

  it('answers a duplicate with a clean 409 and keeps the Prisma text in the log', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = Object.assign(new Error(prismaText), { name: 'PrismaClientKnownRequestError', code: 'P2002', meta: { modelName: 'RemediationRule', target: ['name'] } });
    await expect(responseTo(error)).resolves.toEqual({
      status: 409,
      body: { success: false, error: { code: 'CONFLICT', message: 'A remediation rule with this name already exists.' } },
    });
    expect(log.mock.calls[0]?.[0]).toContain('[P2002]');
  });

  it('never sends database text, even wrapped in an HttpError', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { status, body } = await responseTo(new HttpError(404, 'NOT_FOUND', prismaText));
    expect(status).toBe(404);
    expect(JSON.stringify(body)).not.toMatch(/prisma|invocation|\/opt\//iu);
  });

  it('keeps an intended message and its status', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(responseTo(new HttpError(409, 'INVALID_STATE', 'The node must be ONLINE'))).resolves.toEqual({
      status: 409,
      body: { success: false, error: { code: 'INVALID_STATE', message: 'The node must be ONLINE' } },
    });
  });
});
