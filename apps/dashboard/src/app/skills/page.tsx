'use client';

import { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Modal, inputClass } from '@/components/ui/modal';
import { api } from '@/lib/api-client';
import { useControlNode } from '@/lib/control-node-context';
import { scanSkills } from '@/app/actions/scan';
import { cn } from '@/lib/utils';
import { PageTransition, PageItem } from '@/components/ui/page-transition';
import { ScanAnimation } from '@/components/ui/scan-animation';
import {
  RefreshCw,
  Search,
  Package,
  Server,
  Tag,
  FileCode,
  ChevronDown,
  ChevronRight,
  Eye,
  Upload,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from 'lucide-react';

// ─── Types ───

interface DiscoveredSkill {
  name: string;
  version: string;
  description: string;
  author: string;
  entryPoint: string;
  dependencies: string[];
  tags: string[];
  files: Array<{ name: string; content: string }>;
}

interface NodeScanResult {
  nodeId: string;
  nodeName: string;
  status: 'scanning' | 'done' | 'error';
  skills: DiscoveredSkill[];
  error?: string;
}

// ─── Page ───

export default function SkillsPage(): React.ReactElement {
  const { activeNode } = useControlNode();
  const [scanResults, setScanResults] = useState<NodeScanResult[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [hasScanned, setHasScanned] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [viewingFile, setViewingFile] = useState<{ name: string; content: string } | null>(null);

  // Publish state
  const [publishTarget, setPublishTarget] = useState<{
    skill: DiscoveredSkill;
    nodeId: string;
    nodeName: string;
  } | null>(null);
  const [publishVersion, setPublishVersion] = useState('');
  const [publishing, setPublishing] = useState(false);

  const runScan = useCallback(async (): Promise<void> => {
    setScanning(true);
    setScanResults([]);
    setScanError(null);

    const start = Date.now();

    try {
      const res = await scanSkills(activeNode.id);
      if (res.success && Array.isArray(res.data)) {
        const results = (res.data as NodeScanResult[]).map((r) => ({
          ...r,
          status: (r.status === 'error' ? 'error' : 'done') as NodeScanResult['status'],
          skills: r.skills.map((skill) => ({
            ...skill,
            files: skill.files.map((f: string | { name: string; content: string }) =>
              typeof f === 'string' ? { name: f, content: '' } : f,
            ),
          })),
        }));
        setScanResults(results);
        // Auto-expand all nodes that have skills
        const withSkills = new Set(
          results.filter((r) => r.skills.length > 0).map((r) => r.nodeId),
        );
        // If no node has skills, expand all to show the empty listing
        setExpandedNodes(withSkills.size > 0 ? withSkills : new Set(results.map((r) => r.nodeId)));
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
  const totalSkills = scanResults.reduce(
    (sum, r) => sum + (r.status === 'done' ? r.skills.length : 0),
    0,
  );
  const nodesScanned = scanResults.filter((r) => r.status === 'done').length;
  const nodesErrored = scanResults.filter((r) => r.status === 'error').length;

  // Filter skills within nodes
  const filterSkill = (skill: DiscoveredSkill): boolean => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      skill.name.toLowerCase().includes(q) ||
      skill.description.toLowerCase().includes(q) ||
      skill.tags.some((t) => t.toLowerCase().includes(q))
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
      const manifest = {
        name: publishTarget.skill.name,
        version: publishVersion,
        description: publishTarget.skill.description,
        author: publishTarget.skill.author,
        entryPoint: publishTarget.skill.entryPoint,
        dependencies: publishTarget.skill.dependencies,
        tags: publishTarget.skill.tags,
      };

      const filesMap: Record<string, string> = {};
      for (const f of publishTarget.skill.files) {
        filesMap[f.name] = f.content;
      }

      const content = JSON.stringify({ manifest, files: filesMap }, null, 2);

      await api.library.files.create({
        name: `${publishTarget.skill.name} v${publishVersion}`,
        fileName: `${publishTarget.skill.name}-${publishVersion}.json`,
        mimeType: 'application/x-magnus-skill',
        content,
        tags: ['skill', ...publishTarget.skill.tags],
      });

      setPublishTarget(null);
      setPublishVersion('');
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
            <h1 className="text-lg font-bold uppercase tracking-wider">Skills</h1>
            <p className="text-[11px] text-text-muted uppercase tracking-wider">
              Discover and manage Hermes Agent skills across your fleet
            </p>
          </div>
          <div className="flex items-center gap-2">
            {hasScanned && !scanning && (
              <span className="text-[10px] text-text-muted uppercase tracking-wider mr-2">
                {scanResults.length} node{scanResults.length !== 1 ? 's' : ''} · {totalSkills} skill{totalSkills !== 1 ? 's' : ''}
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
            title="Scanning Nodes for Skills"
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

      {/* Search bar — only when there are skills to search */}
      {!scanning && hasScanned && totalSkills > 0 && (
        <PageItem>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              placeholder="Search skills by name, description, or tag..."
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
              const filteredSkills = result.skills.filter(filterSkill);

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
                            <Badge variant={result.skills.length > 0 ? 'success' : 'default'}>
                              {result.skills.length} skill{result.skills.length !== 1 ? 's' : ''}
                            </Badge>
                          )}
                          {result.status === 'error' && (
                            <Badge variant="danger">Error</Badge>
                          )}
                        </div>
                        {result.status === 'error' && result.error && (
                          <p className="text-[11px] text-danger mt-0.5 truncate">
                            {result.error}
                          </p>
                        )}
                        {result.status === 'done' && result.skills.length === 0 && (
                          <p className="text-[11px] text-text-muted mt-0.5">
                            No skills installed on this node
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

                    {/* Expanded skill list per node */}
                    {isExpanded && result.status === 'done' && (
                      <div className="border-t border-border/50 bg-bg/50">
                        {filteredSkills.length === 0 ? (
                          <div className="flex items-center justify-center py-8 text-center">
                            <p className="text-[11px] text-text-muted">
                              {result.skills.length === 0
                                ? 'No skills installed on this node. Deploy skills from the Library.'
                                : 'No skills match your search on this node.'}
                            </p>
                          </div>
                        ) : (
                          <div className="divide-y divide-border/30">
                            {filteredSkills.map((skill) => (
                              <div key={skill.name} className="p-4 space-y-3">
                                {/* Skill header */}
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    <Package className="h-4 w-4 text-primary" />
                                    <span className="text-xs font-bold">{skill.name}</span>
                                    <Badge variant="info">{skill.version}</Badge>
                                  </div>
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => {
                                      setPublishTarget({
                                        skill,
                                        nodeId: result.nodeId,
                                        nodeName: result.nodeName,
                                      });
                                      setPublishVersion(skill.version);
                                    }}
                                  >
                                    <Upload className="h-3 w-3 mr-1" />
                                    Publish
                                  </Button>
                                </div>

                                {/* Description */}
                                {skill.description && (
                                  <p className="text-[11px] text-text-muted">
                                    {skill.description}
                                  </p>
                                )}

                                {/* Tags */}
                                {skill.tags.length > 0 && (
                                  <div className="flex flex-wrap gap-1">
                                    {skill.tags.map((tag) => (
                                      <Badge key={tag} variant="default">
                                        <Tag className="h-2.5 w-2.5 mr-1" />
                                        {tag}
                                      </Badge>
                                    ))}
                                  </div>
                                )}

                                {/* Info grid */}
                                <div className="grid grid-cols-3 gap-3">
                                  <div className="rounded border border-border bg-surface p-2">
                                    <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-0.5">
                                      Author
                                    </p>
                                    <p className="text-[11px]">{skill.author || '—'}</p>
                                  </div>
                                  <div className="rounded border border-border bg-surface p-2">
                                    <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-0.5">
                                      Entry Point
                                    </p>
                                    <p className="text-[11px]">{skill.entryPoint || '—'}</p>
                                  </div>
                                  <div className="rounded border border-border bg-surface p-2">
                                    <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-0.5">
                                      Dependencies
                                    </p>
                                    <p className="text-[11px]">
                                      {skill.dependencies.length > 0
                                        ? skill.dependencies.join(', ')
                                        : '—'}
                                    </p>
                                  </div>
                                </div>

                                {/* Files */}
                                {skill.files.length > 0 && (
                                  <div>
                                    <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-1.5">
                                      Files ({skill.files.length})
                                    </p>
                                    <div className="space-y-1">
                                      {skill.files.map((f) => (
                                        <button
                                          key={f.name}
                                          onClick={() => setViewingFile(f)}
                                          className="flex items-center gap-2 rounded border border-border/50 px-3 py-1.5 text-xs hover:border-primary/30 hover:shadow-[0_0_20px_var(--color-glow)] transition-all w-full text-left"
                                        >
                                          <FileCode className="h-3 w-3 text-primary" />
                                          <span>{f.name}</span>
                                          <Eye className="h-3 w-3 text-text-muted ml-auto" />
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                )}
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
                  {totalSkills} skill{totalSkills !== 1 ? 's' : ''} discovered
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

      {/* File viewer modal */}
      <Modal
        open={!!viewingFile}
        onClose={() => setViewingFile(null)}
        title={viewingFile?.name ?? 'File'}
        icon={<FileCode className="h-5 w-5 text-primary" />}
        className="max-w-3xl"
      >
        <pre className="rounded border border-border bg-bg p-4 text-xs overflow-auto max-h-96 whitespace-pre-wrap">
          {viewingFile?.content || '(empty)'}
        </pre>
      </Modal>

      {/* Publish to Library modal */}
      <Modal
        open={!!publishTarget}
        onClose={() => setPublishTarget(null)}
        title="Publish to Library"
        description={publishTarget?.skill.name ?? ''}
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

          {publishTarget && (
            <div className="rounded border border-border bg-bg p-3 text-xs space-y-1">
              <p>
                <span className="text-text-muted">Source:</span>{' '}
                {publishTarget.nodeName}
              </p>
              <p>
                <span className="text-text-muted">Files:</span>{' '}
                {publishTarget.skill.files.length} files
              </p>
              <p>
                <span className="text-text-muted">Tags:</span>{' '}
                {['skill', ...publishTarget.skill.tags].join(', ')}
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
