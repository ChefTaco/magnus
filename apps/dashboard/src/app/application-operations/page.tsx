'use client';
import { useCallback, useEffect, useState } from 'react';
type App = {
  id: string;
  nodeId: string;
  serviceId: string;
  projectId: string;
  kind: string;
  status: string;
  observedAt: string | null;
  result: unknown;
};
type Window = {
  id: string;
  reason: string;
  nodeIds: string;
  serviceIds: string;
  actorId: string;
  startsAt: string;
  endsAt: string;
  cancelledAt: string | null;
};
async function api(path: string, body?: unknown) {
  const r = await fetch(
    `/api/proxy/${path}`,
    body
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : { cache: 'no-store' },
  );
  const v = await r.json();
  if (!r.ok) throw new Error(v.error?.message ?? `HTTP ${r.status}`);
  return v.data;
}
export default function ApplicationOperations() {
  const [apps, setApps] = useState<App[]>([]);
  const [windows, setWindows] = useState<Window[]>([]);
  const [capacity, setCapacity] = useState<unknown>();
  const [dependencies, setDependencies] = useState<unknown>();
  const [error, setError] = useState('');
  const [nodeId, setNodeId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [mount, setMount] = useState('/');
  const [report, setReport] = useState<unknown>();
  const load = useCallback(async () => {
    try {
      const [a, w, c] = await Promise.all([
        api('ops/applications'),
        api('ops/maintenance'),
        api('ops/capacity-advice'),
      ]);
      setApps(a);
      setWindows(w);
      setCapacity(c);
      setError('');
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30000);
    return () => clearInterval(timer);
  }, [load]);
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold">Application operations</h1>
      <p className="text-sm text-text-muted">
        Observed readiness, advisory GPU capacity, scoped maintenance and read-only storage
        investigations.
      </p>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <section className="rounded border border-border p-4">
        <h2>Applications</h2>
        {!apps.length && (
          <p>
            No application probes configured. Add the reviewed registry on the Control API host.
          </p>
        )}
        {apps.map((a) => (
          <article key={a.id} className="border-b border-border py-3">
            <strong>
              {a.projectId} / {a.serviceId}
            </strong>
            <p>
              <a href={`/nodes/${encodeURIComponent(a.nodeId)}`} className="underline">
                {a.nodeId}
              </a>{' '}
              · {a.status} · {a.observedAt ?? 'never observed'}
            </p>
            {a.kind === 'hive-router' && (
              <button
                className="underline"
                onClick={() => {
                  if (!window.confirm('Run one explicitly bounded inference canary?')) return;
                  void api(`ops/applications/${encodeURIComponent(a.id)}/canary`, {})
                    .then(setReport)
                    .catch((e) => setError(String(e)));
                }}
              >
                Run one inference canary
              </button>
            )}
            <details>
              <summary>Readiness evidence</summary>
              <pre className="overflow-auto text-xs">{JSON.stringify(a.result, null, 2)}</pre>
            </details>
          </article>
        ))}
      </section>
      <section className="rounded border border-border p-4">
        <h2>Maintenance</h2>
        <p className="text-xs text-text-muted">
          Suppress matching pages until expiry; observations remain available.
        </p>
        <form
          className="my-3 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void api('ops/maintenance', {
              reason,
              nodeIds: [nodeId],
              serviceIds: serviceId ? [serviceId] : [],
              startsAt: new Date().toISOString(),
              endsAt: new Date(Date.now() + minutes * 60000).toISOString(),
            })
              .then(load)
              .catch((e) => setError(String(e)));
          }}
        >
          <input
            aria-label="Node ID"
            placeholder="Node ID"
            required
            value={nodeId}
            onChange={(e) => setNodeId(e.target.value)}
          />
          <input
            aria-label="Service ID"
            placeholder="Service ID (all when empty)"
            value={serviceId}
            onChange={(e) => setServiceId(e.target.value)}
          />
          <input
            aria-label="Reason"
            placeholder="Reason"
            required
            minLength={5}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <input
            aria-label="Minutes"
            type="number"
            min={1}
            max={10080}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
          <button className="rounded border border-primary p-2">Create maintenance window</button>
        </form>
        {windows.map((w) => (
          <p key={w.id} className="py-2">
            {w.reason} · {w.nodeIds} / {w.serviceIds} · {w.actorId} ·{' '}
            {w.cancelledAt
              ? 'cancelled'
              : Date.parse(w.endsAt) <= Date.now()
                ? 'expired'
                : `ends ${w.endsAt}`}{' '}
            {!w.cancelledAt && Date.parse(w.endsAt) > Date.now() && (
              <button
                className="underline"
                onClick={() =>
                  void api(`ops/maintenance/${w.id}/cancel`, {})
                    .then(load)
                    .catch((e) => setError(String(e)))
                }
              >
                Cancel window
              </button>
            )}
          </p>
        ))}
      </section>
      <details className="rounded border border-border p-4">
        <summary>GPU capacity advice</summary>
        <pre className="overflow-auto text-xs">{JSON.stringify(capacity, null, 2)}</pre>
      </details>
      <section className="rounded border border-border p-4">
        <h2>Dependency observations</h2>
        <button
          className="underline"
          onClick={() =>
            void api('dependencies')
              .then(setDependencies)
              .catch((e) => setError(String(e)))
          }
        >
          Load observed connections and collection status
        </button>
        <pre className="overflow-auto text-xs">
          {dependencies ? JSON.stringify(dependencies, null, 2) : ''}
        </pre>
      </section>
      <section className="rounded border border-border p-4">
        <h2>Storage evidence</h2>
        <p className="text-xs text-text-muted">
          Uses the node ID above. Local scans stop after 10 seconds; shared volumes return their
          identity and storage-side accounting guidance.
        </p>
        <input aria-label="Mount" value={mount} onChange={(e) => setMount(e.target.value)} />
        <button
          className="ml-2 underline"
          disabled={!nodeId}
          onClick={() =>
            void api(
              `ops/storage-evidence/${encodeURIComponent(nodeId)}?${new URLSearchParams({ mount })}`,
            )
              .then(setReport)
              .catch((e) => setError(String(e)))
          }
        >
          Investigate mount
        </button>
        <pre className="overflow-auto text-xs">{report ? JSON.stringify(report, null, 2) : ''}</pre>
      </section>
    </div>
  );
}
