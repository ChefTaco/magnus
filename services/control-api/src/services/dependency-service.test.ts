import { afterEach, describe, expect, it, vi } from 'vitest';
const nodes = [
  { id: 'app', name: 'App', hostname: 'app.invalid', ipAddress: '10.1.0.1', port: 4100 },
  { id: 'db', name: 'Database', hostname: 'db.invalid', ipAddress: 'db.invalid', port: 4100 },
  { id: 'down', name: 'Unknown host', hostname: 'down.invalid', ipAddress: '10.1.0.3', port: 4100 },
];
vi.mock('../db/index.js', () => ({
  getDb: () => ({ node: { findMany: () => Promise.resolve(nodes) } }),
}));
vi.mock('../utils/env.js', () => ({ getNodeManagerSecret: () => 'test-node-secret' }));
vi.mock('node:dns/promises', () => ({
  lookup: (host: string) =>
    Promise.resolve([{ address: host === 'db.invalid' ? '10.1.0.2' : host, family: 4 }]),
}));
import { buildDependencyGraph } from './dependency-service.js';
afterEach(() => vi.unstubAllGlobals());
describe('partial network observations', () => {
  it('keeps healthy edges, resolves aliases and labels from the destination process', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('10.1.0.3')) return Promise.reject(new Error('unreachable'));
        return Promise.resolve(
          new Response(
            JSON.stringify(
              url.includes('db.invalid')
                ? {
                    listeningPorts: [{ port: 35432, protocol: 'tcp', process: 'postgres' }],
                    connections: [],
                  }
                : {
                    listeningPorts: [],
                    connections: [
                      {
                        localPort: 50000,
                        remoteIp: '::ffff:10.1.0.2',
                        remotePort: 35432,
                        state: 'ESTABLISHED',
                      },
                    ],
                  },
            ),
          ),
        );
      }),
    );
    const graph = await buildDependencyGraph();
    expect(graph.status).toBe('partial');
    expect(graph.nodes.find((n) => n.id === 'down')?.collection.status).toBe('unknown');
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ from: 'app', to: 'db', service: 'postgres' }),
    );
  });
});
