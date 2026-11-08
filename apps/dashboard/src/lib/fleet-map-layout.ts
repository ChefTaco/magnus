export interface CanvasTopologyNode {
  id: string;
  name: string;
  hostname: string;
  ip: string;
  port: number;
  status: string;
  subnet: string;
  reachable: boolean;
  latencyMs: number | null;
}

export interface CanvasTopologyEdge {
  from: string;
  to: string;
  latencyMs: number | null;
  type: 'same-subnet' | 'cross-subnet';
}

export interface CanvasTopology {
  nodes: CanvasTopologyNode[];
  edges: CanvasTopologyEdge[];
  subnets: Array<{ cidr: string; nodeCount: number; nodes: string[]; isGateway: boolean }>;
}

export interface LaidOutNode {
  node: CanvasTopologyNode;
  x: number;
  y: number;
  phase: number;
  stress: number; // 0..1
}

export interface Cluster {
  x: number;
  y: number;
  r: number;
  cidr: string;
  isGateway: boolean;
  size: number;
}

const TAU = Math.PI * 2;

function stressFromNode(n: CanvasTopologyNode): number {
  if (!n.reachable) return 1;
  if (n.status === 'OFFLINE') return 1;
  if (n.status === 'DEGRADED') return 0.75;
  if (n.status === 'PROVISIONING') return 0.45;
  const lat = n.latencyMs ?? 0;
  if (lat > 100) return 0.8;
  if (lat > 50) return 0.55;
  if (lat > 20) return 0.3;
  return 0.12;
}

export function layoutNodes(
  topo: CanvasTopology,
  width: number,
  height: number,
): { nodes: LaidOutNode[]; clusters: Cluster[] } {
  // Cluster by subnet. Each subnet becomes a ring-cluster arranged on an outer ring.
  const subnets = topo.subnets.length > 0
    ? topo.subnets
    : [{ cidr: 'default', nodeCount: topo.nodes.length, nodes: topo.nodes.map((n) => n.id), isGateway: false }];

  const cx = width / 2;
  const cy = height / 2;
  const outerR = Math.min(width, height) * 0.38;
  const result: LaidOutNode[] = [];
  const clusters: Cluster[] = [];

  // Equal-sized subnets may all be flagged as gateways. Only a unique
  // gateway gets the center; tied candidates each need their own ring position.
  const gateways = subnets.filter((subnet) => subnet.isGateway);
  const centralSubnet = subnets.length === 1 ? subnets[0] : gateways.length === 1 ? gateways[0] : undefined;
  const ringCount = subnets.length - (centralSubnet ? 1 : 0);
  let ringIndex = 0;

  subnets.forEach((subnet) => {
    const centered = subnet === centralSubnet;
    const subnetAngle = centered ? 0 : (ringIndex++ / Math.max(1, ringCount)) * TAU;
    const single = subnets.length === 1;
    const subnetX = centered ? cx : cx + Math.cos(subnetAngle) * outerR;
    const subnetY = centered ? cy : cy + Math.sin(subnetAngle) * outerR;
    const nodes = topo.nodes.filter((n) => subnet.nodes.includes(n.id));
    const clusterR = nodes.length <= 1 ? 0 : Math.min(single ? outerR * 0.75 : 80, 24 + nodes.length * 8);
    clusters.push({ x: subnetX, y: subnetY, r: clusterR + 18, cidr: subnet.cidr, isGateway: subnet.isGateway, size: nodes.length });

    nodes.forEach((node, ni) => {
      const a = (ni / Math.max(1, nodes.length)) * TAU;
      const x = subnetX + Math.cos(a) * clusterR;
      const y = subnetY + Math.sin(a) * clusterR;
      // Stable phase from id hash
      let h = 0;
      for (let i = 0; i < node.id.length; i++) h = (h * 31 + node.id.charCodeAt(i)) | 0;
      const phase = (Math.abs(h % 1000) / 1000) * TAU;
      result.push({ node, x, y, phase, stress: stressFromNode(node) });
    });
  });

  return { nodes: result, clusters };
}
