import { describe, expect, it } from 'vitest';
import { layoutNodes, type CanvasTopology } from './fleet-map-layout';

function topology(sizes: number[], gateways: number[]): CanvasTopology {
  const subnets = sizes.map((size, index) => ({
    cidr: `192.0.${index}.0/24`,
    nodeCount: size,
    nodes: Array.from({ length: size }, (_, node) => `node-${index}-${node}`),
    isGateway: gateways.includes(index),
  }));
  return {
    subnets,
    edges: [],
    nodes: subnets.flatMap((subnet) => subnet.nodes.map((id) => ({
      id, name: id, hostname: `${id}.example.com`, ip: '192.0.2.1', port: 4100,
      status: 'ONLINE', subnet: subnet.cidr, reachable: true, latencyMs: 5,
    }))),
  };
}

function expectSeparated(map: CanvasTopology, width: number, height: number): void {
  const { nodes } = layoutNodes(map, width, height);
  expect(nodes).toHaveLength(map.nodes.length);
  for (const [index, node] of nodes.entries()) {
    expect(node.x).toBeGreaterThan(14);
    expect(node.x).toBeLessThan(width - 14);
    expect(node.y).toBeGreaterThan(14);
    expect(node.y).toBeLessThan(height - 14);
    for (const other of nodes.slice(index + 1)) {
      // Each host's hit target has a radius of 14 CSS pixels.
      expect(Math.hypot(node.x - other.x, node.y - other.y)).toBeGreaterThan(28);
    }
  }
}

describe('Fleet Map layout', () => {
  it.each([[1000, 600], [320, 600]])('separates singleton gateway subnets at %i × %i', (width, height) => {
    expectSeparated(topology(Array(18).fill(1), Array.from({ length: 18 }, (_, i) => i)), width, height);
  });

  it('separates multiple tied gateway clusters', () => {
    expectSeparated(topology([3, 3, 3], [0, 1, 2]), 1000, 600);
  });

  it('centers a unique gateway and distributes the other subnets', () => {
    const map = topology([1, 3, 1, 1], [1]);
    const { clusters } = layoutNodes(map, 1000, 600);
    expect(clusters[1]).toMatchObject({ x: 500, y: 300 });
    expectSeparated(map, 1000, 600);
  });

  it('keeps one subnet centered and spreads its hosts', () => {
    const map = topology([18], []);
    expect(layoutNodes(map, 1000, 600).clusters[0]).toMatchObject({ x: 500, y: 300 });
    expectSeparated(map, 1000, 600);
  });

  it('lays out hosts without subnet metadata and handles an empty fleet', () => {
    const map = topology([4], []);
    map.subnets = [];
    expectSeparated(map, 1000, 600);
    expect(layoutNodes({ nodes: [], edges: [], subnets: [] }, 1000, 600).nodes).toEqual([]);
  });
});
