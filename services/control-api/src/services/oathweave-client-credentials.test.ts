import { describe, expect, it, vi } from 'vitest';
import { OathweaveClientToken, OathweaveClientTokenError } from './oathweave-client-credentials.js';

const credentials = { tokenUrl: 'https://identity.example.com/api/v1/oauth/token', clientId: 'fixture-client', clientSecret: 'fixture-client-secret', scope: 'hivemem:memories:read' };
const jwt = (exp: number, n = 1) => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp, n })).toString('base64url')}.fixture-signature`;

describe('Oathweave client credentials token', () => {
  it('fetches once, reuses the token while fresh and refreshes it before it expires', async () => {
    let now = 1_800_000_000_000;
    let issued = 0;
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ grant_type: 'client_credentials', client_id: 'fixture-client',
        client_secret: 'fixture-client-secret', scope: 'hivemem:memories:read' });
      issued++;
      return Response.json({ access_token: jwt(Math.floor(now / 1000) + 300, issued), expires_in: 300 });
    });
    const provider = new OathweaveClientToken(credentials, () => now);
    const [a, b] = await Promise.all([provider.token(fetcher as unknown as typeof fetch), provider.token(fetcher as unknown as typeof fetch)]);
    expect(a).toBe(b);
    expect(issued).toBe(1);
    now += 200_000;
    expect(await provider.token(fetcher as unknown as typeof fetch)).toBe(a);
    // Past the refresh point the current token is returned while a new one is fetched.
    now += 50_000;
    expect(await provider.token(fetcher as unknown as typeof fetch)).toBe(a);
    await vi.waitFor(async () => expect(await provider.token(fetcher as unknown as typeof fetch)).not.toBe(a));
    expect(issued).toBe(2);
    provider.invalidate();
    await provider.token(fetcher as unknown as typeof fetch);
    expect(issued).toBe(3);
  });

  it('reports a refusal or malformed answer by status only, without the response body', async () => {
    const provider = new OathweaveClientToken(credentials);
    const refused = vi.fn(async () => new Response('invalid_client fixture-client-secret', { status: 401 }));
    const error = await provider.token(refused as unknown as typeof fetch).catch((caught: unknown) => caught) as OathweaveClientTokenError;
    expect(error).toBeInstanceOf(OathweaveClientTokenError);
    expect(error.status).toBe(401);
    expect(error.message).not.toContain('fixture-client-secret');
    await expect(provider.token(vi.fn(async () => Response.json({ access_token: 'not-a-jwt' })) as unknown as typeof fetch)).rejects.toThrow(/no usable/);
    await expect(provider.token(vi.fn(async () => Response.json({ access_token: jwt(1) })) as unknown as typeof fetch)).rejects.toThrow(/expired/);
    await expect(provider.token(vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch)).rejects.toThrow(/TypeError/);
  });
});
