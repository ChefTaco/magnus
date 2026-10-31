'use client';

import { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Modal, inputClass } from '@/components/ui/modal';
import { api } from '@/lib/api-client';
import { agentDisabledMessage } from '@/lib/agent-privilege';
import { useControlNode } from '@/lib/control-node-context';
import { scanCron } from '@/app/actions/scan';
import { cn } from '@/lib/utils';
import { PageTransition, PageItem } from '@/components/ui/page-transition';
import { ScanAnimation } from '@/components/ui/scan-animation';
import {
  RefreshCw,
  Search,
  Clock,
  Server,
  ChevronDown,
  ChevronRight,
  Upload,
  Loader2,
  Terminal,
  Calendar,
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from 'lucide-react';

// ─── Types ───

interface DiscoveredCronJob {
  user?: string;
  name: string;
  schedule: string;
  command: string;
}

interface NodeCronResult {
  nodeId: string;
  nodeName: string;
  status: 'scanning' | 'done' | 'error';
  jobs: DiscoveredCronJob[];
  error?: string;
}

// ─── Helpers ───

function describeSchedule(schedule: string): string {
  const parts = schedule.split(/\s+/);
  if (parts.length < 5) return schedule;

  const [min, hour, dom, mon, dow] = parts;

  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*')
    return 'Every minute';
  if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*')
    return 'Every hour';
  if (
    min === '0' &&
    hour === '0' &&
    dom === '*' &&
    mon === '*' &&
    dow === '*'
  )
    return 'Daily at midnight';
  if (min?.startsWith('*/'))
    return `Every ${min.slice(2)} minutes`;
  if (hour?.startsWith('*/'))
    return `Every ${hour.slice(2)} hours`;

  return schedule;
}

// ─── Page ───

export default function CronPage(): React.ReactElement {
  const { activeNode } = useControlNode();
  const [scanResults, setScanResults] = useState<NodeCronResult[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [hasScanned, setHasScanned] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  // Publish state
  const [publishTarget, setPublishTarget] = useState<{
    job: DiscoveredCronJob;
    nodeId: string;
    nodeName: string;
  } | null>(null);
  const [publishVersion, setPublishVersion] = useState('1.0.0');
  const [publishDescription, setPublishDescription] = useState('');
  const [publishing, setPublishing] = useState(false);

  const runScan = useCallback(async (): Promise<void> => {
    setScanning(true);
    setScanResults([]);
    setScanError(null);

    const start = Date.now();

    try {
      const res = await scanCron(activeNode.id);
      if (res.success && Array.isArray(res.data)) {
        const results = (res.data as NodeCronResult[]).map((r) => ({
          ...r,
          status: (r.status === 'error' ? 'error' : 'done') as NodeCronResult['status'],
        }));
        setScanResults(results);
        // Auto-expand all nodes that have jobs
        const withJobs = new Set(
          results.filter((r) => r.jobs.length > 0).map((r) => r.nodeId),
        );
        // If no node has jobs, expand all to show the empty listing
        setExpandedNodes(withJobs.size > 0 ? withJobs : new Set(results.map((r) => r.nodeId)));
      } else {
        setScanError(
          (res as { error?: { message?: string } }).error?.message ?? 'Scan returned unsuccessful response',
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Scan request failed';
      setScanError(message);
    } finally {
      const elapsed = Date.now() - start;
      const MIN_SCAN_MS = 1500;
      if (elapsed < MIN_SCAN_MS) {
        await new Promise((r) => setTimeout(r, MIN_SCAN_MS - elapsed));
      }
      setScanning(false);
      setHasScanned(true);
    }
  }, [activeNode]);

  useEffect(() => {
    if (activeNode) void runScan();
  }, [activeNode, runScan]);

  // Compute totals
  const totalJobs = scanResults.reduce(
    (sum, r) => sum + (r.status === 'done' ? r.jobs.length : 0),
    0,
  );
  const nodesScanned = scanResults.filter((r) => r.status === 'done').length;
  const nodesErrored = scanResults.filter((r) => r.status === 'error').length;

  // Filter jobs within nodes
  const filterJob = (job: DiscoveredCronJob): boolean => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      job.name.toLowerCase().includes(q) ||
      job.command.toLowerCase().includes(q) ||
      job.schedule.toLowerCase().includes(q) ||
      (job.user?.toLowerCase().includes(q) ?? false)
    );
  };

  const toggleNode = (nodeId: string): void => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const handlePublish = async (): Promise<void> => {
    if (!publishTarget || !publishVersion) return;
    setPublishing(true);

    try {
      const content = JSON.stringify(
        {
          name: publishTarget.job.name,
          version: publishVersion,
          schedule: publishTarget.job.schedule,
          command: publishTarget.job.command,
          description: publishDescription,
        },
        null,
        2,
      );

      await api.library.files.create({
        name: `${publishTarget.job.name} v${publishVersion}`,
        fileName: `${publishTarget.job.name}-${publishVersion}.json`,
        mimeType: 'application/x-magnus-cronjob',
        content,
        tags: ['cronjob', 'cron'],
      });

      setPublishTarget(null);
      setPublishVersion('1.0.0');
      setPublishDescription('');
    } catch {
      // error
    } finally {
      setPublishing(false);
    }
  };

  return (
    <PageTransition className="space-y-6">
      {/* Header */}
      <PageItem>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold uppercase tracking-wider">Cron Jobs</h1>
            <p className="text-[11px] text-text-muted uppercase tracking-wider">
              Discover and manage scheduled jobs across your fleet
            </p>
          </div>
          <div className="flex items-center gap-2">
            {hasScanned && !scanning && (
              <span className="text-[10px] text-text-muted uppercase tracking-wider mr-2">
                {scanResults.length} node{scanResults.length !== 1 ? 's' : ''} · {totalJobs} job{totalJobs !== 1 ? 's' : ''}
                {nodesErrored > 0 && ` · ${nodesErrored} error${nodesErrored !== 1 ? 's' : ''}`}
              </span>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void runScan()}
              disabled={scanning}
            >
              <RefreshCw
                className={cn('h-3.5 w-3.5 mr-1.5', scanning && 'animate-spin')}
              />
              {scanning ? 'Scanning...' : 'Rescan'}
            </Button>
          </div>
        </div>
      </PageItem>

      {/* Scan animation while loading */}
      {scanning && (
        <PageItem>
          <ScanAnimation
            title="Scanning Nodes for Cron Jobs"
            description="Probing all online nodes..."
            nodes={scanResults.map((r) => ({
              nodeId: r.nodeId,
              nodeName: r.nodeName,
              status: r.status,
              error: r.error,
            }))}
            scanning={true}
          />
        </PageItem>
      )}

      {/* Search bar — only when there are jobs to search */}
      {!scanning && hasScanned && totalJobs > 0 && (
        <PageItem>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              placeholder="Search jobs by name, command, or schedule..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={cn(inputClass, 'pl-9')}
            />
          </div>
        </PageItem>
      )}

      {/* Global error state */}
      {!scanning && hasScanned && scanError && (
        <PageItem>
          <Card>
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <AlertTriangle className="h-10 w-10 text-danger/60 mb-3" />
              <p className="text-xs font-bold text-danger mb-1">Scan Failed</p>
              <p className="text-[11px] text-text-muted max-w-md">{scanError}</p>
              <Button
                variant="secondary"
                size="sm"
                className="mt-4"
                onClick={() => void runScan()}
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                Retry Scan
              </Button>
            </div>
          </Card>
        </PageItem>
      )}

      {/* Per-node results listing */}
      {!scanning && hasScanned && !scanError && (
        <>
          {scanResults.length === 0 ? (
            <PageItem>
              <Card>
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Server className="h-10 w-10 text-text-muted/40 mb-3" />
                  <p className="text-xs text-text-muted">
                    No online nodes found to scan. Ensure at least one node agent
                    is running and connected.
                  </p>
                </div>
              </Card>
            </PageItem>
          ) : (
            scanResults.map((result) => {
              const isExpanded = expandedNodes.has(result.nodeId);
              const filteredJobs = result.jobs.filter(filterJob);

              return (
                <PageItem key={result.nodeId}>
                  <Card className="overflow-hidden">
                    {/* Node header */}
                    <button
                      onClick={() => toggleNode(result.nodeId)}
                      className="w-full flex items-center gap-4 p-4 text-left hover:bg-surface-hover transition-all"
                    >
                      <div className="flex h-9 w-9 items-center justify-center rounded border border-primary/30 bg-primary/5 shrink-0">
                        <Server className="h-4 w-4 text-primary" />
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold uppercase tracking-wider">
                            {result.nodeName}
                          </span>
                          {result.status === 'done' && (
                            <Badge variant={result.jobs.length > 0 ? 'success' : 'default'}>
                              {result.jobs.length} job{result.jobs.length !== 1 ? 's' : ''}
                            </Badge>
                          )}
                          {result.status === 'error' && (
                            agentDisabledMessage(result.error)
                              ? <Badge variant="default">Disabled</Badge>
                              : <Badge variant="danger">Error</Badge>
                          )}
                        </div>
                        {result.status === 'error' && result.error && (
                          <p className={cn('text-[11px] mt-0.5 truncate', agentDisabledMessage(result.error) ? 'text-text-muted' : 'text-danger')}>
                            {agentDisabledMessage(result.error) ?? result.error}
                          </p>
                        )}
                        {result.status === 'done' && result.jobs.length === 0 && (
                          <p className="text-[11px] text-text-muted mt-0.5">
                            No cron jobs found on this node
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {result.status === 'done' ? (
                          <CheckCircle2 className="h-4 w-4 text-success" />
                        ) : (
                          <XCircle className="h-4 w-4 text-danger" />
                        )}
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4 text-text-muted" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-text-muted" />
                        )}
                      </div>
                    </button>

                    {/* Expanded job list per node */}
                    {isExpanded && result.status === 'done' && (
                      <div className="border-t border-border/50 bg-bg/50">
                        {filteredJobs.length === 0 ? (
                          <div className="flex items-center justify-center py-8 text-center">
                            <p className="text-[11px] text-text-muted">
                              {result.jobs.length === 0
                                ? 'No cron jobs found on this node.'
                                : 'No jobs match your search on this node.'}
                            </p>
                          </div>
                        ) : (
                          <div className="divide-y divide-border/30">
                            {filteredJobs.map((job, jobIdx) => (
                              <div key={`${job.name}-${jobIdx}`} className="p-4 space-y-3">
                                {/* Job header */}
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    <Clock className="h-4 w-4 text-primary" />
                                    <span className="text-xs font-bold">{job.name}</span>
                                    {job.user && (
                                      <Badge variant="default">{job.user}</Badge>
                                    )}
                                    <Badge variant="info">{job.schedule}</Badge>
                                  </div>
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => {
                                      setPublishTarget({
                                        job,
                                        nodeId: result.nodeId,
                                        nodeName: result.nodeName,
                                      });
                                      setPublishVersion('1.0.0');
                                      setPublishDescription('');
                                    }}
                                  >
                                    <Upload className="h-3 w-3 mr-1" />
                                    Publish
                                  </Button>
                                </div>

                                {/* Schedule readable */}
                                <div className="flex items-center gap-1 text-[11px] text-text-muted">
                                  <Calendar className="h-3 w-3" />
                                  {describeSchedule(job.schedule)}
                                </div>

                                {/* Command */}
                                <div className="flex items-start gap-2 rounded border border-border bg-surface p-3">
                                  <Terminal className="h-3.5 w-3.5 text-primary mt-0.5 shrink-0" />
                                  <pre className="text-xs whitespace-pre-wrap break-all flex-1">
                                    {job.command}
                                  </pre>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </Card>
                </PageItem>
              );
            })
          )}

          {/* Scan summary footer */}
          {scanResults.length > 0 && (
            <PageItem>
              <div className="flex items-center justify-between text-[10px] text-text-muted uppercase tracking-wider">
                <span>
                  {nodesScanned} node{nodesScanned !== 1 ? 's' : ''} scanned ·{' '}
                  {totalJobs} job{totalJobs !== 1 ? 's' : ''} discovered
                </span>
                {nodesErrored > 0 && (
                  <span className="text-danger">
                    {nodesErrored} node{nodesErrored !== 1 ? 's' : ''} unreachable
                  </span>
                )}
              </div>
            </PageItem>
          )}
        </>
      )}

      {/* Publish to Library modal */}
      <Modal
        open={!!publishTarget}
        onClose={() => setPublishTarget(null)}
        title="Publish to Library"
        description={publishTarget?.job.name ?? ''}
        icon={<Upload className="h-5 w-5 text-primary" />}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider mb-1.5">
              Version <span className="text-accent">*</span>
            </label>
            <input
              type="text"
              value={publishVersion}
              onChange={(e) => setPublishVersion(e.target.value)}
              placeholder="1.0.0"
              className={inputClass}
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider mb-1.5">
              Description
            </label>
            <input
              type="text"
              value={publishDescription}
              onChange={(e) => setPublishDescription(e.target.value)}
              placeholder="What does this cron job do?"
              className={inputClass}
            />
          </div>

          {publishTarget && (
            <div className="rounded border border-border bg-bg p-3 text-xs space-y-1">
              <p>
                <span className="text-text-muted">Source:</span>{' '}
                {publishTarget.nodeName}
              </p>
              <p>
                <span className="text-text-muted">Schedule:</span>{' '}
                {publishTarget.job.schedule}
              </p>
              <p>
                <span className="text-text-muted">Command:</span>{' '}
                <span className="text-primary">{publishTarget.job.command}</span>
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPublishTarget(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handlePublish()}
              disabled={publishing || !publishVersion}
            >
              {publishing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                  Publishing...
                </>
              ) : (
                <>
                  <Upload className="h-3.5 w-3.5 mr-1.5" />
                  Publish
                </>
              )}
            </Button>
          </div>
        </div>
      </Modal>
    </PageTransition>
  );
}
