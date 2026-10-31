import { fleetFetch } from '@/lib/fleet-fetch';
import DashboardPageClient from './dashboard-client';
import type { OverviewStats } from './dashboard-client';
import type { TailscaleExpirySummary } from '@/types/contracts';

export default async function DashboardPage(): Promise<React.ReactElement> {
  let initialStats: OverviewStats | null = null;
  // The Tailscale summary can take several seconds, so the client loads it after first paint.
  const initialTailscaleSummary: TailscaleExpirySummary | null = null;
  const statsResult = await fleetFetch<{ success: boolean; data: OverviewStats }>('stats/overview').catch(() => null);
  if (statsResult?.success) {
    initialStats = statsResult.data;
  }

  return (
    <DashboardPageClient
      initialStats={initialStats}
      initialTailscaleSummary={initialTailscaleSummary}
    />
  );
}
