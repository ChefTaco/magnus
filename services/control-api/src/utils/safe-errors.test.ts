import { describe, expect, it } from 'vitest';
import { clientErrorMessage, containsDatabaseText, databaseFailure, describeTransportFailure } from './safe-errors.js';

const prismaText = 'Invalid `prisma.remediationRule.create()` invocation in\n/opt/magnus/dist/services/remediation-service.js:113:1\nUnique constraint failed on the fields: (`name`)';
const known = (code: string, meta?: unknown) => Object.assign(new Error(prismaText), { name: 'PrismaClientKnownRequestError', code, meta });

describe('database failures', () => {
  it('names the record and field of a duplicate, from both constraint shapes', () => {
    expect(databaseFailure(known('P2002', { modelName: 'RemediationRule', target: ['name'] })))
      .toEqual({ status: 409, code: 'CONFLICT', message: 'A remediation rule with this name already exists.' });
    expect(databaseFailure(known('P2002', { modelName: 'HermesCredentialPool', driverAdapterError: { cause: { constraint: { fields: ['name'] } } } }))?.message)
      .toBe('A hermes credential pool with this name already exists.');
    expect(databaseFailure(known('P2002'))?.message).toBe('A record with the same unique value already exists.');
    const adapter = (table: string, index: string) => ({ modelName: 'NotificationPreference', driverAdapterError: { cause: { table, constraint: { index } } } });
    expect(databaseFailure(known('P2002', adapter('notification_preferences', 'notification_preferences_userId_channel_category_key')))?.message)
      .toBe('A notification preference with this user id and channel and category already exists.');
    expect(databaseFailure(known('P2002', adapter('other', 'notification_preferences_userId_key')))?.message)
      .toBe('A notification preference with the same unique value already exists.');
  });

  it.each([
    ['P2025', 404, 'NOT_FOUND'], ['P2003', 409, 'CONFLICT'], ['P2000', 400, 'VALIDATION_ERROR'],
    ['P2024', 503, 'DATABASE_UNAVAILABLE'], ['P1001', 503, 'DATABASE_UNAVAILABLE'], ['P2010', 500, 'INTERNAL_ERROR'],
  ])('maps %s to %i %s, with none of the original text', (code, status, name) => {
    const failure = databaseFailure(known(code));
    expect(failure).toMatchObject({ status, code: name });
    expect(failure?.message).not.toMatch(/prisma|invocation|\/opt\/|constraint/iu);
  });

  it('recognises errors without a request code', () => {
    expect(databaseFailure(Object.assign(new Error(prismaText), { name: 'PrismaClientValidationError' }))?.status).toBe(400);
    expect(databaseFailure(Object.assign(new Error("Can't reach database server at `db.example.com:5432`"), { name: 'PrismaClientInitializationError' }))?.status).toBe(503);
    expect(databaseFailure(Object.assign(new Error('panic'), { name: 'PrismaClientRustPanicError' }))?.status).toBe(500);
  });

  it('leaves other errors alone', () => {
    expect(databaseFailure(new Error('Webhook retries must be an integer'))).toBeNull();
    expect(databaseFailure(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBeNull();
  });

  it('gives clients an ordinary message, but not one that quotes the database', () => {
    expect(clientErrorMessage(new Error('Node is draining'), 'fallback')).toBe('Node is draining');
    expect(clientErrorMessage(known('P2025'), 'fallback')).toBe('The requested record was not found.');
    expect(clientErrorMessage(new Error(`Deploy failed: ${prismaText}`), 'fallback')).toBe('fallback');
    expect(clientErrorMessage('a string', 'fallback')).toBe('fallback');
    expect(containsDatabaseText(prismaText)).toBe(true);
  });
});

describe('transport failures', () => {
  const failed = (code: string, message: string) => new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });

  it.each([
    ['ECONNREFUSED', 'the connection was refused (ECONNREFUSED)'],
    ['ENOTFOUND', 'the address could not be resolved (ENOTFOUND)'],
    ['UND_ERR_CONNECT_TIMEOUT', 'the connection timed out (UND_ERR_CONNECT_TIMEOUT)'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'its TLS certificate could not be verified (DEPTH_ZERO_SELF_SIGNED_CERT)'],
  ])('explains %s without quoting the address', (code, expected) => {
    expect(describeTransportFailure(failed(code, `connect ${code} node-1.example.com:4100 https://192.0.2.10:4100/api/v1/storage-evidence`))).toBe(expected);
  });

  it('recognises a timeout and refuses to echo anything it does not know', () => {
    expect(describeTransportFailure(new DOMException('The operation was aborted', 'TimeoutError'))).toBe('the request timed out');
    expect(describeTransportFailure(new TypeError('fetch failed', { cause: new Error('secret-host.example.com rejected token=abc') }))).toBe('the request failed');
    expect(describeTransportFailure(failed('E_SOMETHING_NEW', 'token=abc'))).toBe('the request failed');
  });
});
