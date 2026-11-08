/** Disposable integration worker. A fresh process exercises durable retry state. Never shipped. */
import { disconnectDb } from '../db/index.js';
import { renewDueArdentHiveMemCredentials, setArdentHiveMemRenewalDeps } from './ardent-hivemem-renewal.js';

const origin = process.env['HIVEMEM_TEST_ORIGIN']!;
const now = new Date(process.env['HIVEMEM_TEST_NOW']!);
const nodeId = process.env['HIVEMEM_TEST_NODE']!;
const restore = setArdentHiveMemRenewalDeps({
  settings: () => ({ apiUrl: origin, agentUrl: origin, workspaceId: 'default', hours: 48,
    auth: { kind: 'token', token: process.env['HIVEMEM_TEST_OWNER_TOKEN']! } }),
  now: () => now,
  installation: async () => ({ nodeId, nodeName: process.env['HIVEMEM_TEST_NODE_NAME'] ?? 'fixture', hostname: 'node-1.example.com',
    reachable: true, installed: true, version: '2.2.0', checkedAt: now.toISOString(), owner: 'operator', error: null,
    profiles: [{ id: 'lead', name: 'lead', running: true, backend: 'llamacpp', apiPort: 9910, a2aEnabled: false, channels: {}, error: null }] }),
  action: async (_node, _profile, action, _target, body) => {
    const response = await fetch(new URL('delivery', origin), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, body }) });
    if (!response.ok) throw new Error('Synthetic node response lost');
    return {};
  },
  read: async <T,>() => ({ status: 'ready' }) as T,
});
try { console.log('COUNTS=' + JSON.stringify(await renewDueArdentHiveMemCredentials())); }
finally { restore(); await disconnectDb(); }
