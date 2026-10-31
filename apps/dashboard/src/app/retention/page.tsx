import { fleetSystemFetch } from '@/lib/fleet-fetch';

export const dynamic = 'force-dynamic';
import { Database, HardDrive } from 'lucide-react';

interface RetentionTable {
  name: string;
  count: number;
  oldestAt: string | null;
  policy: string;
  cutoffs?: Record<string, string>;
}

async function loadRetention(): Promise<RetentionTable[]> {
  try {
    const res = await fleetSystemFetch<{ success: boolean; data: { tables: RetentionTable[] } }>('ops/retention');
    return res.success ? res.data.tables : [];
  } catch {
    return [];
  }
}

export default async function RetentionPage(): Promise<React.ReactElement> {
  const tables = await loadRetention();
  return (
    <div className="space-y-5" data-testid="retention-page">
      <div>
        <h1 className="text-lg font-bold uppercase tracking-wider">Retention</h1>
        <p className="mt-1 text-[11px] uppercase tracking-wider text-text-muted">
          Operational data volume, oldest rows, and purge-policy visibility
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded border border-border/50 bg-surface p-4">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-text-muted">
            <Database className="h-3.5 w-3.5" />
            Total records
          </div>
          <div className="mt-2 text-2xl font-bold text-primary">{tables.reduce((sum, table) => sum + table.count, 0).toLocaleString()}</div>
        </div>
        <div className="rounded border border-border/50 bg-surface p-4">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-text-muted">
            <HardDrive className="h-3.5 w-3.5" />
            Tables tracked
          </div>
          <div className="mt-2 text-2xl font-bold text-accent">{tables.length}</div>
        </div>
      </div>
      <div className="overflow-hidden rounded border border-border/50 bg-surface">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-border/50 text-[10px] uppercase tracking-[0.18em] text-text-muted">
            <tr><th className="px-3 py-2">Table</th><th className="px-3 py-2">Rows</th><th className="px-3 py-2">Oldest</th><th className="px-3 py-2">Policy</th><th className="px-3 py-2">Calculated cutoffs</th></tr>
          </thead>
          <tbody>
            {tables.map((table) => (
              <tr key={table.name} className="border-b border-border/30 last:border-0">
                <td className="px-3 py-2 font-semibold text-text">{table.name}</td>
                <td className="px-3 py-2 text-primary">{table.count.toLocaleString()}</td>
                <td className="px-3 py-2 text-text-muted">{table.oldestAt ?? 'n/a'}</td>
                <td className="px-3 py-2 text-text-muted">{table.policy}</td>
                <td className="px-3 py-2 text-text-muted">
                  {table.cutoffs
                    ? Object.entries(table.cutoffs).map(([name, value]) => <div key={name}><span className="font-semibold">{name}:</span> {value}</div>)
                    : 'n/a'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {tables.length === 0 && <div className="p-4 text-xs text-warning">Retention data unavailable.</div>}
      </div>
    </div>
  );
}
