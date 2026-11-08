/**
 * Magnus's own service identity at another product: short-lived Oathweave
 * client_credentials tokens. A token is fetched on first use, reused while it is
 * fresh and replaced before it expires, so nothing renews it by hand. Oathweave
 * binds a machine client to one audience, so each resource has its own client.
 * The secret and the tokens stay in memory and are never logged.
 */
import { z } from 'zod';

export interface OathweaveClientCredentials {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Space-separated permissions to request. Oathweave issues none that are not asked for. */
  scope: string;
}

export class OathweaveClientTokenError extends Error {
  constructor(message: string, readonly status: number | null = null) { super(message); this.name = 'OathweaveClientTokenError'; }
}

const tokenResponse = z.object({ access_token: z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/), expires_in: z.number().positive().optional() });
const MIN_LIFETIME_MS = 10_000;
const MAX_LIFETIME_MS = 3_600_000;
const EXPIRY_MARGIN_MS = 5_000;

function unverifiedExpiry(token: string): number | undefined {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : undefined;
  } catch { return undefined; }
}

export class OathweaveClientToken {
  private cached: { token: string; refreshAt: number; expiresAt: number } | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(private readonly credentials: OathweaveClientCredentials, private readonly now: () => number = Date.now) {}

  /** A token valid for at least a few more seconds. Concurrent callers share one request. */
  async token(fetcher: typeof fetch = fetch): Promise<string> {
    const at = this.now();
    const usable = this.cached && this.cached.expiresAt - EXPIRY_MARGIN_MS > at ? this.cached : undefined;
    if (usable && usable.refreshAt > at) return usable.token;
    this.inFlight ??= this.request(fetcher).finally(() => { this.inFlight = undefined; });
    if (!usable) return this.inFlight;
    // Refresh early in the background; the current token is still good.
    this.inFlight.catch(() => undefined);
    return usable.token;
  }

  /** Forget the cached token, for example after the resource answered 401. */
  invalidate(): void { this.cached = undefined; }

  private async request(fetcher: typeof fetch): Promise<string> {
    const startedAt = this.now();
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret, scope: this.credentials.scope });
    let response: Response;
    try {
      response = await fetcher(this.credentials.tokenUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString() });
    } catch (error: unknown) {
      throw new OathweaveClientTokenError(`Oathweave token request failed (${error instanceof Error ? error.name : 'error'})`);
    }
    // The body is never included: an error page may echo the request.
    if (!response.ok) throw new OathweaveClientTokenError(`Oathweave refused the client credentials (HTTP ${response.status})`, response.status);
    const parsed = tokenResponse.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new OathweaveClientTokenError('Oathweave returned no usable access token');
    const lifetime = Math.min(MAX_LIFETIME_MS, Math.max(MIN_LIFETIME_MS, (parsed.data.expires_in ?? 300) * 1000));
    const expiresAt = Math.min(startedAt + lifetime, unverifiedExpiry(parsed.data.access_token) ?? Number.POSITIVE_INFINITY);
    if (expiresAt - EXPIRY_MARGIN_MS <= this.now()) throw new OathweaveClientTokenError('Oathweave issued an expired token');
    const span = expiresAt - startedAt;
    this.cached = { token: parsed.data.access_token, expiresAt, refreshAt: startedAt + Math.max(0, Math.min(span * 0.8, span - 30_000)) };
    return parsed.data.access_token;
  }
}
