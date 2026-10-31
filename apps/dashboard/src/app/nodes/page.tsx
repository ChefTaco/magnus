import { fleetFetch } from '@/lib/fleet-fetch';
import NodesPageClient from './nodes-client';
import type { NodeRow } from './nodes-client';
import type { TailscaleExpirySummary } from '@/types/contracts';

export default async function NodesPage(): Promise<React.ReactElement> {
  let initialNodes: NodeRow[] = [];
  let initialTailscaleSummary: TailscaleExpirySummary | null = null;
  const [nodesResult, tailscaleResult] = await Promise.allSettled([
    fleetFetch<{ success: boolean; data: NodeRow[] }>('nodes'),
    fleetFetch<{ success: boolean; data: TailscaleExpirySummary }>('nodes/tailscale/summary'),
  ]);
  if (nodesResult.status === 'fulfilled' && nodesResult.value.success) {
    initialNodes = nodesResult.value.data;
  }
  if (tailscaleResult.status === 'fulfilled' && tailscaleResult.value.success) {
    initialTailscaleSummary = tailscaleResult.value.data;
  }

  return (
    <NodesPageClient
      initialNodes={initialNodes}
      initialTailscaleSummary={initialTailscaleSummary}
    />
  );
}
