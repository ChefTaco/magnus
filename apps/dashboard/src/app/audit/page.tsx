import { Suspense } from 'react';
import AuditStreamedBody from './audit-streamed-body';

/**
 * Audit page with streaming SSR.
 *
 * The shell (header + skeleton) renders immediately; the audit rows stream in
 * via Suspense once the backing fetches resolve, keeping TTFB fast even when
 * the control node's audit storage is slow.
 */
export default function AuditPage(): React.ReactElement {
  return (
    <div data-testid="audit-shell">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-accent">Audit Log</h1>
      </div>
      <Suspense
        fallback={
          <div data-testid="audit-rows-skeleton" className="space-y-2">
            <div className="h-8 animate-pulse rounded bg-bg-elevated" />
            <div className="h-8 animate-pulse rounded bg-bg-elevated" />
            <div className="h-8 animate-pulse rounded bg-bg-elevated" />
          </div>
        }
      >
        <AuditStreamedBody />
      </Suspense>
    </div>
  );
}
