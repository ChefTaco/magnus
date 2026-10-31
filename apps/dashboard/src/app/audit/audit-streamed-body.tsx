import { fleetFetch } from '@/lib/fleet-fetch';
import AuditPageClient from './audit-client';
import type { AuditRow } from './audit-client';

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Streamed audit body.
 *
 * Fetches the audit rows and days list, then renders the client component.
 * Kept in a separate file so the page shell can render immediately while this
 * async tree resolves inside a <Suspense> boundary.
 */
export default async function AuditStreamedBody(): Promise<React.ReactElement> {
  let initialEvents: AuditRow[] = [];
  let initialDays: string[] = [];

  try {
    const [daysRes, eventsRes] = await Promise.all([
      fleetFetch<{ success: boolean; data: string[] }>('audit/days').catch(() => null),
      fleetFetch<{ success: boolean; data: AuditRow[] }>(`audit?pageSize=200&date=${todayKey()}`).catch(() => null),
    ]);
    if (daysRes?.success) initialDays = daysRes.data;
    if (eventsRes?.success) initialEvents = eventsRes.data;
  } catch {
    // Control node unreachable at SSR time — client will retry
  }

  return (
    <div data-testid="audit-rows-stream">
      <AuditPageClient initialEvents={initialEvents} initialDays={initialDays} />
    </div>
  );
}
