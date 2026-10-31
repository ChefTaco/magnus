'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { api } from '@/lib/api-client';
import { useControlNode } from '@/lib/control-node-context';
import { formatDate } from '@/lib/utils';
import { RefreshCw, FileText, Calendar } from 'lucide-react';
import { PageTransition, PageItem } from '@/components/ui/page-transition';

export interface AuditRow {
  id: string;
  action: string;
  actorId: string;
  actorType: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown> | string;
  timestamp: string;
  verificationState?: 'verified' | 'legacy-partial' | 'invalid';
}

interface AuditPageClientProps {
  initialEvents: AuditRow[];
  initialDays: string[];
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseDetails(details: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof details === 'string') {
    try {
      return JSON.parse(details) as Record<string, unknown>;
    } catch {
      return { raw: details };
    }
  }
  return details ?? {};
}

function actionVariant(action: string): 'info' | 'success' | 'warning' | 'danger' {
  if (action.includes('delete') || action.includes('decommission') || action.includes('cancel'))
    return 'danger';
  if (
    action.includes('create') ||
    action.includes('register') ||
    action.includes('deploy') ||
    action.includes('push')
  )
    return 'success';
  if (action.includes('update') || action.includes('assign')) return 'warning';
  return 'info';
}

export default function AuditPageClient({
  initialEvents,
  initialDays,
}: AuditPageClientProps): React.ReactElement {
  const { activeNode } = useControlNode();
  const [events, setEvents] = useState<AuditRow[]>(initialEvents);
  const [loading, setLoading] = useState(false);
  const [verification, setVerification] = useState('unverified');
  const [selected, setSelected] = useState<AuditRow | null>(null);

  // Day picker
  const [availableDays, setAvailableDays] = useState<string[]>(initialDays);
  const [selectedDay, setSelectedDay] = useState<string>(todayKey());
  const [isFirstLoad, setIsFirstLoad] = useState(true);

  const fetchDays = useCallback(async (): Promise<void> => {
    try {
      const res = await api.audit.days();
      const days = res.data as string[];
      setAvailableDays(days);
    } catch {
      // API not available
    }
  }, []);

  const fetchAudit = useCallback(async (day: string): Promise<void> => {
    try {
      setLoading(true);
      const res = await api.audit.list({ pageSize: 200, date: day });
      setEvents(res.data as AuditRow[]);
      const meta = (res as unknown as { meta?: { verification?: { state?: string } } }).meta;
      setVerification(meta?.verification?.state ?? 'unverified');
    } catch {
      setVerification('unverified');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // On first mount, only fetch if SSR returned empty data (fleetFetch may
    // have failed silently).  On subsequent renders (activeNode change) always
    // refetch.
    if (isFirstLoad) {
      setIsFirstLoad(false);
      // Refresh verification even when server-rendered history is populated.
    }
    // activeNode changed or SSR data was empty — refetch
    void fetchDays();
    void fetchAudit(selectedDay);
  }, [activeNode.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // When day changes (but not initial mount), fetch fresh
    if (isFirstLoad) return;
    void fetchAudit(selectedDay);
  }, [selectedDay]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDayChange = (day: string): void => {
    setSelectedDay(day);
  };

  const handleRefresh = (): void => {
    void fetchDays();
    void fetchAudit(selectedDay);
  };

  const selectedDetails = selected ? parseDetails(selected.details) : {};

  // Ensure today is always in the dropdown even if no file exists yet
  const dropdownDays = availableDays.includes(todayKey())
    ? availableDays
    : [todayKey(), ...availableDays];

  return (
    <PageTransition className="space-y-6">
      <PageItem>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold uppercase tracking-wider">Audit Log</h1>
            <p className="mt-1 text-[11px] text-text-muted uppercase tracking-wider">
              Fleet actions with verified or explicitly partial legacy integrity
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* Day picker */}
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-primary/60" />
              <select
                value={selectedDay}
                onChange={(e) => handleDayChange(e.target.value)}
                className="rounded border border-border bg-bg px-3 py-1.5 text-xs text-text focus:border-primary focus:outline-none focus:shadow-[0_0_8px_var(--color-glow)] transition-all"
              >
                {dropdownDays.map((day) => (
                  <option key={day} value={day}>
                    {day === todayKey() ? `Today (${day})` : day}
                  </option>
                ))}
              </select>
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className="h-3.5 w-3.5" />}
              onClick={handleRefresh}
            >
              Refresh
            </Button>
          </div>
        </div>
      </PageItem>

      <PageItem>
        <Card>
          <p role="status" className="mb-4 text-xs">
            Chain: {verification}. Legacy partial signatures do not protect targets, details, actor
            type or IP address.
          </p>
          {loading ? (
            <div className="py-8 text-center text-[11px] text-text-muted">Loading audit trail…</div>
          ) : events.length === 0 ? (
            <div className="py-8 text-center text-[11px] text-text-muted">
              No audit events for {selectedDay}.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-primary/20 text-left text-[10px] font-bold uppercase tracking-[0.15em] text-text-muted">
                    <th className="pb-3 pr-4">Timestamp</th>
                    <th className="pb-3 pr-4">Action</th>
                    <th className="pb-3 pr-4">Actor</th>
                    <th className="pb-3 pr-4">Target</th>
                    <th className="pb-3">Integrity</th>
                    <th className="pb-3">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {events.map((event) => (
                    <tr
                      key={event.id}
                      className="hover:bg-surface-hover cursor-pointer transition-colors"
                      onClick={() => setSelected(event)}
                    >
                      <td className="py-3 pr-4 text-text-muted">{formatDate(event.timestamp)}</td>
                      <td className="py-3 pr-4">
                        <Badge variant={actionVariant(event.action)}>{event.action}</Badge>
                      </td>
                      <td className="py-3 pr-4 text-text-muted">
                        <span className="text-[11px]">{event.actorId.slice(0, 10)}…</span>
                        <span className="ml-1 text-[10px]">({event.actorType})</span>
                      </td>
                      <td className="py-3 pr-4 text-text-muted">
                        {event.targetType}:{event.targetId.slice(0, 10)}
                      </td>
                      <td>{event.verificationState ?? 'unverified'}</td>
                      <td className="max-w-[200px] truncate py-3 text-[11px] text-text-muted">
                        {JSON.stringify(
                          typeof event.details === 'string'
                            ? parseDetails(event.details)
                            : event.details,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </PageItem>
      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title="Audit Event"
        description={selected?.action ?? ''}
        icon={<FileText className="h-5 w-5 text-primary" />}
        className="max-w-2xl"
      >
        {selected && (
          <div className="space-y-4">
            {/* Summary grid */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded border border-border bg-bg p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-1">
                  Action
                </p>
                <Badge variant={actionVariant(selected.action)}>{selected.action}</Badge>
              </div>
              <div className="rounded border border-border bg-bg p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-1">
                  Timestamp
                </p>
                <p className="text-xs">{formatDate(selected.timestamp)}</p>
              </div>
              <div className="rounded border border-border bg-bg p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-1">
                  Actor
                </p>
                <p className="text-xs">{selected.actorId}</p>
                <p className="text-[10px] text-text-muted">{selected.actorType}</p>
              </div>
              <div className="rounded border border-border bg-bg p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-1">
                  Target
                </p>
                <p className="text-xs">{selected.targetId}</p>
                <p className="text-[10px] text-text-muted">{selected.targetType}</p>
              </div>
            </div>

            {/* Event ID */}
            <div className="rounded border border-border bg-bg p-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-1">
                Event ID
              </p>
              <p className="text-xs text-text-muted">{selected.id}</p>
            </div>

            {/* Details */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-2">
                Details
              </p>
              {Object.keys(selectedDetails).length === 0 ? (
                <p className="text-[11px] text-text-muted italic">No additional details</p>
              ) : (
                <div className="rounded border border-border bg-bg p-3 space-y-2">
                  {Object.entries(selectedDetails).map(([key, value]) => (
                    <div key={key} className="flex items-start gap-2">
                      <span className="text-[11px] font-bold text-primary min-w-[100px] shrink-0">
                        {key}
                      </span>
                      <span className="text-[11px] text-text-muted break-all">
                        {typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end pt-2">
              <Button variant="secondary" size="sm" onClick={() => setSelected(null)}>
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </PageTransition>
  );
}
