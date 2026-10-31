import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const artifactId = 'a'.repeat(64);
const artifactBytes = Buffer.from('# Fixture research brief\n\nCited source: source-1\n');
const taskId = '11111111-1111-4111-8111-111111111111';
const profile = {
  id: 'assistant', name: 'Assistant', backend: 'llamacpp', apiPort: 9910, running: true,
  a2aEnabled: true, channels: { telegram: false, slack: false }, error: null,
};
const installation = {
  nodeId: 'fixture', nodeName: 'Fixture node', hostname: 'fixture.invalid', reachable: true,
  error: null, installed: true, version: '0.1.0', owner: 'ardent', profiles: [profile],
  checkedAt: new Date().toISOString(), stagedPackage: null, stagedPackageError: null,
};
const fixtureConfig = `schema_version: 1
profile: assistant
execution:
  backend: llamacpp
providers:
  llamacpp:
    base_url: http://127.0.0.1:8080
    model: fixture
  codex:
    model: fixture
channels:
  telegram:
    enabled: false
    token_env: TELEGRAM_BOT_TOKEN
    allowed_user_ids: []
    allowed_chat_ids: []
`;

test('Ardent profile navigation, saved configuration, provider error, channel state, task artifact, and Hermes navigation', async ({ page }) => {
  await page.goto('/ardent/profiles');
  if (new URL(page.url()).pathname === '/login') {
    await page.getByLabel('Username').fill(process.env.TEST_USERNAME ?? 'ci-admin');
    await page.getByLabel('Password', { exact: true }).fill(process.env.TEST_PASSWORD ?? 'ci-only-browser-password');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await expect(page).toHaveURL('/');
    await page.goto('/ardent/profiles');
  }
  let configText = fixtureConfig;
  let configRevision = 'fixture-revision-0';
  const actions: string[] = [];
  await page.route('**/api/proxy/ardent/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/proxy/ardent/', '');
    const send = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ success: status < 400, ...(status < 400 ? { data } : { error: data }) }) });
    if (path === 'installations') return send([installation]);
    if (path === 'profiles') return send([{ ...profile, nodeId: 'fixture', nodeName: 'Fixture node', hostname: 'fixture.invalid', installationVersion: '0.1.0', reachable: true }]);
    if (path === 'installations/fixture') return send(installation);
    const resource = path.replace(/^installations\/fixture\/profiles\/assistant\//, '');
    if (resource === `artifacts/${artifactId}`) return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: artifactBytes });
    if (resource === 'action') {
      const raw: unknown = request.postDataJSON();
      const action = raw && typeof raw === 'object' && 'action' in raw ? raw.action : null;
      if (typeof action !== 'string') return send('Invalid action', 400);
      actions.push(action);
      if (action === 'config-validate') return send({ valid: true, runtime_problems: [] });
      if (action === 'config-save') {
        const body = raw && typeof raw === 'object' && 'body' in raw ? raw.body : null;
        if (!body || typeof body !== 'object' || !('revision' in body) || body.revision !== configRevision || !('text' in body) || typeof body.text !== 'string') return send('Configuration revision conflict', 409);
        configText = body.text;
        configRevision = 'fixture-revision-1';
        return send({ revision: configRevision, activation_required: true });
      }
      if (action === 'provider-test') return send('fixture backend unavailable', 503);
      if (action === 'task-submit') return send({ task_id: taskId, state: 'queued' });
      return send({ ok: true });
    }
    if (resource === 'config') return send({ text: configText, revision: configRevision });
    if (resource === 'status') return send({ profile: 'assistant', backend: 'llamacpp', tasks: 1 });
    if (resource === 'tasks') return send({ tasks: [{ id: taskId, state: 'completed', prompt: 'Fixture research question', result: 'Cited source: source-1', error: null, backend: 'llamacpp', created_ms: Date.now() }] });
    if (resource === `tasks/${taskId}/events`) return send({ events: [{ sequence: 1, kind: 'research_artifacts', detail: { markdown: { id: artifactId, name: 'research-brief.md', bytes: artifactBytes.length, media_type: 'text/markdown' } }, created_ms: Date.now() }] });
    if (resource === 'providers') return send({ selected: 'llamacpp', llamacpp: { status: 'ready', model: 'fixture' }, codex: { status: 'unconfigured' } });
    if (resource === 'channels') return send({ telegram: { enabled: false, token_configured: false, allowed_user_count: 0 }, slack: { enabled: false, token_configured: false, allowed_user_count: 0 } });
    if (resource === 'peers') return send({ peers: [] });
    if (resource === 'peers/config') return send({ text: 'schema_version: 1\npeers: []\n', revision: 'peer-revision' });
    if (resource === 'skills') return send({ skills: [] });
    if (resource === 'memory/status') return send({ status: 'degraded', agent_id: 'assistant', workspace_id: 'default', retrieval: null, storage: null, reason: 'Fixture service unavailable' });
    if (resource === 'openapi') return send({ openapi: '3.1.0', info: { title: 'Ardent API', version: '0.1.0' }, paths: {} });
    return send('Unknown fixture resource', 404);
  });
  await page.reload();

  await expect(page.getByRole('heading', { name: 'Profiles', exact: true })).toBeVisible();
  await page.getByRole('link', { name: /Assistant/ }).last().click();
  await expect(page).toHaveURL(/\/ardent\/profiles\/fixture~assistant$/);
  await page.getByRole('tab', { name: 'Configuration' }).click();
  const editor = page.getByRole('textbox', { name: 'Profile YAML' });
  await expect(editor).toBeVisible();
  await editor.fill(`${configText}\n# Browser acceptance edit\n`);
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved on the node' })).toBeVisible();
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('tab', { name: 'Configuration' }).click();
  await expect(editor).toHaveValue(/Browser acceptance edit/);
  expect(actions).toContain('config-save');

  await page.getByRole('tab', { name: 'Providers' }).click();
  await expect(page.getByText('llama.cpp', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Test selected backend' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'fixture backend unavailable' })).toBeVisible();
  await page.getByRole('tab', { name: 'Channels' }).click();
  await expect(page.getByText('Credential unconfigured').first()).toBeVisible();
  await expect(page.getByText('Slack', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Tasks & Artifacts' }).click();
  await page.getByLabel('Filter tasks by state').selectOption('failed');
  await expect(page.getByText('No tasks match this state.')).toBeVisible();
  await page.getByLabel('Filter tasks by state').selectOption('completed');
  await page.getByRole('button', { name: /Fixture research question/ }).click();
  await expect(page.getByText('research-brief.md')).toBeVisible();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: /research-brief.md/ }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('research-brief.md');
  const output = resolve(root, 'output/ardent/screenshots');
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: resolve(output, 'profile-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250); // Let the existing mobile-sidebar transition settle before capture.
  await page.screenshot({ path: resolve(output, 'profile-narrow.png'), fullPage: true });
  await page.getByRole('main').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: resolve(output, 'profile-narrow-bottom.png'), fullPage: true });
  const horizontalOverflow = await page.getByRole('main').evaluate(element => element.scrollWidth > element.clientWidth);
  expect(horizontalOverflow).toBe(false);
  await page.goto('/ardent');
  await expect(page.getByText('Assistant', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open profile' })).toBeVisible();
  await page.goto('/orchestra');
  if (process.env['MAGNUS_HERMES_ENABLED']?.trim().toLowerCase() === 'true')
    await expect(page.getByRole('heading', { name: 'Hermes Agents' })).toBeVisible();
  else
    await expect(page.getByText('Hermes Agent integration not enabled')).toBeVisible();
});
