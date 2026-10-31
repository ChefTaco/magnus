import { readHermesSecurityEvents, summarizeHermesSecurityEvents, type HermesSecurityEvent } from '../../../runtime-hermes-security-events.mjs';
import { readHermesSshTrustInventory } from '../../../runtime-hermes-security.mjs';

export const dynamic = 'force-dynamic';

function text(event: HermesSecurityEvent, key: string): string {
  const value = event[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '—';
}

export default function HermesProxySecurityPage(): React.ReactElement {
  const events = readHermesSecurityEvents({ limit: 250 });
  const summary = summarizeHermesSecurityEvents(events);
  let trustInventory: ReturnType<typeof readHermesSshTrustInventory> = [];
  let trustInventoryError: string | null = null;
  try {
    trustInventory = readHermesSshTrustInventory();
  } catch (error) {
    trustInventoryError = error instanceof Error ? error.message : 'SSH trust inventory is unreadable';
  }
  const metrics = [
    ['Rejected origins', summary.rejectedOrigins],
    ['Invalid sessions', summary.invalidSessions],
    ['Blocked targets', summary.blockedDestinations],
    ['Rejected paths', summary.rejectedEndpoints],
    ['Queue pressure', summary.queuePressure],
    ['Backpressure', summary.backpressure],
    ['Key mismatches', summary.hostKeyMismatches],
    ['Closed sessions', summary.connectionsClosed],
  ] as const;

  return <div className="space-y-5" data-testid="hermes-proxy-security-page">
    <header className="flex items-end justify-between gap-4 border-b border-danger/20 pb-4">
      <div>
        <div className="text-[10px] uppercase tracking-[.3em] text-danger">SSH bridge controls</div>
        <h1 className="mt-1 text-xl font-black uppercase tracking-wider">Hermes proxy security</h1>
        <p className="mt-1 text-xs text-text-muted">Rejected requests, destination policy, queue pressure, connection duration, and correlation evidence.</p>
      </div>
      <div className="text-right text-[10px] uppercase tracking-wider text-text-muted">Mean connection<br/><span className="font-mono text-primary">{summary.averageConnectionDurationMs} ms</span></div>
    </header>

    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-8">
      {metrics.map(([label, value]) => <div key={label} className="rounded border border-border/50 bg-surface p-3">
        <div className="text-[9px] uppercase tracking-[.18em] text-text-muted">{label}</div>
        <div className="mt-2 font-mono text-xl font-bold text-primary">{value}</div>
      </div>)}
    </section>

    <section className="overflow-hidden rounded border border-border/50 bg-surface">
      <div className="border-b border-border/50 px-3 py-3">
        <div className="text-[9px] uppercase tracking-[.2em] text-text-muted">Fleet SSH trust inventory</div>
        <p className="mt-1 text-[10px] text-text-muted">Expected fingerprints, first-seen evidence, approved overlap windows, expired keys, and affected connections.</p>
      </div>
      <div className="grid grid-cols-[10rem_10rem_minmax(14rem,1.4fr)_8rem_10rem_7rem] border-b border-border/50 px-3 py-2 text-[9px] uppercase tracking-[.16em] text-text-muted">
        <span>Node</span><span>Addresses</span><span>Expected fingerprints</span><span>First seen</span><span>Rotation</span><span>Mismatches</span>
      </div>
      {trustInventory.map((entry) => {
        const mismatches = events.filter((event) =>
          event.type === 'host_key_mismatch' && event.installationId === entry.installationId
        );
        return <div key={entry.installationId} className="grid grid-cols-[10rem_10rem_minmax(14rem,1.4fr)_8rem_10rem_7rem] border-b border-border/20 px-3 py-2 text-[10px] last:border-0">
          <span><span className="font-semibold text-primary">{entry.nodeId}</span><br/><span className="text-text-muted">{entry.hostname ?? entry.installationId}</span></span>
          <span className="font-mono text-text-muted">{entry.addresses.join(', ') || '—'}</span>
          <span className="space-y-1 font-mono">{entry.expectedFingerprints.map((fingerprint) => <span key={fingerprint} className="block truncate" title={fingerprint}>{fingerprint}</span>)}</span>
          <span className="font-mono text-text-muted">{entry.firstSeenAt ? new Date(entry.firstSeenAt).toISOString().slice(0, 10) : '—'}</span>
          <span className={entry.rotationState === 'overlap' ? 'text-warning' : entry.rotationState === 'expired' ? 'text-danger' : 'text-accent'}>
            {entry.rotationState}
            {entry.overlapExpiresAt && <><br/><span className="font-mono text-[9px] text-text-muted">until {new Date(entry.overlapExpiresAt).toISOString()}</span></>}
            {entry.expiredFingerprints.length > 0 && <><br/><span className="text-[9px] text-text-muted">{entry.expiredFingerprints.length} expired</span></>}
          </span>
          <span className={mismatches.length > 0 ? 'font-mono font-bold text-danger' : 'font-mono text-accent'}>{mismatches.length}</span>
        </div>;
      })}
      {trustInventory.length === 0 && <div className="p-5 text-xs text-text-muted">{trustInventoryError ?? 'No reviewed SSH trust bindings are configured.'}</div>}
    </section>

    <section className="overflow-hidden rounded border border-border/50 bg-surface">
      <div className="grid grid-cols-[10rem_10rem_minmax(11rem,1fr)_minmax(12rem,1.2fr)_8rem] border-b border-border/50 px-3 py-2 text-[9px] uppercase tracking-[.2em] text-text-muted">
        <span>Timestamp</span><span>Event</span><span>Target / path</span><span>Correlation ID</span><span>Duration</span>
      </div>
      {events.slice(0, 100).map((event, index) => <div key={`${event.timestamp}-${event.correlationId ?? index}`} className="grid grid-cols-[10rem_10rem_minmax(11rem,1fr)_minmax(12rem,1.2fr)_8rem] border-b border-border/20 px-3 py-2 text-[10px] last:border-0">
        <span className="font-mono text-text-muted">{event.timestamp}</span>
        <span className="uppercase text-accent">{event.type.replaceAll('_', ' ')}</span>
        <span>{text(event, 'hostname') !== '—' ? text(event, 'hostname') : text(event, 'path')}</span>
        <span className="truncate font-mono text-primary" title={text(event, 'correlationId')}>{text(event, 'correlationId')}</span>
        <span className="font-mono">{event.durationMs == null ? '—' : `${text(event, 'durationMs')} ms`}</span>
      </div>)}
      {events.length === 0 && <div className="p-5 text-xs text-text-muted">No Hermes proxy security events have been recorded.</div>}
    </section>
  </div>;
}
