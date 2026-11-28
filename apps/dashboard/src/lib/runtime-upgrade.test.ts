import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { guardFrameworkUpgradeListener, parseRequestTarget, rejectUpgrade } from '../../runtime-upgrade.mjs';

function fakeSocket() {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    write: vi.fn(),
    destroy: vi.fn(function destroy(this: { destroyed: boolean }) { this.destroyed = true; }),
    end: vi.fn(function end(this: { writableEnded: boolean }) { this.writableEnded = true; }),
  });
}

const request = (url: string, host = 'magnus.example.com') => ({ url, headers: { host } });
const ownedByHermes = (target: URL) => target.pathname.startsWith('/api/hermes/dashboard/');

describe('console upgrade request targets', () => {
  it('parses the target without the Host header, so a malformed Host cannot throw', () => {
    expect(parseRequestTarget(request('/api/hermes/dashboard/ws?nodeId=node-1', '[malformed'))?.pathname)
      .toBe('/api/hermes/dashboard/ws');
    expect(parseRequestTarget({ headers: {} })?.pathname).toBe('/');
    expect(parseRequestTarget(request('http://[bad/x'))).toBeNull();
  });

  it('answers with a bodiless status and closes the socket', () => {
    const socket = fakeSocket();
    rejectUpgrade(socket, 404, { 'X-Correlation-Id': 'fixture' });
    expect(socket.write).toHaveBeenCalledWith(
      'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\nX-Correlation-Id: fixture\r\n\r\n',
    );
    expect(socket.destroy).toHaveBeenCalled();
  });
});

describe('framework upgrade listener guard', () => {
  it('closes an upgrade the framework leaves unclaimed', async () => {
    const socket = fakeSocket();
    const listener = vi.fn(async () => {});
    await guardFrameworkUpgradeListener(listener, ownedByHermes)(request('/unrelated'), socket, Buffer.alloc(0));
    expect(listener).toHaveBeenCalledOnce();
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('404 Not Found'));
    expect(socket.destroy).toHaveBeenCalled();
  });

  it('leaves a socket the framework ended alone', async () => {
    const socket = fakeSocket();
    await guardFrameworkUpgradeListener(async (_req: unknown, s: ReturnType<typeof fakeSocket>) => { s.end(); }, ownedByHermes)(
      request('/login'), socket, Buffer.alloc(0),
    );
    expect(socket.write).not.toHaveBeenCalled();
  });

  it('closes the socket without an unhandled rejection when the framework listener throws', async () => {
    const socket = fakeSocket();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(guardFrameworkUpgradeListener(async () => { throw new Error('boom'); }, ownedByHermes)(
      request('/unrelated'), socket, Buffer.alloc(0),
    )).resolves.toBeUndefined();
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('404 Not Found'));
    error.mockRestore();
  });

  it('keeps the framework away from Hermes upgrades and unparsable targets', async () => {
    const listener = vi.fn();
    const guarded = guardFrameworkUpgradeListener(listener, ownedByHermes);
    for (const url of ['/api/hermes/dashboard/ws', 'http://[bad/x']) {
      const socket = fakeSocket();
      await guarded(request(url), socket, Buffer.alloc(0));
      expect(socket.write).not.toHaveBeenCalled();
    }
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('console upgrade contract', () => {
  it('never routes an upgrade by the Host header', () => {
    const source = readFileSync(new URL('../../server-tls.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/new URL\(\s*req\.url/);
    expect(source).toContain('guardFrameworkUpgradeListener(listener, isHermesUpgradeTarget)');
  });

  it('configures no external rewrite, the only way Next.js keeps an upgrade socket open in production', () => {
    const config = readFileSync(new URL('../../next.config.ts', import.meta.url), 'utf8');
    // No rewrites at all since the embedded dashboards moved onto frame URLs; never an external one.
    expect(config).not.toMatch(/destination:\s*['"`](?:[a-z][a-z0-9+.-]*:)?\/\//i);
  });
});
