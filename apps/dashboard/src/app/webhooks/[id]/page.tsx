'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, type WebhookEndpoint, type WebhookDelivery } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { WebhookForm } from '../webhook-form';
import { ArrowLeft, Play, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';

function deliveryStatusVariant(status: string) {
  switch (status) {
    case 'success': return 'success' as const;
    case 'failed': return 'danger' as const;
    default: return 'warning' as const;
  }
}

export default function WebhookDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const [id, setId] = useState<string>('');
  const [endpoint, setEndpoint] = useState<WebhookEndpoint | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [deliveryTotal, setDeliveryTotal] = useState(0);
  const [deliveryPage, setDeliveryPage] = useState(1);
  const [expandedDelivery, setExpandedDelivery] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'edit' | 'deliveries'>('edit');
  const [testing, setTesting] = useState(false);
  const [redelivering, setRedelivering] = useState<string | null>(null);

  const loadEndpoint = useCallback(async (eid: string) => {
    try {
      const ep = await api.webhooks.get(eid);
      setEndpoint(ep);
    } catch {
      router.push('/webhooks');
    }
  }, [router]);

  const loadDeliveries = useCallback(async (eid: string, page: number) => {
    try {
      const res = await api.webhooks.deliveries(eid, page);
      if (res) {
        setDeliveries(res.deliveries);
        setDeliveryTotal(res.total);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    params.then(({ id: eid }) => {
      setId(eid);
      setLoading(false);
      loadEndpoint(eid);
      loadDeliveries(eid, 1);
    });
  }, [params, loadEndpoint, loadDeliveries]);

  const handleTest = async () => {
    setTesting(true);
    try {
      const result = await api.webhooks.test(id);
      if (result?.success) {
        alert('Test webhook sent successfully!');
        loadDeliveries(id, deliveryPage);
      } else {
        alert(`Test failed: ${result?.error ?? 'Unknown error'}`);
      }
    } finally {
      setTesting(false);
    }
  };

  if (loading || !endpoint) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  const totalPages = Math.ceil(deliveryTotal / 20);

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <Link href="/webhooks" className="text-xs text-text-muted hover:text-accent mb-3 inline-flex items-center gap-1">
          <ArrowLeft className="h-3 w-3" /> Back to webhooks
        </Link>
        <div className="flex items-center gap-3 mt-2">
          <h1 className="text-2xl font-semibold text-accent">{endpoint.name}</h1>
          <Badge variant={endpoint.active ? 'success' : 'default'}>
            {endpoint.active ? 'Active' : 'Inactive'}
          </Badge>
        </div>
        <p className="text-sm mt-1 text-text-muted font-mono">{endpoint.url}</p>
      </div>

      {/* Tab switcher */}
      <div className="flex items-center gap-4 mb-6 border-b border-border/30 pb-2">
        <button
          onClick={() => setTab('edit')}
          className={`text-xs uppercase tracking-wider pb-1 border-b-2 transition-colors ${
            tab === 'edit' ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text'
          }`}
        >
          Configuration
        </button>
        <button
          onClick={() => { setTab('deliveries'); loadDeliveries(id, deliveryPage); }}
          className={`text-xs uppercase tracking-wider pb-1 border-b-2 transition-colors ${
            tab === 'deliveries' ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text'
          }`}
        >
          Deliveries ({deliveryTotal})
        </button>
        <button
          onClick={handleTest}
          disabled={testing}
          className="ml-auto flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
        >
          <Play className="h-3 w-3" /> {testing ? 'Sending…' : 'Send Test'}
        </button>
      </div>

      {/* Edit tab */}
      {tab === 'edit' && <WebhookForm endpoint={endpoint} />}

      {/* Deliveries tab */}
      {tab === 'deliveries' && (
        <div>
          {deliveries.length > 0 ? (
            <div className="space-y-2">
              {deliveries.map((d) => (
                <div key={d.id} className="rounded-lg border border-border/50 bg-surface transition-all hover:border-accent/20">
                  <button
                    onClick={() => setExpandedDelivery(expandedDelivery === d.id ? null : d.id)}
                    className="w-full flex items-center gap-3 p-3 text-left"
                  >
                    {expandedDelivery === d.id ? (
                      <ChevronDown className="h-3.5 w-3.5 text-text-muted" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-text-muted" />
                    )}
                    <Badge variant={deliveryStatusVariant(d.status)}>{d.status}</Badge>
                    <code className="text-xs text-accent">{d.event}</code>
                    {d.httpStatus && (
                      <span className="text-xs text-text-muted">HTTP {d.httpStatus}</span>
                    )}
                    <span className="text-xs text-text-muted ml-auto">
                      {d.attempts} attempt{d.attempts !== 1 ? 's' : ''}
                    </span>
                    <span className="text-xs text-text-muted">
                      {new Date(d.createdAt).toLocaleString()}
                    </span>
                  </button>

                  {expandedDelivery === d.id && (
                    <div className="border-t border-border/30 p-3 space-y-3">
                      <div>
                        <span className="text-xs uppercase tracking-wider text-text-muted">Payload</span>
                        <pre className="mt-1 text-xs font-mono text-text-muted bg-bg rounded p-2 overflow-x-auto max-h-48">
                          {(() => { try { return JSON.stringify(JSON.parse(d.payload), null, 2); } catch { return d.payload; } })()}
                        </pre>
                      </div>
                      {d.response && (
                        <div>
                          <span className="text-xs uppercase tracking-wider text-text-muted">Response</span>
                          <pre className="mt-1 text-xs font-mono text-text-muted bg-bg rounded p-2 overflow-x-auto max-h-32">
                            {d.response}
                          </pre>
                        </div>
                      )}
                      {d.error && (
                        <div>
                          <span className="text-xs uppercase tracking-wider text-danger">Error</span>
                          <pre className="mt-1 text-xs font-mono text-danger/80 bg-danger/5 rounded p-2">
                            {d.error}
                          </pre>
                        </div>
                      )}
                      {d.status === 'failed' && (
                        <button
                          disabled={redelivering === d.id}
                          onClick={async () => {
                            setRedelivering(d.id);
                            try {
                              await api.webhooks.redeliver(id, d.id);
                              loadDeliveries(id, deliveryPage);
                            } catch {
                              alert('Redelivery failed');
                            } finally {
                              setRedelivering(null);
                            }
                          }}
                          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
                        >
                          <RotateCcw className="h-3 w-3" />
                          {redelivering === d.id ? 'Redelivering…' : 'Redeliver'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 pt-4">
                  <button
                    disabled={deliveryPage <= 1}
                    onClick={() => { setDeliveryPage((p) => p - 1); loadDeliveries(id, deliveryPage - 1); }}
                    className="text-xs px-3 py-1.5 rounded border border-border/50 text-text-muted hover:text-text disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <span className="text-xs text-text-muted">
                    Page {deliveryPage} of {totalPages}
                  </span>
                  <button
                    disabled={deliveryPage >= totalPages}
                    onClick={() => { setDeliveryPage((p) => p + 1); loadDeliveries(id, deliveryPage + 1); }}
                    className="text-xs px-3 py-1.5 rounded border border-border/50 text-text-muted hover:text-text disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-16 text-text-muted border border-border/50 rounded-lg bg-surface/30">
              <p>No deliveries yet</p>
              <p className="text-xs mt-1">Send a test event to see delivery results</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
