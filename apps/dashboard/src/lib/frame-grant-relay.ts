/**
 * Console side of the frame grant renewal (`FRAME_COMPAT_SCRIPT` in `runtime-embed-isolation.mjs`
 * is the page side). Frame grants live minutes; before one expires, the sandboxed page asks its
 * parent, the console frame, for a new one by posting the grant it holds. The console, which has
 * the session cookie, mints a new grant from the entry URL and posts it back.
 *
 * A request that arrives while one is in flight is dropped; the page asks again (the
 * compatibility script every 15 seconds, the reconnect page every 3).
 *
 * Only the console's own iframe may ask, only while it shows a sandboxed (opaque-origin) page,
 * and only with a grant of the same console session, dashboard and installation as the one the
 * console last issued: a foreign page navigated into the frame gets nothing.
 *
 * Self-contained (no imports, no outer variables), so the browser test can run this exact code.
 */
export function installFrameGrantRelay(frame: HTMLIFrameElement, mintUrl: string, initialGrant: string): () => void {
  const scope = (grant: string): string | null => {
    try {
      const part = grant.split('.')[1] ?? '';
      const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
      return typeof claims['sid'] === 'string' ? JSON.stringify([claims['app'], claims['sid'], claims['ins'] ?? null]) : null;
    } catch {
      return null;
    }
  };
  let current = initialGrant;
  let busy = false;
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow || event.origin !== 'null' || busy) return;
    const data = event.data as { type?: unknown; grant?: unknown } | null;
    if (!data || data.type !== 'magnus-frame-refresh' || typeof data.grant !== 'string') return;
    const expected = scope(current);
    if (!expected || scope(data.grant) !== expected) return;
    const source = event.source as Window;
    busy = true;
    void fetch(mintUrl, { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => {
        // A definite refusal (signed out, installation gone): tell the page to stop asking.
        // Anything else (network, 5xx) stays silent; the page asks again.
        if (response.status >= 400 && response.status < 500) {
          source.postMessage({ type: 'magnus-frame-refused' }, '*');
          return null;
        }
        return response.ok ? response.json() : null;
      })
      .then((body: { grant?: unknown } | null) => {
        if (!body || typeof body.grant !== 'string') return;
        current = body.grant;
        source.postMessage({ type: 'magnus-frame-grant', grant: current }, '*');
      })
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

/** The entry URL that answers with a new grant as JSON (`?mint=json`). */
export function frameMintUrl(entryUrl: string): string {
  return `${entryUrl}${entryUrl.includes('?') ? '&' : '?'}mint=json`;
}
