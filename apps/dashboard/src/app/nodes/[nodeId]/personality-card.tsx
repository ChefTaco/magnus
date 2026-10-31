'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Sparkline } from '@/components/ui/sparkline';
import { api } from '@/lib/api-client';
import { Sparkles, RefreshCw } from 'lucide-react';

interface HealthSnapshot {
  cpuUsagePercent: number;
  memoryPercent: number;
  timestamp?: string;
  recordedAt?: string;
}

interface NodeForPersonality {
  id: string;
  name: string;
  hostname: string;
  status: string;
  lastHeartbeatAt: string | null;
}

interface Archetype {
  name: string;
  emoji: string;
  description: string;
  accent: 'success' | 'warning' | 'danger' | 'info' | 'default';
}

const ARCHETYPES: Record<string, Archetype> = {
  workhorse: {
    name: 'Workhorse',
    emoji: '🐴',
    description: 'Steady, reliable, never complains.',
    accent: 'success',
  },
  'drama-queen': {
    name: 'Drama Queen',
    emoji: '🎭',
    description: 'High variance, loves spiking CPU for attention.',
    accent: 'warning',
  },
  'zen-master': {
    name: 'Zen Master',
    emoji: '🧘',
    description: 'Low usage, mind always clear, never stressed.',
    accent: 'info',
  },
  sprinter: {
    name: 'Sprinter',
    emoji: '⚡',
    description: 'Bursts of intense activity followed by calm recovery.',
    accent: 'info',
  },
  groundhog: {
    name: 'Groundhog',
    emoji: '🌀',
    description: 'Keeps rebooting — might see its own shadow again.',
    accent: 'warning',
  },
  ghost: {
    name: 'Ghost',
    emoji: '👻',
    description: 'Often unreachable. Is it even there?',
    accent: 'danger',
  },
  marathoner: {
    name: 'Marathoner',
    emoji: '🏃',
    description: 'Long uptime, steady pace, built to last.',
    accent: 'success',
  },
  rookie: {
    name: 'Rookie',
    emoji: '🌱',
    description: 'Not enough history yet — still finding its rhythm.',
    accent: 'default',
  },
};

export interface NodePersonality {
  archetype: Archetype;
  archetypeKey: string;
  bio: string;
  stats: {
    cpuAvg: number;
    cpuStdDev: number;
    memAvg: number;
    samples: number;
    spikes: number; // cpu > 80
  };
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((acc, x) => acc + (x - m) * (x - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export function computePersonality(
  node: NodeForPersonality,
  snapshots: HealthSnapshot[],
): NodePersonality {
  const cpus = snapshots.map((s) => s.cpuUsagePercent).filter((x) => Number.isFinite(x));
  const mems = snapshots.map((s) => s.memoryPercent).filter((x) => Number.isFinite(x));

  const cpuAvg = mean(cpus);
  const cpuSD = stdDev(cpus);
  const memAvg = mean(mems);
  const spikes = cpus.filter((x) => x > 80).length;

  let archetypeKey: string = 'rookie';
  if (node.status === 'OFFLINE' || (node.lastHeartbeatAt && Date.now() - new Date(node.lastHeartbeatAt).getTime() > 10 * 60_000)) {
    archetypeKey = 'ghost';
  } else if (snapshots.length < 3) {
    archetypeKey = 'rookie';
  } else if (cpuSD > 25 || spikes / Math.max(1, cpus.length) > 0.25) {
    archetypeKey = spikes / Math.max(1, cpus.length) > 0.4 ? 'drama-queen' : 'sprinter';
  } else if (cpuAvg < 15 && cpuSD < 10) {
    archetypeKey = 'zen-master';
  } else if (cpuAvg > 40 && cpuAvg < 75 && cpuSD < 15) {
    archetypeKey = 'workhorse';
  } else if (cpuAvg < 40 && cpuSD < 15 && snapshots.length > 20) {
    archetypeKey = 'marathoner';
  } else {
    archetypeKey = 'workhorse';
  }

  const archetype: Archetype = ARCHETYPES[archetypeKey] ?? ARCHETYPES.rookie ?? {
    name: 'Rookie', emoji: '🌱', description: '', accent: 'default',
  };
  const bio = generateBio(node, archetype, { cpuAvg, cpuSD, memAvg, samples: cpus.length, spikes });

  return {
    archetype,
    archetypeKey,
    bio,
    stats: { cpuAvg, cpuStdDev: cpuSD, memAvg, samples: cpus.length, spikes },
  };
}

function generateBio(
  node: NodeForPersonality,
  archetype: Archetype,
  stats: { cpuAvg: number; cpuSD: number; memAvg: number; samples: number; spikes: number },
): string {
  // Deterministic pseudo-random selection based on node.id + ISO week
  const weekSeed = Math.floor(Date.now() / (1000 * 60 * 60 * 24 * 7));
  let h = weekSeed;
  for (let i = 0; i < node.id.length; i++) h = (h * 31 + node.id.charCodeAt(i)) | 0;
  const pick = <T,>(arr: T[]): T => {
    const idx = Math.abs(h) % arr.length;
    return arr[idx] as T;
  };

  const templates: Record<string, string[]> = {
    workhorse: [
      `Steady as they come — averaging ${stats.cpuAvg.toFixed(0)}% CPU without a single complaint this week.`,
      `The dependable one. ${node.hostname} just keeps grinding through the workload.`,
      `Quietly productive at ~${stats.cpuAvg.toFixed(0)}% CPU. Gets the job done and asks for nothing.`,
    ],
    'drama-queen': [
      `Lives for the spotlight — ${stats.spikes} CPU spikes this week and counting.`,
      `${node.hostname} likes to keep things interesting with a ±${stats.cpuSD.toFixed(0)}% swing.`,
      `A connoisseur of chaos. Never a dull moment with this one.`,
    ],
    'zen-master': [
      `Practices minimalism. Barely breaks a sweat at ${stats.cpuAvg.toFixed(0)}% CPU.`,
      `${node.hostname} is in its happy place — calm, cool, collected.`,
      `Achieving enlightenment one idle cycle at a time.`,
    ],
    sprinter: [
      `Bursts of energy, then recovery. ${stats.spikes} sprints logged this week.`,
      `${node.hostname} runs hot, then cools down. Classic sprinter cadence.`,
      `Lives in intervals — full throttle, then full zen.`,
    ],
    groundhog: [
      `Déjà vu all over again. Might want to check the uptime.`,
      `${node.hostname} keeps hitting the reset button.`,
    ],
    ghost: [
      `Hasn't been seen in a while. Anyone home?`,
      `${node.hostname} is currently out of contact. Check the heartbeat.`,
    ],
    marathoner: [
      `In it for the long haul — ${stats.samples} data points of pure consistency.`,
      `${node.hostname} doesn't sprint. It endures.`,
    ],
    rookie: [
      `Still new around here — gathering experience.`,
      `${node.hostname} is just getting started. Check back soon.`,
    ],
  };

  return pick((templates[archetype.name.toLowerCase().replace(' ', '-')] ?? templates.rookie ?? ['…']) as string[]);
}

interface Props {
  node: NodeForPersonality;
}

export function NodePersonalityCard({ node }: Props) {
  const [snapshots, setSnapshots] = useState<HealthSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.get<HealthSnapshot[] | { items?: HealthSnapshot[] }>(
          `nodes/${node.id}/health/history?limit=100`,
        );
        if (cancelled) return;
        const raw = res.data;
        let items: HealthSnapshot[] = [];
        if (Array.isArray(raw)) items = raw;
        else if (raw?.items) items = raw.items;
        // History comes newest-first; reverse so sparklines flow left->right in time
        setSnapshots([...items].reverse());
      } catch (err) {
        if (!cancelled) {
          // Endpoint may not exist yet; fall back to empty
          setSnapshots([]);
          setError(err instanceof Error ? err.message : 'Failed to load history');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [node.id, refreshKey]);

  const personality = useMemo(() => computePersonality(node, snapshots), [node, snapshots]);

  const cpuSeries = snapshots.map((s) => s.cpuUsagePercent).slice(-40);
  const memSeries = snapshots.map((s) => s.memoryPercent).slice(-40);

  return (
    <Card
      title="Personality"
      action={
        <button
          onClick={() => setRefreshKey((k) => k + 1)}
          className="text-text-muted hover:text-text transition p-1"
          title="Refresh personality"
          data-testid="node-personality-refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      }
    >
      <div
        className="flex flex-col gap-4"
        data-testid="node-personality-card"
        data-archetype={personality.archetypeKey}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-accent/40 bg-bg text-2xl shadow-[0_0_16px_var(--color-glow-accent)]" aria-hidden="true">
              {personality.archetype.emoji}
            </span>
            <div>
              <div className="flex items-center gap-2">
                <span data-testid="node-archetype-badge">
                  <Badge variant={personality.archetype.accent}>
                    {personality.archetype.name}
                  </Badge>
                </span>
                {loading && <span className="text-xs text-text-muted italic">analyzing…</span>}
              </div>
              <p className="mt-1 text-xs text-text-muted">{personality.archetype.description}</p>
            </div>
          </div>
          <Sparkles className="h-4 w-4 text-accent mt-1" />
        </div>

        <blockquote
          className="border-l-2 border-accent/40 pl-3 text-sm italic text-text"
          data-testid="node-personality-bio"
        >
          “{personality.bio}”
        </blockquote>

        <div className="grid grid-cols-2 gap-4 pt-2 border-t border-border/30">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs uppercase tracking-wider text-text-muted">CPU trend</span>
              <span className="text-xs tabular-nums text-text-muted">
                avg {personality.stats.cpuAvg.toFixed(0)}%
              </span>
            </div>
            <Sparkline values={cpuSeries} tone="primary" percent stretch threshold={80} testId="node-personality-cpu-sparkline" label={`CPU trend, average ${personality.stats.cpuAvg.toFixed(0)}%`} />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs uppercase tracking-wider text-text-muted">Memory trend</span>
              <span className="text-xs tabular-nums text-text-muted">
                avg {personality.stats.memAvg.toFixed(0)}%
              </span>
            </div>
            <Sparkline values={memSeries} tone="accent" percent stretch threshold={80} testId="node-personality-mem-sparkline" label={`Memory trend, average ${personality.stats.memAvg.toFixed(0)}%`} />
          </div>
        </div>

        <div className="flex items-center gap-4 text-[11px] text-text-muted">
          <span>{personality.stats.samples} samples</span>
          <span>σ {personality.stats.cpuStdDev.toFixed(1)}%</span>
          <span>{personality.stats.spikes} spikes</span>
          {error && <span className="text-warning">· {error}</span>}
        </div>
      </div>
    </Card>
  );
}
