import { describe, expect, it } from 'vitest';
import { apiErrorMessage, httpErrorBody } from './http-error-body';

describe('httpErrorBody', () => {
  it('prefers the body Ky already read into error.data', async () => {
    const consumed = new Response('{"ignored":true}');
    await consumed.text();
    const error = Object.assign(new Error('Request failed'), {
      data: { error: { message: 'Node is offline' } },
      response: consumed,
    });
    expect(await httpErrorBody(error)).toEqual({ error: { message: 'Node is offline' } });
  });

  it('reads an unconsumed response for errors raised outside Ky', async () => {
    const error = { response: new Response('{"error":{"message":"Denied"}}', { status: 403 }) };
    expect(await httpErrorBody(error)).toEqual({ error: { message: 'Denied' } });
  });

  it('returns plain text bodies and null when nothing is readable', async () => {
    expect(await httpErrorBody({ response: new Response('upstream timeout') })).toBe('upstream timeout');
    const consumed = new Response('gone');
    await consumed.text();
    expect(await httpErrorBody({ response: consumed })).toBeNull();
    expect(await httpErrorBody(new Error('network'))).toBeNull();
  });
});

describe('apiErrorMessage', () => {
  it('extracts error.message from a Magnus API error body', () => {
    expect(apiErrorMessage({ error: { message: 'Bad input' } })).toBe('Bad input');
    expect(apiErrorMessage({ error: 'flat' })).toBeUndefined();
    expect(apiErrorMessage('text')).toBeUndefined();
  });
});
