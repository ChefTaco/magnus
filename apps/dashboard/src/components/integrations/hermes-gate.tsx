import type { ReactNode } from 'react';
import { connection } from 'next/server';
import { Bot } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { hermesEnabled } from '../../../runtime-integrations.mjs';

/** Renders Hermes Agent pages only when the optional integration is enabled. */
export async function HermesGate({ children }: { children: ReactNode }): Promise<React.ReactElement> {
  await connection();
  if (hermesEnabled()) return <>{children}</>;
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Optional integration" title="Hermes Agent" description="Manage Hermes Agent installations and profiles across the fleet." />
      <EmptyState
        tone="muted"
        icon={<Bot className="h-5 w-5" />}
        title="Hermes Agent integration not enabled"
        description="Set MAGNUS_HERMES_ENABLED=true on the Magnus UI server and restart it to enable these pages."
      />
    </div>
  );
}
