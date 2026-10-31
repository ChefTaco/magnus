import { type ReactNode } from 'react';
import { DashboardShell } from '@/components/layout/dashboard-shell';
import type { IntegrationFlags } from '@/lib/routes';

/**
 * Server-component shell wrapper.
 * The interactive chrome (Sidebar, Header, pathname check) is delegated to
 * DashboardShell (client component) so this component — and the root layout —
 * remain server-renderable.
 */
export function AppShell({ children, integrations }: { children: ReactNode; integrations: IntegrationFlags }): React.ReactElement {
  return <DashboardShell integrations={integrations}>{children}</DashboardShell>;
}
