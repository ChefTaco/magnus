'use client';

import { useState } from 'react';
import { useControlNode } from '@/lib/control-node-context';
import { proxyTargetHeaders } from '@/lib/proxy-target';

const API_SOURCES = [
  { id: 'fleet', label: 'Fleet API', path: '/api/proxy/docs/openapi.json', port: 4000, needsProxy: true },
] as const;

export default function ApiDocsClient() {
  const { activeNode } = useControlNode();
  const [activeApi, setActiveApi] = useState<string>('fleet');
  const [specContent, setSpecContent] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadSpec = async (apiId: string) => {
    setActiveApi(apiId);
    setLoading(true);
    setError('');
    const source = API_SOURCES.find((s) => s.id === apiId);
    if (!source) return;

    try {
      const headers = source.needsProxy ? proxyTargetHeaders(activeNode?.url) : {};
      const res = await fetch(source.path, { headers });
      if (!res.ok) throw new Error(`Failed to load spec (${res.status})`);
      const spec = await res.json();
      setSpecContent(spec);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load API spec');
      setSpecContent(null);
    } finally {
      setLoading(false);
    }
  };

  const activeSource = API_SOURCES.find((s) => s.id === activeApi);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-text">API Documentation</h1>
        <p className="text-sm text-text-muted mt-1">
          Interactive OpenAPI documentation for all Magnus services
        </p>
      </div>

      {/* API Selector Tabs */}
      <div className="flex gap-2 border-b border-border pb-0">
        {API_SOURCES.map((source) => (
          <button
            key={source.id}
            onClick={() => loadSpec(source.id)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition border border-b-0 ${
              activeApi === source.id
                ? 'bg-surface-hover text-text border-border'
                : 'text-text-muted border-transparent hover:text-text hover:bg-surface-hover/50'
            }`}
          >
            {source.label}
            <span className="ml-2 text-xs text-text-muted">:{source.port}</span>
          </button>
        ))}
      </div>

      {/* Content */}
      {!specContent && !loading && !error && (
        <div className="text-center py-16">
          <p className="text-text-muted mb-4">Select an API above to load its documentation</p>
          <button
            onClick={() => loadSpec('fleet')}
            className="px-6 py-3 text-xs font-medium transition-all rounded-chip border border-primary/60 bg-primary/10 text-primary uppercase tracking-wider hover:bg-primary/20 hover:shadow-[0_0_12px_var(--color-glow)] disabled:opacity-50"
          >
            Load Fleet API Docs
          </button>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      )}

      {error && (
        <div className="bg-danger/10 border border-danger/50 rounded-lg p-4 text-danger">
          {error}
          <p className="text-xs mt-2 text-danger">
            Make sure the {activeSource?.label} is running on port {activeSource?.port}
          </p>
        </div>
      )}

      {specContent && !loading && (
        <div className="space-y-4">
          {/* Spec info */}
          <div className="bg-surface/50 border border-border rounded-lg p-4 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-text">
                {(specContent as Record<string, unknown>).info
                  ? ((specContent as Record<string, Record<string, string>>).info?.title ?? activeSource?.label)
                  : activeSource?.label}
              </h2>
              <p className="text-sm text-text-muted">
                {(specContent as Record<string, unknown>).info
                  ? ((specContent as Record<string, Record<string, string>>).info?.version ?? '')
                  : ''}
              </p>
            </div>
            <div className="flex gap-2">
              <a
                href={activeSource?.path}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-chip border border-border bg-surface px-3 py-1.5 text-xs uppercase tracking-wider text-text-muted transition-colors hover:border-primary/40 hover:text-text"
              >
                Raw JSON
              </a>
            </div>
          </div>

          {/* Endpoints List */}
          <div className="space-y-2">
            {Object.entries(
              (specContent as Record<string, Record<string, Record<string, Record<string, string>>>>).paths ?? {}
            ).map(([path, methods]) => (
              <div key={path} className="border border-border rounded-lg overflow-hidden">
                {Object.entries(methods).map(([method, details]) => {
                  const colors: Record<string, string> = {
                    get: 'border-primary/50 bg-primary/10 text-primary',
                    post: 'border-success/50 bg-success/10 text-success',
                    put: 'border-warning/50 bg-warning/10 text-warning',
                    patch: 'border-accent/50 bg-accent/10 text-accent',
                    delete: 'border-danger/50 bg-danger/10 text-danger',
                  };
                  return (
                    <details key={`${path}-${method}`} className="group">
                      <summary className="flex items-center gap-3 p-3 cursor-pointer hover:bg-surface-hover/50 transition">
                        <span className={`rounded-chip border px-2 py-0.5 text-[10px] font-bold uppercase ${colors[method] ?? 'border-border text-text-muted'}`}>
                          {method}
                        </span>
                        <code className="text-sm font-mono text-text">{path}</code>
                        {details.summary && (
                          <span className="text-sm text-text-muted ml-auto">{details.summary}</span>
                        )}
                      </summary>
                      <div className="px-4 pb-3 border-t border-border pt-3">
                        {details.description && (
                          <p className="text-sm text-text-muted mb-2">{details.description}</p>
                        )}
                        {details.tags && (
                          <div className="flex gap-1 flex-wrap">
                            {(details.tags as unknown as string[]).map((tag: string) => (
                              <span key={tag} className="text-xs px-2 py-0.5 bg-border-strong text-text rounded-full">
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </details>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
