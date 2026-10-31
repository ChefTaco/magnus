'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge, statusVariant } from '@/components/ui/badge';
import { NodeSelector } from '@/components/ui/node-selector';
import { api } from '@/lib/api-client';
import { formatDate } from '@/lib/utils';
import { Search, Loader2, Play, Square } from 'lucide-react';
import { PageTransition, PageItem } from '@/components/ui/page-transition';

interface LogRow {
  id: string;
  nodeId: string;
  source: string;
  level: string;
  message: string;
  timestamp: string;
}

const MAX_LIVE_LOGS = 500;

export default function LogsPage(): React.ReactElement {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [nodeFilter, setNodeFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('');
  const [isLive, setIsLive] = useState(false);
  const [liveCount, setLiveCount] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const queryLogs = async (): Promise<void> => {
    setLoading(true);
    try {
      const query: Record<string, unknown> = { limit: 200 };
      if (search) query['search'] = search;
      if (nodeFilter) query['nodeId'] = nodeFilter;
      if (levelFilter) query['level'] = levelFilter;

      const res = await api.logs.query(query);
      const data = res.data as unknown as { logs: LogRow[] };
      setLogs(data.logs);
    } catch {
      // API error
    } finally {
      setLoading(false);
    }
  };

  const stopLiveTail = useCallback((): void => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsLive(false);
  }, []);

  const startLiveTail = useCallback((): void => {
    // Stop any existing stream
    if (abortRef.current) abortRef.current.abort();

    const controller = new AbortController();
    abortRef.current = controller;
    setIsLive(true);
    setLiveCount(0);
    setLogs([]); // clear previous search results

    // Build SSE URL with filters
    const params = new URLSearchParams();
    if (nodeFilter) params.set('nodeIds', nodeFilter);
    if (levelFilter) params.set('levels', levelFilter);
    const qs = params.toString();
    const url = `/api/proxy/logs/stream${qs ? `?${qs}` : ''}`;

    const headers = api.getAuthHeaders();
    headers['Accept'] = 'text/event-stream';

    // Use fetch-based SSE reader (allows custom headers unlike native EventSource)
    void (async () => {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
          cache: 'no-store',
        });

        if (!response.ok || !response.body) {
          console.error('SSE connection failed:', response.status);
          setIsLive(false);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Parse SSE lines
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? ''; // keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith('data:')) {
              const data = line.slice(5).trim();
              if (!data) continue; // heartbeat

              try {
                const entry = JSON.parse(data) as LogRow;
                setLogs((prev) => {
                  const next = [entry, ...prev];
                  return next.length > MAX_LIVE_LOGS ? next.slice(0, MAX_LIVE_LOGS) : next;
                });
                setLiveCount((c) => c + 1);
              } catch {
                // invalid JSON — skip
              }
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // Expected when stopping live tail
          return;
        }
        console.error('SSE stream error:', err instanceof Error ? err.message : 'Unknown');
      } finally {
        setIsLive(false);
      }
    })();
  }, [nodeFilter, levelFilter]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  return (
    <PageTransition className="space-y-6">
      <PageItem>
      <div>
        <h1 className="text-lg font-bold uppercase tracking-wider">Log Explorer</h1>
        <p className="mt-1 text-[11px] text-text-muted uppercase tracking-wider">
          Search and browse logs from all Magnus nodes
        </p>
      </div>
      </PageItem>

      {/* Filters */}
      <PageItem>
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1">
            <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Search</label>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search log messages…"
              className="w-full rounded border border-border bg-bg px-3 py-2 text-xs outline-none focus:border-primary focus:shadow-[0_0_8px_var(--color-glow)] transition-all"
              onKeyDown={(e) => e.key === 'Enter' && !isLive && void queryLogs()}
              disabled={isLive}
            />
          </div>
          <div className="w-48">
            <NodeSelector
              value={nodeFilter}
              onChange={(v) => setNodeFilter(Array.isArray(v) ? v[0] ?? '' : v)}
              label="Node"
              placeholder="All nodes"
            />
          </div>
          <div className="w-28">
            <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Level</label>
            <select
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value)}
              className="w-full rounded border border-border bg-bg px-3 py-2 text-xs outline-none focus:border-primary focus:shadow-[0_0_8px_var(--color-glow)] transition-all"
            >
              <option value="">All</option>
              <option value="debug">Debug</option>
              <option value="info">Info</option>
              <option value="warn">Warn</option>
              <option value="error">Error</option>
              <option value="fatal">Fatal</option>
            </select>
          </div>
          <Button onClick={() => void queryLogs()} disabled={loading || isLive}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Search
          </Button>
          {isLive ? (
            <Button onClick={stopLiveTail} variant="danger">
              <Square className="h-4 w-4" />
              Stop
            </Button>
          ) : (
            <Button onClick={startLiveTail} variant="success">
              <Play className="h-4 w-4" />
              Live Tail
            </Button>
          )}
        </div>
      </Card>
      </PageItem>

      {/* Results */}
      <PageItem>
      <Card title={isLive ? `Live Tail (${liveCount} received)` : `Logs (${logs.length})`}>
        {isLive && (
          <div className="mb-2 flex items-center gap-2 text-[11px] text-success">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            Streaming logs in real-time…
          </div>
        )}
        {logs.length === 0 ? (
          <div className="py-8 text-center text-[11px] text-text-muted">
            {loading ? 'Searching…' : isLive ? 'Waiting for incoming logs…' : 'Run a search to view logs.'}
          </div>
        ) : (
          <div className="max-h-[600px] space-y-1 overflow-y-auto text-[11px]">
            {logs.map((log, idx) => {
              const levelColor = log.level === 'error' || log.level === 'fatal' ? 'border-l-danger' :
                log.level === 'warn' ? 'border-l-warning' :
                log.level === 'info' ? 'border-l-primary' : 'border-l-border';
              return (
                <div
                  key={log.id || `live-${idx}`}
                  className={`flex gap-3 rounded px-2 py-1 hover:bg-surface-hover border-l-2 ${levelColor} transition-colors`}
                >
                  <span className="flex-shrink-0 text-text-muted">{formatDate(log.timestamp)}</span>
                  <Badge variant={statusVariant(log.level.toUpperCase())} className="flex-shrink-0 text-[10px]">
                    {log.level.toUpperCase()}
                  </Badge>
                  <span className="flex-shrink-0 text-primary/60">[{log.source}]</span>
                  <span className="break-all text-text">{log.message}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      </PageItem>
    </PageTransition>
  );
}
