import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ardentInstanceRef, ardentMediaType, ardentTraceHeaders, createArdentRoutes, readArdentState, writeProfileEnv } from './ardent-manager.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Seen = { url: string; method: string; body: string; headers: IncomingMessage['headers'] };
type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;

const taskId = '00000000-0000-4000-8000-0000000000aa';
const sha = 'e'.repeat(64);
const execution = { v: 1, root: 'hx1:studio:inst-1:request:req-1', self: 'hx1:studio:inst-1:step:req-1/2', attempt: 1, deadline_ms: 4_102_444_800_000 };
const status320 = { version: '3.2.0', profile: 'current', backend: 'llamacpp', tasks: 0, channels: { mattermost: { catchup: [] } },
  capabilities: { artifact_transfer: 2 }, recovery: { ready: 0, reconciling: 0, awaiting_decision: 1, unsupported: 0 } };
const status314 = { version: '3.1.4', profile: 'legacy', backend: 'llamacpp', tasks: 0 };

/** A node with one Ardent profile per entry, each a loopback fixture with its own status and handler. */
async function fixtureNode(profiles: Record<string, { status: unknown; handler?: Handler }>, installedVersion = '3.2.0') {
  const home = await mkdtemp(join(tmpdir(), 'magnus-ardent-runtime-'));
  dirs.push(home);
  const root = join(home, '.ardent');
  const install = join(home, '.local/share/ardent');
  await mkdir(join(install, 'node_modules/@hivemagnus/ardent'), { recursive: true });
  await writeFile(join(install, 'node_modules/@hivemagnus/ardent/package.json'), JSON.stringify({ name: '@hivemagnus/ardent', version: installedVersion }));
  const seen: Record<string, Seen[]> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    const requests: Seen[] = seen[name] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        requests.push({ url: request.url ?? '', method: request.method ?? '', body, headers: request.headers });
        if (request.headers.authorization !== 'Bearer private-fixture-token') { response.writeHead(401).end('{}'); return; }
        if (request.url === '/api/v1/profile') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ profile: name, product: 'Ardent' })); return; }
        if (request.url === '/api/v1/status') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(profile.status)); return; }
        if (profile.handler) profile.handler(request, response, body);
        else response.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
      });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture listener absent');
    const dir = join(root, 'profiles', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.yaml'), `schema_version: 1\nprofile: ${name}\nname: ${name}\nexecution:\n  backend: llamacpp\napi:\n  host: 127.0.0.1\n  port: ${address.port}\n  token_env: ARDENT_API_TOKEN\na2a:\n  enabled: false\n`);
    await writeFile(join(dir, '.env'), 'ARDENT_API_TOKEN=private-fixture-token\n', { mode: 0o600 });
  }
  const target = { owner: 'fixture', home, root, install };
  const after = (name: string) => seen[name]!.filter(item => item.url !== '/api/v1/profile');
  return { routes: createArdentRoutes(async () => target), target, seen, after };
}
const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('Ardent 3.2.0 runtime contracts through the node agent', () => {
  it('reports each profile\'s version and capabilities, from its status or else the installed package', async () => {
    const { target } = await fixtureNode({ current: { status: status320 }, legacy: { status: status314 } });
    const state = await readArdentState(target) as { capabilities: unknown; profiles: Array<{ id: string; version: string; capabilities: unknown }> };
    expect(state.capabilities).toEqual({ studio: 6, recovery: 1, lineage: 1, artifact_transfer: 2, task_filters: 1 });
    expect(state.profiles.map(profile => [profile.id, profile.version, profile.capabilities])).toEqual([
      ['current', '3.2.0', { recovery: 1, lineage: 1, artifact_transfer: 2 }],
      ['legacy', '3.1.4', { recovery: 0, lineage: 0, artifact_transfer: 1 }],
    ]);
  });

  it('reads recovery, lineage, renditions, manifest v2 and imports and passes the caller\'s trace on', async () => {
    const json = (response: ServerResponse, value: unknown, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    const { routes, after } = await fixtureNode({ current: { status: status320, handler: (request, response) => {
      if (request.url === `/api/v1/tasks/${taskId}/recovery`) json(response, { status: 'awaiting_decision', reason: { code: 'UNSETTLED_EXTERNAL_WRITE', message: 'x' }, attempt: 1, actions: ['abandon'] });
      else if (request.url === `/api/v1/tasks/${taskId}/lineage`) json(response, { task: taskId, ancestors: [] });
      else if (request.url === `/api/v1/artifacts/${sha}/renditions`) json(response, { renditions: [] });
      else if (request.url === `/api/v1/artifacts/${sha}/manifest/v2`) json(response, { manifest: { sha256: sha, version: '1.1' } });
      else if (request.url === '/api/v1/artifacts/imports?limit=5') json(response, { imports: [] });
      else if (request.url === `/api/v1/artifacts/imports/${'a'.repeat(32)}`) json(response, { import_id: 'a'.repeat(32) });
      else json(response, {}, 404);
    } } });
    const trace = { 'x-request-id': 'req-123', traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`, 'x-hive-execution': 'eyJ2IjoxfQ' };
    for (const path of [`tasks/${taskId}/recovery`, `tasks/${taskId}/lineage`, `artifacts/${sha}/renditions`, `artifacts/${sha}/manifest/v2`,
      'artifacts/imports?limit=5', `artifacts/imports/${'a'.repeat(32)}`]) {
      const response = await routes.request(`/profiles/current/api/${path}`, { headers: trace });
      expect(response.status, path).toBe(200);
    }
    expect((await routes.request(`/profiles/current/api/artifacts/imports/${'A'.repeat(32)}`)).status).toBe(404);
    expect((await routes.request(`/profiles/current/api/tasks/${taskId}/recovery/extra`)).status).toBe(404);
    const reads = after('current').filter(item => item.url !== '/api/v1/status');
    expect(reads.map(item => item.url)).toEqual([`/api/v1/tasks/${taskId}/recovery`, `/api/v1/tasks/${taskId}/lineage`, `/api/v1/artifacts/${sha}/renditions`,
      `/api/v1/artifacts/${sha}/manifest/v2`, '/api/v1/artifacts/imports?limit=5', `/api/v1/artifacts/imports/${'a'.repeat(32)}`]);
    for (const item of reads) expect(item.headers).toMatchObject(trace);
    // A trace header of the wrong shape is dropped, not refused.
    await routes.request(`/profiles/current/api/tasks/${taskId}/lineage`, { headers: { 'x-request-id': 'bad id\u0007', traceparent: 'nope' } });
    expect(after('current').at(-1)!.headers['x-request-id']).toBeUndefined();
    expect(after('current').at(-1)!.headers['traceparent']).toBeUndefined();
  });

  it('relays v2 content with Range, 206, the media type, filename and digest headers, without buffering it', async () => {
    const bytes = Buffer.from('0123456789abcdef');
    const digest = Buffer.alloc(32, 9).toString('base64');
    const headers = { 'Accept-Ranges': 'bytes', ETag: `"${sha}"`, 'Repr-Digest': `sha-256=:${digest}:`, 'X-Content-SHA256': sha,
      'Content-Disposition': 'attachment; filename="report.pdf"' };
    const { routes, after } = await fixtureNode({ current: { status: status320, handler: (request, response) => {
      if (request.url !== `/api/v1/artifacts/${sha}/content`) { response.writeHead(404).end('{}'); return; }
      const range = /^bytes=(\d+)-(\d*)$/.exec(String(request.headers.range ?? ''));
      if (range && Number(range[1]) >= bytes.length) { response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}`, 'Content-Type': 'application/json' }).end('{"error":"range"}'); return; }
      if (range && request.headers['if-range'] === `"${sha}"`) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : bytes.length - 1;
        response.writeHead(206, { ...headers, 'Content-Type': 'application/pdf', 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1) });
        response.end(bytes.subarray(start, end + 1));
        return;
      }
      response.writeHead(200, { ...headers, 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.length) }).end(bytes);
    } } });
    const partial = await routes.request(`/profiles/current/api/artifacts/${sha}/content`, { headers: { Range: 'bytes=4-', 'If-Range': `"${sha}"` } });
    expect(partial.status).toBe(206);
    expect(Object.fromEntries(['content-type', 'content-range', 'content-length', 'accept-ranges', 'etag', 'repr-digest', 'x-content-sha256', 'content-disposition', 'x-content-type-options']
      .map(name => [name, partial.headers.get(name)]))).toEqual({
      'content-type': 'application/pdf', 'content-range': `bytes 4-15/${bytes.length}`, 'content-length': '12', 'accept-ranges': 'bytes', etag: `"${sha}"`,
      'repr-digest': `sha-256=:${digest}:`, 'x-content-sha256': sha, 'content-disposition': 'attachment; filename="report.pdf"', 'x-content-type-options': 'nosniff',
    });
    expect(Buffer.from(await partial.arrayBuffer()).toString()).toBe('456789abcdef');
    expect(after('current').at(-1)!.headers).toMatchObject({ range: 'bytes=4-', 'if-range': `"${sha}"` });
    const whole = await routes.request(`/profiles/current/api/artifacts/${sha}/content`);
    expect(whole.status).toBe(200);
    expect(Buffer.from(await whole.arrayBuffer())).toEqual(bytes);
    const unsatisfiable = await routes.request(`/profiles/current/api/artifacts/${sha}/content`, { headers: { Range: 'bytes=99-' } });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-range')).toBe(`bytes */${bytes.length}`);
    for (const bad of [{ Range: 'bytes=0-1,4-5' }, { Range: 'items=0-1' }, { Range: 'bytes=0-', 'If-Range': 'W/"x"' }])
      expect((await routes.request(`/profiles/current/api/artifacts/${sha}/content`, { headers: bad })).status).toBe(400);
    // The cap applies to the whole artifact, so ranges cannot fetch a larger one piece by piece.
    process.env['MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES'] = '8';
    try {
      expect((await routes.request(`/profiles/current/api/artifacts/${sha}/content`, { headers: { Range: 'bytes=0-3', 'If-Range': `"${sha}"` } })).status).toBe(502);
    } finally { delete process.env['MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES']; }
  });

  it('runs task-recovery and artifact-import, and passes a valid execution context in the body and header', async () => {
    const { routes, after } = await fixtureNode({ current: { status: status320, handler: (request, response, body) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === `/api/v1/tasks/${taskId}/recovery`) response.end(JSON.stringify({ status: 'resolved', reason: { code: 'X', message: 'y' }, attempt: 1, actions: [], continuation_task_id: taskId }));
      else if (request.url === '/api/v1/artifacts/imports') response.writeHead(202).end(JSON.stringify({ import_id: 'b'.repeat(32) }));
      else if (request.url === '/api/v1/tasks') response.writeHead(202).end(JSON.stringify({ task_id: taskId, state: 'queued', echoed: JSON.parse(body) as unknown }));
      else response.writeHead(404).end('{}');
    } } });
    const decided = await routes.request('/action', post({ profile: 'current', action: 'task-recovery', target: taskId, body: { action: 'mark_not_applied', call_id: 'call-1', note: 'checked' } }));
    expect(decided.status).toBe(200);
    expect(await decided.json()).toMatchObject({ status: 'resolved' });
    const imported = await routes.request('/action', post({ profile: 'current', action: 'artifact-import', body: { peer_id: 'peer-1', a2a_task_id: 'remote-task', artifact_id: 'c'.repeat(32) } }));
    // Ardent admits the import with 202; the agent settles the admission as 200.
    expect(imported.status).toBe(200);
    expect(await imported.json()).toEqual({ import_id: 'b'.repeat(32) });
    for (const bad of [
      { action: 'task-recovery', target: taskId, body: { action: 'retry_now' } },
      { action: 'task-recovery', body: { action: 'abandon' } },
      { action: 'task-recovery', target: taskId, body: { action: 'abandon', deadline_seconds: 0 } },
      { action: 'task-recovery', target: taskId, body: { action: 'mark_applied', result: 'x'.repeat(70_000) } },
      { action: 'artifact-import', body: { peer_id: 'peer 1', a2a_task_id: 'remote-task', artifact_id: 'c'.repeat(32) } },
      { action: 'artifact-import', body: { peer_id: 'peer-1', a2a_task_id: 'remote-task', artifact_id: 'c'.repeat(32), url: 'https://example.com' } },
    ]) expect((await routes.request('/action', post({ profile: 'current', ...bad }))).status, JSON.stringify(bad)).toBe(400);

    const task = { prompt: 'Test', idempotency_key: '00000000-0000-4000-8000-000000000002' };
    const trace = { request_id: 'req-456', traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01` };
    const submitted = await routes.request('/action', post({ profile: 'current', action: 'task-submit', body: task, execution: { ...execution, extra: 'dropped' }, trace }));
    expect(submitted.status).toBe(200);
    const sent = after('current').filter(item => item.url === '/api/v1/tasks').at(-1)!;
    expect(JSON.parse(sent.body)).toEqual({ ...task, execution });
    expect(JSON.parse(Buffer.from(String(sent.headers['x-hive-execution']), 'base64url').toString('utf8'))).toEqual(execution);
    expect(sent.headers).toMatchObject({ 'x-request-id': 'req-456', traceparent: trace.traceparent });
    // An invalid context is dropped and the task still runs, as if none was sent.
    const dropped = await routes.request('/action', post({ profile: 'current', action: 'task-submit', body: task, execution: { v: 2, root: 'nope' }, trace: { request_id: 'bad id' } }));
    expect(dropped.status).toBe(200);
    const plain = after('current').filter(item => item.url === '/api/v1/tasks').at(-1)!;
    expect(JSON.parse(plain.body)).toEqual(task);
    expect(plain.headers['x-hive-execution']).toBeUndefined();
    expect(plain.headers['x-request-id']).toBeUndefined();
    // Other actions never carry a context into Ardent's body.
    await routes.request('/action', post({ profile: 'current', action: 'task-recovery', target: taskId, body: { action: 'abandon' }, execution }));
    expect(JSON.parse(after('current').filter(item => item.url === `/api/v1/tasks/${taskId}/recovery`).at(-1)!.body)).toEqual({ action: 'abandon' });
  });

  it('keeps an older profile\'s task-submit working and leaves its new reads to Ardent', async () => {
    const { routes, after } = await fixtureNode({ legacy: { status: status314, handler: (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/v1/tasks') response.writeHead(202).end(JSON.stringify({ task_id: taskId, state: 'queued' }));
      else if (request.url === `/api/v1/tasks/${taskId}/cancel`) response.end(JSON.stringify({ id: taskId, state: 'cancelled' }));
      else response.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
    } } }, '3.1.4');
    expect((await routes.request('/action', post({ profile: 'legacy', action: 'task-submit', body: { prompt: 'Test', idempotency_key: '00000000-0000-4000-8000-000000000003' } }))).status).toBe(200);
    expect((await routes.request('/action', post({ profile: 'legacy', action: 'task-cancel', target: taskId }))).status).toBe(200);
    expect((await routes.request(`/profiles/legacy/api/tasks/${taskId}/recovery`)).status).toBe(404);
    expect(after('legacy').map(item => item.url)).toEqual(['/api/v1/tasks', `/api/v1/tasks/${taskId}/cancel`, `/api/v1/tasks/${taskId}/recovery`]);
  });

  it('writes ARDENT_INSTANCE_REF only as <node>.<profile> in a value Ardent accepts, keeping the other lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'magnus-ardent-instance-'));
    dirs.push(dir);
    await writeFile(join(dir, '.env'), 'ARDENT_API_TOKEN=private-fixture-token\nARDENT_INSTANCE_REF=old.value\n', { mode: 0o600 });
    expect(await writeProfileEnv(dir, 'ARDENT_INSTANCE_REF', 'node-1.example')).toBe(true);
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe('ARDENT_API_TOKEN=private-fixture-token\nARDENT_INSTANCE_REF=node-1.example\n');
    expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600);
    expect(await writeProfileEnv(dir, 'ARDENT_INSTANCE_REF', 'node-1.example')).toBe(false);
    for (const bad of ['node 1.example', 'node:1.example', 'x'.repeat(97), 'a.b\nINJECTED=1'])
      await expect(writeProfileEnv(dir, 'ARDENT_INSTANCE_REF', bad)).rejects.toThrow();
    expect(ardentInstanceRef('cm0node0000000000000000001', 'example')).toBe('cm0node0000000000000000001.example');
    expect(ardentInstanceRef('n'.repeat(60), 'p'.repeat(40))).toBeNull();
    expect(ardentInstanceRef('', 'example')).toBeNull();
  });

  it('accepts the instance reference action only as root and package-install only with a node ID body', async () => {
    const { routes } = await fixtureNode({ current: { status: status320 } });
    const set = await routes.request('/action', post({ profile: 'current', action: 'instance-ref-set', body: { instance_ref: 'node-1.current' } }));
    if (process.getuid?.() !== 0) {
      expect(set.status).toBe(422);
      expect(await set.json()).toMatchObject({ error: { message: 'Ardent profile environment management requires a root node manager' } });
    }
    expect((await routes.request('/action', post({ profile: 'current', action: 'package-install', body: { node_id: 'node 1' } }))).status).toBe(400);
    expect((await routes.request('/action', post({ profile: 'current', action: 'package-install', body: { version: '9.9.9' } }))).status).toBe(400);
  });

  it('relays only well-formed media types and attribution headers', () => {
    expect(ardentMediaType('image/png')).toBe('image/png');
    expect(ardentMediaType('text/markdown; charset=utf-8')).toBe('text/markdown; charset=utf-8');
    for (const bad of [null, '', 'text/html\r\nSet-Cookie: x=1', 'not a type', `application/${'x'.repeat(300)}`]) expect(ardentMediaType(bad)).toBe('application/octet-stream');
    expect(ardentTraceHeaders(name => ({ 'x-request-id': 'r-1', traceparent: 'bad', 'x-hive-execution': 'abc_-' } as Record<string, string>)[name])).toEqual({ 'x-request-id': 'r-1', 'x-hive-execution': 'abc_-' });
  });
});
