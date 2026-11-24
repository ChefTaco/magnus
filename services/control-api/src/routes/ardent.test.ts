import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppVariables, AuthTokenPayload } from '../types/index.js';

const mocks = vi.hoisted(() => ({ stream: vi.fn(), studio: vi.fn(), action: vi.fn(), audit: vi.fn(), read: vi.fn(), block: vi.fn(), reconcile: vi.fn(),
  capability: vi.fn(), studioAt: vi.fn(), execution: vi.fn() }));
vi.mock('../services/ardent-command-owner.js', () => ({ ardentOwnerBlock: mocks.block, reconcileArdentCommandOwner: mocks.reconcile }));
vi.mock('../services/ardent-service.js', () => ({
  streamArdentProfileResource: mocks.stream, requireArdentStudioAgent: mocks.studio, performArdentAction: mocks.action,
  getArdentContextAdoption: vi.fn(), getArdentContextRelease: vi.fn(), getArdentInstallation: vi.fn(),
  getArdentProfileResource: mocks.read, listArdentInstallations: vi.fn(), getArdentSkillReceipts: vi.fn(),
  requireArdentProfileCapability: mocks.capability, ardentStudioAgentAt: mocks.studioAt, ardentAcceptsExecution: mocks.execution,
}));
vi.mock('../services/audit-service.js', () => ({ logAuditEvent: mocks.audit }));
vi.mock('../middleware/auth.js', async (original) => ({
  ...await original<typeof import('../middleware/auth.js')>(),
  // A test identity from a header stands in for token verification.
  authMiddleware: async (c: import('hono').Context<AppVariables>, next: () => Promise<void>) => {
    const role = c.req.header('x-test-role');
    if (!role) return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    c.set('user', { userId: 'alice', email: 'alice', role, iat: 0, exp: 0 } as AuthTokenPayload);
    await next();
  },
}));
const { ardentRouter } = await import('./ardent.js');
const { errorHandler } = await import('../middleware/error-handler.js');
const app = new Hono<AppVariables>().route('/ardent', ardentRouter);
app.onError(errorHandler);

const taskId = '00000000-0000-4000-8000-0000000000aa';
const streamPath = `/ardent/installations/node-1/profiles/example/tasks/${taskId}/stream`;
const artifactPath = `/ardent/installations/node-1/profiles/example/artifacts/${'a'.repeat(64)}`;
const encoder = new TextEncoder();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.studio.mockResolvedValue(undefined);
  mocks.block.mockResolvedValue(undefined);
});

describe('Ardent task stream relay', () => {
  it('passes each event through before the node stream ends', async () => {
    let push!: (text: string) => void;
    let end!: () => void;
    const upstream = new ReadableStream<Uint8Array>({ start(controller) {
      push = text => controller.enqueue(encoder.encode(text));
      end = () => controller.close();
    } });
    mocks.stream.mockResolvedValue(new Response(upstream, { headers: { 'Content-Type': 'text/event-stream' } }));
    const response = await app.request(`${streamPath}?after=4`, { headers: { 'x-test-role': 'ADMIN', 'Last-Event-ID': '5' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(mocks.stream).toHaveBeenCalledWith('node-1', 'example', `tasks/${taskId}/stream`, expect.objectContaining({ after: '4', lastEventId: '5' }));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    push('event: task.delta\ndata: {"step":1,"text":"Hel"}\n\n');
    const started = Date.now();
    expect(decoder.decode((await reader.read()).value)).toContain('"Hel"');
    push('event: task.delta\ndata: {"step":1,"text":"lo"}\n\n');
    expect(decoder.decode((await reader.read()).value)).toContain('"lo"');
    // Both chunks arrived while the node stream was still open.
    expect(Date.now() - started).toBeLessThan(1000);
    end();
    expect((await reader.read()).done).toBe(true);
  });

  it('treats an empty Last-Event-ID as no cursor, and still refuses a malformed one', async () => {
    // A console ingress forwards Last-Event-ID unconditionally, so a first connection arrives with an empty one.
    mocks.stream.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const fresh = await app.request(streamPath, { headers: { 'x-test-role': 'ADMIN', 'Last-Event-ID': '' } });
    expect(fresh.status).toBe(200);
    expect(mocks.stream).toHaveBeenCalledWith('node-1', 'example', `tasks/${taskId}/stream`, expect.not.objectContaining({ lastEventId: expect.anything() }));
    await fresh.body?.cancel();
    const bad = await app.request(streamPath, { headers: { 'x-test-role': 'ADMIN', 'Last-Event-ID': 'abc' } });
    expect(bad.status).toBe(400);
  });

  it('cancels the node stream when the client goes away', async () => {
    const cancelled = vi.fn();
    mocks.stream.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const response = await app.request(streamPath, { headers: { 'x-test-role': 'ADMIN' } });
    await response.body!.cancel();
    expect(cancelled).toHaveBeenCalled();
  });

  it('maps node failures and refuses an agent without the bridge', async () => {
    mocks.stream.mockResolvedValue(new Response('{"error":{"code":"NOT_FOUND"}}', { status: 404, headers: { 'Content-Type': 'application/json' } }));
    expect((await app.request(streamPath, { headers: { 'x-test-role': 'ADMIN' } })).status).toBe(404);
    mocks.stream.mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    expect((await app.request(streamPath, { headers: { 'x-test-role': 'ADMIN' } })).status).toBe(503);
    expect((await app.request(`${streamPath}?after=x`, { headers: { 'x-test-role': 'ADMIN' } })).status).toBe(400);
    const { HttpError } = await import('../middleware/error-handler.js');
    mocks.studio.mockRejectedValue(new HttpError(409, 'AGENT_UPGRADE_REQUIRED', 'Upgrade the Magnus agent on node-1'));
    const old = await app.request(streamPath, { headers: { 'x-test-role': 'ADMIN' } });
    expect(old.status).toBe(409);
    expect((await old.json()).error.code).toBe('AGENT_UPGRADE_REQUIRED');
  });
});

describe('Ardent artifact relay', () => {
  it('streams an artifact larger than 2 MiB without a server-side size limit', async () => {
    const size = 3 * 1024 * 1024;
    let sent = 0;
    mocks.stream.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (sent >= size) { controller.close(); return; }
      controller.enqueue(new Uint8Array(64 * 1024).fill(9));
      sent += 64 * 1024;
    } }), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) } }));
    const response = await app.request(artifactPath, { headers: { 'x-test-role': 'ADMIN' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-length')).toBe(String(size));
    expect(response.headers.get('content-disposition')).toContain(`ardent-${'a'.repeat(64)}.bin`);
    expect((await response.arrayBuffer()).byteLength).toBe(size);
    expect(mocks.studio).not.toHaveBeenCalled();
  });
});

describe('Ardent bridge access', () => {
  it.each([[streamPath, 'GET'], [artifactPath, 'GET'], ['/ardent/installations/node-1/profiles/example/action', 'POST']])('%s is ADMIN-only', async (path, method) => {
    const init = (role?: string) => ({ method, headers: { ...(role ? { 'x-test-role': role } : {}), 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ action: 'session-open', body: { key: 'k' } }) } : {}) });
    expect((await app.request(path, init())).status).toBe(401);
    for (const role of ['OPERATOR', 'VIEWER']) expect((await app.request(path, init(role))).status).toBe(403);
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it('opens a session only on an agent with the bridge, and audits it', async () => {
    mocks.action.mockResolvedValue({ id: taskId, key: 'k' });
    const response = await app.request('/ardent/installations/node-1/profiles/example/action', { method: 'POST',
      headers: { 'x-test-role': 'ADMIN', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'session-open', body: { key: 'k' } }) });
    expect(response.status).toBe(200);
    expect(mocks.studio).toHaveBeenCalledWith('node-1');
    expect(mocks.action).toHaveBeenCalledWith('node-1', 'example', 'session-open', undefined, { key: 'k' });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ardent.session-open', actorId: 'alice' }));
  });
});

describe('Ardent missions, pause, previews and development', () => {
  const actionPath = '/ardent/installations/node-1/profiles/example/action';
  const post = (body: unknown) => app.request(actionPath, { method: 'POST', headers: { 'x-test-role': 'ADMIN', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const mission = { id: 'p1:brief', revision: 1, parent_task: null, constraints: [], allowed_actions: ['analyze'], resources: ['project:p1'],
    deadline: 4_102_444_800, acceptance_criteria: ['A brief'], expected_artifacts: ['brief.md'] };
  const missionBody = { objective: 'Write the brief', mission, idempotency_key: 'p1:brief:1' };

  it('needs a level 2 agent for the new actions and for session contexts', async () => {
    mocks.action.mockResolvedValue({ task_id: taskId, state: 'queued' });
    expect((await post({ action: 'mission-submit', body: missionBody })).status).toBe(200);
    expect(mocks.studio).toHaveBeenLastCalledWith('node-1', 2);
    expect(mocks.action).toHaveBeenLastCalledWith('node-1', 'example', 'mission-submit', undefined, missionBody);
    for (const body of [{ action: 'task-pause', target: taskId }, { action: 'task-resume', target: taskId },
      { action: 'preview-submit', body: { prompt: 'Hi' } }, { action: 'development-note', body: { kind: 'note', title: 'T', body: 'B' } },
      { action: 'session-open', body: { key: 'k', context: 'mission' } }]) {
      mocks.studio.mockClear();
      expect((await post(body)).status, body.action).toBe(200);
      expect(mocks.studio, body.action).toHaveBeenCalledWith('node-1', 2);
    }
    // A plain session still needs only the first bridge level.
    mocks.studio.mockClear();
    await post({ action: 'session-open', body: { key: 'k' } });
    expect(mocks.studio).toHaveBeenCalledWith('node-1');
    const { HttpError } = await import('../middleware/error-handler.js');
    mocks.studio.mockRejectedValue(new HttpError(409, 'AGENT_UPGRADE_REQUIRED', 'Upgrade the Magnus agent on node-1'));
    const old = await post({ action: 'mission-submit', body: missionBody });
    expect(old.status).toBe(409);
    expect((await old.json()).error.code).toBe('AGENT_UPGRADE_REQUIRED');
  });

  it('checks bodies before anything reaches the node', async () => {
    for (const body of [{ action: 'mission-submit', body: { ...missionBody, mission: { ...mission, resources: [] } } },
      { action: 'mission-submit', body: { objective: 'x', mission } }, { action: 'preview-submit', body: { prompt: 'Hi', overrides: { tools: [] } } },
      { action: 'development-note', body: { kind: 'note', title: 'T', body: 'B', author: 'runtime' } }, { action: 'session-open', body: { key: 'k', context: 'peer' } },
      { action: 'task-pause' }, { action: 'task-resume', target: 'not-a-task' }, { action: 'task-pause', target: taskId, body: { force: true } }])
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.studio).not.toHaveBeenCalled();
  });

  it('passes on Ardent\'s refusals: a finished task cannot pause', async () => {
    const { AgentResponseError } = await import('../sdk/node-api-client.js');
    mocks.action.mockRejectedValue(new AgentResponseError(409, { code: 'CONFLICT', message: 'Task already finished' }));
    const finished = await post({ action: 'task-pause', target: taskId });
    expect(finished.status).toBe(409);
    expect((await finished.json()).error.code).toBe('CONFLICT');
    mocks.action.mockRejectedValue(new AgentResponseError(404, null));
    expect((await post({ action: 'task-resume', target: taskId })).status).toBe(404);
    mocks.action.mockRejectedValue(new AgentResponseError(400, null));
    expect((await post({ action: 'mission-submit', body: { ...missionBody, session_id: taskId } })).status).toBe(400);
    mocks.action.mockRejectedValue(new Error('connect ECONNREFUSED'));
    expect((await post({ action: 'task-pause', target: taskId })).status).toBe(503);
    // Each failure is audited with its outcome; none is recorded as done.
    expect(mocks.audit.mock.calls.map(([event]) => [event.action, event.details.outcome, event.details.code])).toEqual([
      ['ardent.task-pause', 'failed', 'CONFLICT'], ['ardent.task-resume', 'failed', 'NOT_FOUND'],
      ['ardent.mission-submit', 'failed', 'VALIDATION_ERROR'], ['ardent.task-pause', 'failed', 'DEPENDENCY_UNAVAILABLE']]);
  });

  it('reads artifact manifests and development history from a level 2 agent', async () => {
    mocks.read.mockResolvedValue({ records: [], next: null });
    const get = (resource: string) => app.request(`/ardent/installations/node-1/profiles/example/${resource}`, { headers: { 'x-test-role': 'ADMIN' } });
    expect((await get('development?after=eyJhIjoxfQ&limit=50&kind=skill_change')).status).toBe(200);
    expect(mocks.read).toHaveBeenLastCalledWith('node-1', 'example', 'development', { after: 'eyJhIjoxfQ', limit: '50', kind: 'skill_change' });
    expect(mocks.studio).toHaveBeenLastCalledWith('node-1', 2);
    for (const resource of [`tasks/${taskId}/artifacts`, `artifacts/${'a'.repeat(64)}/manifest`, 'sessions?context=preview']) {
      mocks.studio.mockClear();
      expect((await get(resource)).status, resource).toBe(200);
      expect(mocks.studio).toHaveBeenCalledWith('node-1', 2);
    }
    mocks.studio.mockClear();
    expect((await get('sessions')).status).toBe(200);
    expect(mocks.studio).not.toHaveBeenCalled();
    expect((await get('development?kind=Bad')).status).toBe(400);
    expect((await get('sessions?context=peer')).status).toBe(400);
    const { HTTPError } = await import('ky');
    mocks.read.mockRejectedValue(new HTTPError(new Response('{}', { status: 404 }), new Request('http://192.0.2.1/'), {} as never));
    expect((await get(`artifacts/${'b'.repeat(64)}/manifest`)).status).toBe(404);
  });
});

describe('Ardent command owners', () => {
  const actionPath = '/ardent/installations/node-1/profiles/example/action';
  const post = (body: unknown, role = 'ADMIN') => app.request(actionPath, { method: 'POST', headers: { 'x-test-role': role, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const decision = { disposition: 'no_effect_verified', reason: 'The unit never started; journal shows no start job.' };

  it('passes an ADMIN decision about an unknown outcome to the reconciliation, never to the node', async () => {
    mocks.reconcile.mockResolvedValue({ commandId: 'native-1', outcome: 'settled', receipt: 'unknown', settlement: 'signed-reconciliation:no_effect_verified', evidenceSha256: 'e'.repeat(64), decisionId: 'd-1' });
    const response = await post({ action: 'command-reconcile', target: 'native-1', body: decision });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ outcome: 'settled', decisionId: 'd-1' });
    expect(mocks.reconcile).toHaveBeenCalledWith('node-1', 'native-1', decision, { actorId: 'alice', details: {} });
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it('refuses a reconciliation without a command, a reason or an ADMIN', async () => {
    expect((await post({ action: 'command-reconcile', body: decision })).status).toBe(400);
    expect((await post({ action: 'command-reconcile', target: '../x', body: decision })).status).toBe(400);
    expect((await post({ action: 'command-reconcile', target: 'native-1', body: { disposition: 'no_effect_verified', reason: 'short' } })).status).toBe(400);
    expect((await post({ action: 'command-reconcile', target: 'native-1', body: { ...decision, disposition: 'released' } })).status).toBe(400);
    expect((await post({ action: 'command-reconcile', target: 'native-1', body: decision }, 'OPERATOR')).status).toBe(403);
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('answers an action whose outcome the node could not confirm with what to do, and audits it as unknown', async () => {
    const { HttpError } = await import('../middleware/error-handler.js');
    mocks.action.mockRejectedValue(new Error('Request failed with status code 409 Conflict'));
    mocks.block.mockResolvedValue(new HttpError(409, 'ARDENT_OUTCOME_UNKNOWN', 'The node could not confirm the outcome of service-start on example (command native-1).'));
    const response = await post({ action: 'service-start' });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toEqual({ code: 'ARDENT_OUTCOME_UNKNOWN', message: 'The node could not confirm the outcome of service-start on example (command native-1).' });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ardent.service-start', details: expect.objectContaining({ outcome: 'unknown', code: 'ARDENT_OUTCOME_UNKNOWN' }) }));
  });

  it('reports a settled failure with the node agent\'s reason', async () => {
    const { AgentResponseError } = await import('../sdk/node-api-client.js');
    mocks.action.mockRejectedValue(new AgentResponseError(422, { code: 'ARDENT_ACTION_FAILED', message: 'Ardent profile did not reach running state' }));
    const response = await post({ action: 'service-start' });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toEqual({ code: 'DEPENDENCY_UNAVAILABLE', message: 'Ardent action failed: Ardent profile did not reach running state' });
  });
});

describe('Ardent 3.2.0 runtime contracts', () => {
  const profilePath = '/ardent/installations/node-1/profiles/example';
  const sha = 'e'.repeat(64);
  const admin = { 'x-test-role': 'ADMIN' };
  const post = (body: unknown, headers: Record<string, string> = {}) => app.request(`${profilePath}/action`, { method: 'POST',
    headers: { ...admin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const execution = { v: 1, root: 'hx1:studio:inst-1:request:req-1', self: 'hx1:studio:inst-1:step:req-1/2', attempt: 1 };
  const task = { prompt: 'Test', idempotency_key: '00000000-0000-4000-8000-000000000002' };
  const unsupported = async () => {
    const { HttpError } = await import('../middleware/error-handler.js');
    return new HttpError(409, 'unsupported_capability', 'Ardent profile example runs 3.1.4; ardent.recovery.v1 needs Ardent 3.2.0 or later',
      { capability: 'ardent.recovery.v1', required_version: '3.2.0', installed_version: '3.1.4' });
  };
  beforeEach(() => {
    mocks.capability.mockResolvedValue(undefined);
    mocks.studioAt.mockResolvedValue(true);
    mocks.execution.mockResolvedValue(true);
    mocks.read.mockResolvedValue({ ok: true });
    mocks.action.mockResolvedValue({ task_id: taskId, state: 'queued' });
  });

  it('gates each new read on the profile capability it needs, and leaves the older reads alone', async () => {
    for (const [resource, gate] of [[`tasks/${taskId}/recovery`, 'recovery'], [`tasks/${taskId}/lineage`, 'lineage'], [`artifacts/${sha}/renditions`, 'artifact_transfer'],
      [`artifacts/${sha}/manifest/v2`, 'artifact_transfer'], ['artifacts/imports?limit=5', 'artifact_transfer'], [`artifacts/imports/${'a'.repeat(32)}`, 'artifact_transfer']] as const) {
      mocks.capability.mockClear();
      const answer = await app.request(`${profilePath}/${resource}`, { headers: admin });
      expect(answer.status, `${resource} ${await answer.clone().text()}`).toBe(200);
      expect(mocks.capability).toHaveBeenCalledWith('node-1', 'example', gate);
    }
    expect(mocks.read).toHaveBeenLastCalledWith('node-1', 'example', `artifacts/imports/${'a'.repeat(32)}`, {});
    mocks.capability.mockClear();
    for (const resource of [`tasks/${taskId}`, `tasks/${taskId}/artifacts`, `artifacts/${sha}/manifest`, 'status'])
      expect((await app.request(`${profilePath}/${resource}`, { headers: admin })).status, resource).toBe(200);
    expect(mocks.capability).not.toHaveBeenCalled();
    expect((await app.request(`${profilePath}/artifacts/imports/${'A'.repeat(32)}`, { headers: admin })).status).toBe(404);
  });

  it('answers an older profile with 409 unsupported_capability and its versions while cancel, pause and artifacts keep working', async () => {
    mocks.capability.mockRejectedValue(await unsupported());
    const refused = await app.request(`${profilePath}/tasks/${taskId}/recovery`, { headers: admin });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toEqual({ code: 'unsupported_capability', message: expect.stringContaining('3.1.4'),
      details: { capability: 'ardent.recovery.v1', required_version: '3.2.0', installed_version: '3.1.4' } });
    const decision = await post({ action: 'task-recovery', target: taskId, body: { action: 'abandon' } });
    expect(decision.status).toBe(409);
    expect((await decision.json()).error.details.installed_version).toBe('3.1.4');
    expect((await app.request(`${profilePath}/artifacts/${sha}/content`, { headers: admin })).status).toBe(409);
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
    mocks.action.mockResolvedValue({ id: taskId, state: 'cancelled' });
    expect((await post({ action: 'task-cancel', target: taskId })).status).toBe(200);
    expect((await post({ action: 'task-pause', target: taskId })).status).toBe(200);
    mocks.stream.mockResolvedValue(new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'application/octet-stream' } }));
    expect((await app.request(`${profilePath}/artifacts/${sha}`, { headers: admin })).status).toBe(200);
    mocks.read.mockResolvedValue({ artifacts: [] });
    expect((await app.request(`${profilePath}/tasks/${taskId}/artifacts`, { headers: admin })).status).toBe(200);
  });

  it('relays a ranged download with 206, the media type, the filename and the digest headers', async () => {
    const digest = Buffer.alloc(32, 9).toString('base64');
    mocks.stream.mockResolvedValue(new Response(new Uint8Array([4, 5, 6]), { status: 206, headers: {
      'Content-Type': 'application/pdf', 'Content-Length': '3', 'Content-Range': 'bytes 4-6/16', 'Accept-Ranges': 'bytes', ETag: `"${sha}"`,
      'Repr-Digest': `sha-256=:${digest}:`, 'X-Content-SHA256': sha, 'Content-Disposition': 'attachment; filename="report.pdf"',
    } }));
    const response = await app.request(`${profilePath}/artifacts/${sha}/content`, { headers: { ...admin, Range: 'bytes=4-6', 'If-Range': `"${sha}"` } });
    expect(response.status).toBe(206);
    expect(mocks.capability).toHaveBeenCalledWith('node-1', 'example', 'artifact_transfer');
    expect(mocks.stream).toHaveBeenCalledWith('node-1', 'example', `artifacts/${sha}/content`, expect.objectContaining({ range: 'bytes=4-6', ifRange: `"${sha}"` }));
    expect(Object.fromEntries(['content-type', 'content-disposition', 'content-range', 'content-length', 'accept-ranges', 'etag', 'repr-digest', 'x-content-sha256', 'x-content-type-options', 'content-security-policy']
      .map(name => [name, response.headers.get(name)]))).toEqual({
      'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="report.pdf"', 'content-range': 'bytes 4-6/16', 'content-length': '3',
      'accept-ranges': 'bytes', etag: `"${sha}"`, 'repr-digest': `sha-256=:${digest}:`, 'x-content-sha256': sha, 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([4, 5, 6]);
    // Without a usable disposition or media type the download still has a safe name and type.
    mocks.stream.mockResolvedValue(new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'text html', 'Content-Disposition': 'inline' } }));
    const plain = await app.request(`${profilePath}/artifacts/${sha}/content`, { headers: admin });
    expect(plain.status).toBe(200);
    expect(plain.headers.get('content-type')).toBe('application/octet-stream');
    expect(plain.headers.get('content-disposition')).toBe(`attachment; filename="ardent-${sha}"`);
    mocks.stream.mockResolvedValue(new Response('{}', { status: 416, headers: { 'Content-Range': 'bytes */16' } }));
    const unsatisfiable = await app.request(`${profilePath}/artifacts/${sha}/content`, { headers: { ...admin, Range: 'bytes=99-' } });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-range')).toBe('bytes */16');
    mocks.stream.mockClear();
    for (const headers of [{ Range: 'bytes=0-1,3-4' }, { Range: 'bytes=0-', 'If-Range': 'W/"weak"' }])
      expect((await app.request(`${profilePath}/artifacts/${sha}/content`, { headers: { ...admin, ...headers } })).status).toBe(400);
    expect(mocks.stream).not.toHaveBeenCalled();
    // The .bin route keeps its old shape.
    mocks.stream.mockResolvedValue(new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'application/octet-stream' } }));
    expect((await app.request(`${profilePath}/artifacts/${sha}`, { headers: admin })).headers.get('content-disposition')).toBe(`attachment; filename="ardent-${sha}.bin"`);
  });

  it('passes a valid execution context and the trace to the node, and drops an invalid one without refusing the task', async () => {
    expect((await post({ action: 'task-submit', body: task, execution: { ...execution, unknown: 'dropped' } })).status).toBe(200);
    expect(mocks.action).toHaveBeenLastCalledWith('node-1', 'example', 'task-submit', undefined, task, { execution });
    expect(mocks.execution).toHaveBeenCalledWith('node-1', 'example');
    // The x-hive-execution header stands in for a missing body field, as Ardent reads it.
    const header = Buffer.from(JSON.stringify(execution)).toString('base64url');
    const traceparent = `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`;
    expect((await post({ action: 'mission-submit', body: { objective: 'Write', mission: { id: 'p1:brief', revision: 1, parent_task: null, constraints: [], allowed_actions: ['analyze'], resources: ['project:p1'],
      deadline: 4_102_444_800, acceptance_criteria: ['A brief'], expected_artifacts: ['brief.md'] }, idempotency_key: 'p1:brief:1' } },
    { 'x-hive-execution': header, 'x-request-id': 'req-9', traceparent })).status).toBe(200);
    expect(mocks.action.mock.lastCall?.[5]).toEqual({ execution, trace: { request_id: 'req-9', traceparent } });
    for (const invalid of [{ v: 2, root: execution.root }, { v: 1, root: 'not-a-ref' }, 'text', 7]) {
      const response = await post({ action: 'task-submit', body: task, execution: invalid });
      expect(response.status, JSON.stringify(invalid)).toBe(200);
      expect(mocks.action).toHaveBeenLastCalledWith('node-1', 'example', 'task-submit', undefined, task);
    }
    // An older profile gets the task without the context it would refuse.
    mocks.execution.mockResolvedValue(false);
    expect((await post({ action: 'task-submit', body: task, execution })).status).toBe(200);
    expect(mocks.action).toHaveBeenLastCalledWith('node-1', 'example', 'task-submit', undefined, task);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ardent.task-submit', details: expect.objectContaining({ executionRoot: execution.root }) }));
  });

  it('runs task-recovery and artifact-import like pause and cancel: ADMIN people, checked bodies, audited without results or notes', async () => {
    mocks.action.mockResolvedValue({ status: 'resolved' });
    for (const role of ['OPERATOR', 'VIEWER'])
      expect((await post({ action: 'task-recovery', target: taskId, body: { action: 'abandon' } }, { 'x-test-role': role })).status).toBe(403);
    const decided = await post({ action: 'task-recovery', target: taskId, body: { action: 'mark_applied', call_id: 'call-1', result: { secret: 'value' }, note: 'private note' } });
    expect(decided.status).toBe(200);
    expect(mocks.capability).toHaveBeenCalledWith('node-1', 'example', 'recovery');
    expect(mocks.action.mock.lastCall?.slice(0, 5)).toEqual(['node-1', 'example', 'task-recovery', taskId, { action: 'mark_applied', call_id: 'call-1', result: { secret: 'value' }, note: 'private note' }]);
    const audited = mocks.audit.mock.calls.find(call => call[0].action === 'ardent.task-recovery')![0];
    expect(audited.details).toMatchObject({ target: taskId, decision: 'mark_applied', callId: 'call-1' });
    expect(JSON.stringify(audited)).not.toContain('private note');
    expect(JSON.stringify(audited)).not.toContain('value');
    mocks.action.mockResolvedValue({ import_id: 'b'.repeat(32) });
    const importBody = { peer_id: 'peer-1', a2a_task_id: 'remote-task', artifact_id: 'c'.repeat(32) };
    expect((await post({ action: 'artifact-import', body: importBody })).status).toBe(200);
    expect(mocks.capability).toHaveBeenCalledWith('node-1', 'example', 'artifact_transfer');
    mocks.action.mockClear();
    for (const bad of [{ action: 'task-recovery', body: { action: 'abandon' } }, { action: 'task-recovery', target: 'x', body: { action: 'abandon' } },
      { action: 'task-recovery', target: taskId, body: { action: 'retry' } }, { action: 'artifact-import', target: 'x', body: importBody },
      { action: 'artifact-import', body: { ...importBody, url: 'https://example.com' } }])
      expect((await post(bad)).status, JSON.stringify(bad)).toBe(400);
    expect(mocks.action).not.toHaveBeenCalled();
    // Ardent's own refusal of a decision that is no longer valid comes back as 409.
    mocks.action.mockRejectedValue(new (await import('../sdk/node-api-client.js')).AgentResponseError(409, { error: { message: 'Not awaiting a decision' } }));
    expect((await post({ action: 'task-recovery', target: taskId, body: { action: 'abandon' } })).status).toBe(409);
  });

  it('passes this request\'s ID, a child trace and a valid execution header to profile reads', async () => {
    const { correlationId } = await import('../middleware/correlation-id.js');
    const { tracing } = await import('../middleware/tracing.js');
    const traced = new Hono<AppVariables>();
    traced.use('*', correlationId);
    traced.use('*', tracing);
    traced.route('/ardent', ardentRouter);
    traced.onError(errorHandler);
    const header = Buffer.from(JSON.stringify(execution)).toString('base64url');
    const traceId = '4'.repeat(32);
    expect((await traced.request(`${profilePath}/tasks/${taskId}/lineage`, { headers: { ...admin, 'x-request-id': 'req-xyz',
      traceparent: `00-${traceId}-${'5'.repeat(16)}-01`, 'x-hive-execution': header } })).status).toBe(200);
    const forwarded = mocks.read.mock.lastCall?.[4] as Record<string, string>;
    expect(forwarded['x-request-id']).toBe('req-xyz');
    expect(forwarded['traceparent']).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
    expect(forwarded['traceparent']).not.toBe(`00-${traceId}-${'5'.repeat(16)}-01`);
    expect(JSON.parse(Buffer.from(forwarded['x-hive-execution']!, 'base64url').toString('utf8'))).toEqual(execution);
    // An execution header that does not hold a valid context is not passed on.
    await traced.request(`${profilePath}/tasks/${taskId}/lineage`, { headers: { ...admin, 'x-hive-execution': 'bm90LWpzb24' } });
    expect((mocks.read.mock.lastCall?.[4] as Record<string, string>)['x-hive-execution']).toBeUndefined();
  });

  it('sends package-install the node ID for the profiles\' instance references, whatever the caller sent', async () => {
    mocks.action.mockResolvedValue({ installed: true, version: '3.2.0', changed: true });
    expect((await post({ action: 'package-install', body: { anything: true } })).status).toBe(200);
    expect(mocks.action).toHaveBeenLastCalledWith('node-1', 'example', 'package-install', undefined, { node_id: 'node-1' });
  });
});
