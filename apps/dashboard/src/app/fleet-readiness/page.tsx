import Link from 'next/link';
import { fleetSystemFetch } from '@/lib/fleet-fetch';
import { Activity, ShieldAlert, Server, Wrench } from 'lucide-react';
import type { FleetReadinessNode } from '@hivemagnus/magnus-contracts';

export const dynamic = 'force-dynamic';

interface ReadinessResponse {
  generatedAt: string;
  nodes: Array<FleetReadinessNode & { hermes?: { status: string; version: string | null; gatewayStatus: string } | null; health?: { cpuUsagePercent: number; memoryPercent: number; diskWarnings: Array<{ mountPoint: string; usagePercent: number }> } | null }>;
}

// These are dashboard/control-plane sentinel records, not fleet nodes an
// operator can deploy to or remediate.
const INTERNAL_READINESS_NODE_IDS = new Set(['__control-api__', '__dashboard__']);

async function loadReadiness(): Promise<ReadinessResponse | null> {
  try {
    const res = await fleetSystemFetch<{ success: boolean; data: ReadinessResponse }>('ops/readiness');
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

export default async function FleetReadinessPage(): Promise<React.ReactElement> {
  const readiness = await loadReadiness();
  const nodes = (readiness?.nodes ?? []).filter((node) => !INTERNAL_READINESS_NODE_IDS.has(node.id));
  const staleCount = nodes.filter((node) => node.stale).length;
  const blockedCount = nodes.filter((node) => node.destructiveActionsBlocked).length;

  return (
    <div className="space-y-5" data-testid="fleet-readiness-page">
      <div>
        <h1 className="text-lg font-bold uppercase tracking-wider">Fleet Readiness</h1>
        <p className="mt-1 text-[11px] uppercase tracking-wider text-text-muted">
          Deploy eligibility, heartbeat freshness, Hermes posture, and destructive-action gates
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Metric icon={Server} label="Nodes" value={nodes.length} />
        <Metric icon={ShieldAlert} label="Stale" value={staleCount} tone={staleCount > 0 ? 'warn' : 'ok'} />
        <Metric icon={Wrench} label="Deploy eligible" value={nodes.filter((node) => node.deployEligible).length} />
        <Metric icon={Activity} label="Blocked actions" value={blockedCount} tone={blockedCount > 0 ? 'warn' : 'ok'} />
      </div>

      <div className="overflow-hidden rounded border border-border/50 bg-surface">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-border/50 text-[10px] uppercase tracking-[0.18em] text-text-muted">
            <tr>
              <th className="px-3 py-2">Node</th>
              <th className="px-3 py-2">Posture</th>
              <th className="px-3 py-2">Agent</th>
              <th className="px-3 py-2">Hermes</th>
              <th className="px-3 py-2">Health</th>
              <th className="px-3 py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((node) => (
              <tr key={node.id} className="border-b border-border/30 last:border-0">
                <td className="px-3 py-2">
                  <Link href={`/nodes/${node.id}`} className="font-semibold text-accent hover:text-primary">{node.name}</Link>
                  <div className="text-[10px] text-text-muted">{node.hostname} · {node.os}/{node.arch}</div>
                </td>
                <td className="px-3 py-2">
                  <Badge tone={node.stale ? 'warn' : node.status === 'ONLINE' ? 'ok' : 'muted'}>
                    {node.operationalStatus}
                  </Badge>
                  <div className="mt-1 text-[10px] text-text-muted">{node.lastHeartbeatAt ?? 'never'}</div>
                </td>
                <td className="px-3 py-2">
                  <div>{node.agentVersion ?? 'unknown'}</div>
                  <div className="text-[10px] text-text-muted">{node.agentStatus ?? 'not reported'}</div>
                </td>
                <td className="px-3 py-2">
                  <div>{node.hermes?.status ?? 'unknown'}</div>
                  <div className="text-[10px] text-text-muted">gateway {node.hermes?.gatewayStatus ?? 'unknown'}</div>
                </td>
                <td className="px-3 py-2">
                  <div>CPU {Math.round(node.health?.cpuUsagePercent ?? 0)}% · Mem {Math.round(node.health?.memoryPercent ?? 0)}%</div>
                  <div className="text-[10px] text-text-muted">
                    {(node.health?.diskWarnings?.length ?? 0) > 0 ? `${node.health?.diskWarnings.length} disk warnings` : 'no disk warnings'}
                  </div>
                </td>
                <td className="px-3 py-2">
                  {node.destructiveActionsBlocked ? (
                    <span className="text-warning">Blocked while stale</span>
                  ) : (
                    <Link className="text-primary hover:text-accent" href={`/governor/operations?node=${node.id}`}>Run preflight</Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!readiness && <div className="p-4 text-xs text-warning">Readiness data unavailable.</div>}
      </div>
    </div>
  );
}

function Metric({ icon: Icon, label, value, tone = 'default' }: { icon: React.ElementType; label: string; value: number; tone?: 'default' | 'ok' | 'warn' }) {
  const color = tone === 'ok' ? 'text-success' : tone === 'warn' ? 'text-warning' : 'text-primary';
  return (
    <div className="rounded border border-border/50 bg-surface p-3">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-text-muted">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className={`mt-2 text-2xl font-bold ${color}`}>{value}</div>
    </div>
  );
}

function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'muted'; children: React.ReactNode }) {
  const cls = tone === 'ok' ? 'border-success/40 text-success bg-success/5' : tone === 'warn' ? 'border-warning/40 text-warning bg-warning/5' : 'border-border text-text-muted bg-bg/50';
  return <span className={`inline-flex rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider ${cls}`}>{children}</span>;
}
