'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { api, type WebhookEndpoint } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Plus, Webhook, Trash2, Play, ToggleLeft, ToggleRight } from 'lucide-react';

export default function WebhooksPage() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadEndpoints = async () => {
    try {
      const data = await api.webhooks.list();
      setEndpoints(data);
    } catch {
      setError('Failed to load webhooks. The API may be unavailable.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadEndpoints(); }, []);

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this webhook endpoint?')) return;
    await api.webhooks.delete(id);
    loadEndpoints();
  };

  const handleToggle = async (ep: WebhookEndpoint) => {
    await api.webhooks.update(ep.id, { active: !ep.active });
    loadEndpoints();
  };

  const handleTest = async (id: string) => {
    const result = await api.webhooks.test(id);
    if (result?.success) {
      alert('Test webhook sent successfully!');
    } else {
      alert(`Test failed: ${result?.error ?? 'Unknown error'}`);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-accent">Webhooks</h1>
          <p className="text-sm mt-1 text-text-muted">
            Manage webhook endpoints for event notifications
          </p>
        </div>
        <Link
          href="/webhooks/new"
          className="flex items-center gap-2 text-sm px-4 py-2 rounded-lg bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors"
        >
          <Plus className="h-4 w-4" /> New Webhook
        </Link>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-danger/30 bg-danger/5 p-4 text-sm text-danger">
          {error}
        </div>
      )}

      {endpoints.length > 0 ? (
        <div className="space-y-3">
          {endpoints.map((ep) => {
            const events: string[] = (() => { try { return JSON.parse(ep.events); } catch { return []; } })();
            return (
              <div
                key={ep.id}
                className="rounded-lg border border-border/50 bg-surface p-5 hover:border-accent/30 transition-all"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Webhook className="h-4 w-4 text-accent" />
                    <Link href={`/webhooks/${ep.id}`} className="text-sm font-medium text-text hover:text-accent transition-colors">
                      {ep.name}
                    </Link>
                    <Badge variant={ep.active ? 'success' : 'default'}>{ep.active ? 'Active' : 'Inactive'}</Badge>
                    <Badge variant="info">{ep.type}</Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleTest(ep.id)}
                      className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                      title="Send test event"
                    >
                      <Play className="h-3 w-3" /> Test
                    </button>
                    <button
                      onClick={() => handleToggle(ep)}
                      className="flex items-center gap-1 text-xs px-2 py-1 rounded text-text-muted hover:text-text transition-colors"
                      title={ep.active ? 'Disable' : 'Enable'}
                    >
                      {ep.active ? <ToggleRight className="h-4 w-4 text-success" /> : <ToggleLeft className="h-4 w-4" />}
                    </button>
                    <button
                      onClick={() => handleDelete(ep.id)}
                      className="flex items-center gap-1 text-xs px-2 py-1 rounded text-danger hover:bg-danger/10 transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-4 text-xs text-text-muted">
                  <span className="font-mono truncate max-w-md">{ep.url}</span>
                  <span>{ep._count?.deliveries ?? 0} deliveries</span>
                  <span>{events.length === 0 ? 'All events' : events.join(', ')}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-16 text-text-muted border border-border/50 rounded-lg bg-surface/30">
          <Webhook className="h-8 w-8 mx-auto mb-3 text-text-muted/50" />
          <p>No webhook endpoints configured</p>
          <p className="text-xs mt-1">Create an endpoint to receive event notifications</p>
        </div>
      )}
    </div>
  );
}
