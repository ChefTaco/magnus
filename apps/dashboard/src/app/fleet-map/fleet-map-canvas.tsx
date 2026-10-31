'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { readThemeColors, type ThemeColors } from '@/lib/theme-colors';
import { useReducedMotion } from '@/hooks/use-reduced-motion';

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

interface InFlightCommand {
  nodeId: string;
}

interface Props {
  topology: CanvasTopology;
  inFlight?: InFlightCommand[];
  onSelectNode?: (node: CanvasTopologyNode | null) => void;
  highlightedNodeIds?: string[];
  selectedNodeId?: string | null;
}

interface LaidOutNode {
  node: CanvasTopologyNode;
  x: number;
  y: number;
  phase: number;
  stress: number; // 0..1
}

interface Cluster {
  x: number;
  y: number;
  r: number;
  cidr: string;
  isGateway: boolean;
  size: number;
}

const TAU = Math.PI * 2;

/** Fractional part in [0, 1), also for negative input (id hashes can be negative). */
function frac(value: number): number {
  return ((value % 1) + 1) % 1;
}
const GLOW_BUCKETS = 8;

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

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex.trim());
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : [255, 255, 255];
}

/** success → warning → danger, using the theme colours. */
function makeStressColor(colors: ThemeColors): (stress: number, alpha?: number) => string {
  const stops = [hexToRgb(colors.success), hexToRgb(colors.warning), hexToRgb(colors.danger)];
  return (stress, alpha = 1) => {
    const t = Math.max(0, Math.min(1, stress));
    const [from, to, k] = t < 0.5 ? [stops[0]!, stops[1]!, t / 0.5] : [stops[1]!, stops[2]!, (t - 0.5) / 0.5];
    const mix = (i: number): number => Math.round(from[i]! + (to[i]! - from[i]!) * k);
    return `rgba(${mix(0)},${mix(1)},${mix(2)},${alpha})`;
  };
}

function layoutNodes(
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

  subnets.forEach((subnet, si) => {
    const subnetAngle = (si / Math.max(1, subnets.length)) * TAU;
    const single = subnets.length === 1;
    const subnetX = subnet.isGateway || single ? cx : cx + Math.cos(subnetAngle) * outerR;
    const subnetY = subnet.isGateway || single ? cy : cy + Math.sin(subnetAngle) * outerR;
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

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Pre-rendered radial glow per stress bucket; drawImage is far cheaper than shadowBlur per node. */
function buildGlowSprites(stressColor: (s: number, a?: number) => string, dpr: number): HTMLCanvasElement[] {
  const size = Math.ceil(64 * dpr);
  return Array.from({ length: GLOW_BUCKETS }, (_, i) => {
    const sprite = makeCanvas(size, size);
    const g = sprite.getContext('2d');
    if (!g) return sprite;
    const stress = i / (GLOW_BUCKETS - 1);
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, stressColor(stress, 0.55));
    grad.addColorStop(0.35, stressColor(stress, 0.18));
    grad.addColorStop(1, stressColor(stress, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return sprite;
  });
}

/** Static backdrop: polar grid and subnet halos, drawn once per layout. */
function buildBackground(w: number, h: number, dpr: number, colors: ThemeColors, clusters: Cluster[], font: string): HTMLCanvasElement {
  const bg = makeCanvas(Math.floor(w * dpr), Math.floor(h * dpr));
  const g = bg.getContext('2d');
  if (!g) return bg;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = colors.bg;
  g.fillRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.hypot(cx, cy);
  const [pr, pg, pb] = hexToRgb(colors.primary);
  g.lineWidth = 1;
  for (let r = 60; r < maxR; r += 60) {
    g.strokeStyle = `rgba(${pr},${pg},${pb},${r % 180 === 0 ? 0.09 : 0.045})`;
    g.beginPath();
    g.arc(cx, cy, r, 0, TAU);
    g.stroke();
  }
  g.strokeStyle = `rgba(${pr},${pg},${pb},0.04)`;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(a) * maxR, cy + Math.sin(a) * maxR);
    g.stroke();
  }

  const [ar, ag, ab] = hexToRgb(colors.accent);
  g.font = `10px ${font}`;
  // One-node subnets (e.g. per-host tailnet /24s) get no halo or label; the node name is drawn instead.
  for (const c of clusters.filter((cluster) => cluster.size > 1)) {
    const [r, gg, b] = c.isGateway ? [ar, ag, ab] : [pr, pg, pb];
    const halo = g.createRadialGradient(c.x, c.y, c.r * 0.2, c.x, c.y, c.r);
    halo.addColorStop(0, `rgba(${r},${gg},${b},0.05)`);
    halo.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    g.fillStyle = halo;
    g.beginPath();
    g.arc(c.x, c.y, c.r, 0, TAU);
    g.fill();
    g.setLineDash([3, 5]);
    g.strokeStyle = `rgba(${r},${gg},${b},0.25)`;
    g.beginPath();
    g.arc(c.x, c.y, c.r, 0, TAU);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = `rgba(${r},${gg},${b},0.55)`;
    g.fillText(c.isGateway ? `${c.cidr} · gateway` : c.cidr, c.x - c.r * 0.7, c.y - c.r - 6);
  }
  return bg;
}

export default function FleetMapCanvas({ topology, inFlight = [], onSelectNode, selectedNodeId, highlightedNodeIds = [] }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const laidOutRef = useRef<LaidOutNode[]>([]);
  const hoverRef = useRef<string | null>(null);
  const highlightedRef = useRef(highlightedNodeIds);
  useEffect(() => { highlightedRef.current = highlightedNodeIds; redrawRef.current?.(); }, [highlightedNodeIds]);
  const selectedRef = useRef<string | null>(selectedNodeId ?? null);
  const redrawRef = useRef<(() => void) | null>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const [fps, setFps] = useState(60);
  const reduced = useReducedMotion();
  const [colors, setColors] = useState<ThemeColors | null>(null);

  useEffect(() => {
    setColors(readThemeColors());
  }, []);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const r = entry.contentRect;
      setSize({ w: Math.max(320, Math.floor(r.width)), h: Math.max(320, Math.floor(r.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Selection changes repaint without restarting the loop.
  useEffect(() => {
    selectedRef.current = selectedNodeId ?? null;
    redrawRef.current?.();
  }, [selectedNodeId]);

  // Layout + render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !colors) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(size.w * dpr);
    canvas.height = Math.floor(size.h * dpr);
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const font = getComputedStyle(document.body).fontFamily || 'monospace';
    const layout = layoutNodes(topology, size.w, size.h);
    laidOutRef.current = layout.nodes;
    const nodesById = new Map(layout.nodes.map((l) => [l.node.id, l] as const));
    const inFlightSet = new Set(inFlight.map((c) => c.nodeId));
    const stressColor = makeStressColor(colors);
    const sprites = buildGlowSprites(stressColor, dpr);
    const background = buildBackground(size.w, size.h, dpr, colors, layout.clusters, font);
    const [pr, pg, pb] = hexToRgb(colors.primary);
    const [ar, ag, ab] = hexToRgb(colors.accent);
    const cx = size.w / 2;
    const cy = size.h / 2;
    const sweepR = Math.hypot(cx, cy);
    const labelAll = layout.nodes.length <= 32;
    // Dense meshes (every node in its own subnet) would otherwise drown the nodes.
    const edgeFade = Math.min(1, 24 / Math.max(1, topology.edges.length));
    const animate = !reduced;

    const draw = (t: number): void => {
      ctx.drawImage(background, 0, 0, size.w, size.h);

      // Radar sweep
      if (animate && typeof ctx.createConicGradient === 'function') {
        const angle = (t * 0.6) % TAU;
        const sweep = ctx.createConicGradient(angle - 0.9, cx, cy);
        sweep.addColorStop(0, `rgba(${pr},${pg},${pb},0)`);
        sweep.addColorStop(0.14, `rgba(${pr},${pg},${pb},0.08)`);
        sweep.addColorStop(0.1433, `rgba(${pr},${pg},${pb},0)`);
        sweep.addColorStop(1, `rgba(${pr},${pg},${pb},0)`);
        ctx.fillStyle = sweep;
        ctx.beginPath();
        ctx.arc(cx, cy, sweepR, 0, TAU);
        ctx.fill();
      }

      // Edges
      ctx.lineWidth = 1;
      for (const e of topology.edges) {
        const a = nodesById.get(e.from);
        const b = nodesById.get(e.to);
        if (!a || !b) continue;
        ctx.strokeStyle = e.type === 'same-subnet' ? `rgba(${pr},${pg},${pb},${0.2 * edgeFade + 0.04})` : `rgba(${ar},${ag},${ab},${0.16 * edgeFade + 0.03})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // In-flight commands: animated dashes plus a travelling packet
      if (inFlightSet.size > 0) {
        ctx.setLineDash([6, 6]);
        ctx.lineDashOffset = animate ? -(t * 60) % 20 : 0;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = `rgba(${pr},${pg},${pb},0.85)`;
        for (const e of topology.edges) {
          if (!inFlightSet.has(e.from) && !inFlightSet.has(e.to)) continue;
          const a = nodesById.get(e.from);
          const b = nodesById.get(e.to);
          if (!a || !b) continue;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          if (animate) {
            const k = frac(t * 0.5 + a.phase / TAU);
            const px = a.x + (b.x - a.x) * k;
            const py = a.y + (b.y - a.y) * k;
            ctx.fillStyle = `rgba(${pr},${pg},${pb},0.95)`;
            ctx.beginPath();
            ctx.arc(px, py, 2.5, 0, TAU);
            ctx.fill();
          }
        }
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
      }

      // Nodes
      const selected = selectedRef.current;
      ctx.font = `11px ${font}`;
      for (const l of layout.nodes) {
        const { x, y, phase, stress, node } = l;
        const isSelected = selected === node.id;
        const isHover = hoverRef.current === node.id;
        const sprite = sprites[Math.round(stress * (GLOW_BUCKETS - 1))];
        if (sprite) ctx.drawImage(sprite, x - 32, y - 32, 64, 64);

        if (highlightedRef.current.includes(node.id)) {
          ctx.save(); ctx.strokeStyle = colors.accent; ctx.lineWidth = 2; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.arc(x, y, 22, 0, TAU); ctx.stroke(); ctx.restore();
        }
        // Heartbeat ring for reachable nodes
        if (node.reachable && animate) {
          const pulse = frac(t * 0.6 + phase / TAU);
          ctx.strokeStyle = stressColor(stress, 0.45 * (1 - pulse));
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(x, y, Math.max(0, 8 + pulse * 16), 0, TAU);
          ctx.stroke();
        }

        ctx.fillStyle = colors.bg;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, TAU);
        ctx.fill();
        ctx.fillStyle = stressColor(stress);
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = stressColor(stress, 0.8);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, TAU);
        ctx.stroke();

        if (isSelected || isHover) {
          ctx.strokeStyle = colors.primary;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(x, y, 12, 0, TAU);
          ctx.stroke();
          // Corner ticks
          for (let i = 0; i < 4; i++) {
            const a = i * (Math.PI / 2) + Math.PI / 4;
            ctx.beginPath();
            ctx.moveTo(x + Math.cos(a) * 15, y + Math.sin(a) * 15);
            ctx.lineTo(x + Math.cos(a) * 19, y + Math.sin(a) * 19);
            ctx.stroke();
          }
        }

        if (isHover || isSelected || labelAll) {
          ctx.fillStyle = isHover || isSelected ? colors.text : `rgba(${pr},${pg},${pb},0.6)`;
          ctx.fillText(node.name, x + 14, y + 4);
        }
      }
    };

    let raf: number | null = null;
    let visible = true;
    let lastFrame = performance.now();
    let frameSamples = 0;
    let frameAccum = 0;

    const tick = (now: number): void => {
      const dt = now - lastFrame;
      lastFrame = now;
      frameAccum += dt;
      frameSamples++;
      if (frameSamples >= 30) {
        const avg = frameAccum / frameSamples;
        setFps(Math.min(120, Math.round(1000 / Math.max(1, avg))));
        frameSamples = 0;
        frameAccum = 0;
      }
      draw(now / 1000);
      raf = visible ? requestAnimationFrame(tick) : null;
    };

    const start = (): void => {
      if (raf === null && animate && visible) {
        lastFrame = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };

    // Pause the loop while the map is scrolled out of view.
    const io = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? true;
      if (visible) start();
    });
    io.observe(canvas);

    if (animate) {
      redrawRef.current = null; // the loop repaints every frame
      start();
    } else {
      redrawRef.current = () => draw(0);
      draw(0);
    }

    return () => {
      io.disconnect();
      if (raf !== null) cancelAnimationFrame(raf);
      redrawRef.current = null;
    };
  }, [topology, size.w, size.h, inFlight, colors, reduced]);

  const hitTest = useCallback((px: number, py: number): CanvasTopologyNode | null => {
    for (const l of laidOutRef.current) {
      const dx = l.x - px;
      const dy = l.y - py;
      if (dx * dx + dy * dy < 14 * 14) return l.node;
    }
    return null;
  }, []);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    onSelectNode?.(hit);
  };

  const handleMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    const newId = hit?.id ?? null;
    if (newId !== hoverRef.current) {
      hoverRef.current = newId;
      canvas.style.cursor = newId ? 'pointer' : 'default';
      redrawRef.current?.();
    }
  };

  return (
    <div
      ref={containerRef}
      className="panel-corners relative h-[600px] w-full overflow-hidden rounded-panel border border-primary/25 bg-bg shadow-[0_0_24px_var(--color-glow)]"
      data-testid="fleet-map-canvas-container"
    >
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        onMouseMove={handleMove}
        onMouseLeave={() => {
          hoverRef.current = null;
          redrawRef.current?.();
        }}
        data-testid="fleet-map-canvas"
        data-node-count={topology.nodes.length}
        role="img"
        aria-label={`Fleet topology: ${topology.nodes.length} nodes across ${topology.subnets.length} subnets`}
      />

      {/* FPS + legend overlay */}
      <div className="absolute left-3 top-3 flex items-center gap-2 rounded-chip border border-primary/20 bg-bg/80 px-2 py-1 text-[10px] uppercase tracking-wider text-text-muted backdrop-blur-sm" data-testid="fleet-map-fps">
        {reduced ? (
          <span className="text-primary">static</span>
        ) : (
          <span className={cn('num', fps >= 55 ? 'text-success' : fps >= 30 ? 'text-warning' : 'text-danger')}>
            {fps} fps
          </span>
        )}
        <span className="text-border-strong">·</span>
        <span className="num">{topology.nodes.length} nodes</span>
      </div>
      <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-3 rounded-chip border border-primary/20 bg-bg/80 px-2 py-1 text-[10px] uppercase tracking-wider text-text-muted backdrop-blur-sm" data-testid="fleet-map-legend">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-success shadow-[0_0_6px_var(--color-success)]" /> healthy
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-warning shadow-[0_0_6px_var(--color-warning)]" /> stressed
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-danger shadow-[0_0_6px_var(--color-danger)]" /> critical
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-px w-3 bg-primary" /> subnet
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-px w-3 bg-accent" /> cross-subnet
        </span>
        {inFlight.length > 0 && (
          <span className="flex items-center gap-1 text-primary">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" /> {inFlight.length} in-flight
          </span>
        )}
      </div>
    </div>
  );
}
