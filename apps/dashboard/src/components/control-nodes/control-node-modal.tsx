'use client';

import { useState, useEffect, useRef } from 'react';
import { Server, Download } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { useControlNode } from '@/lib/control-node-context';
import { proxyTargetHeaders } from '@/lib/proxy-target';
import { api } from '@/lib/api-client';
import type { ControlNode } from '@/lib/control-nodes';

import { NodeListPanel } from './node-list-panel';
import { NodeFormPanel } from './node-form-panel';
import type { FormMode, TestResult } from './node-form-panel';
import { UpdatePanel } from './update-panel';
import type { UpdateLoading } from './update-panel';

type ModalView = 'list' | 'form' | 'update';

interface ControlNodeModalProps {
  open: boolean;
  onClose: () => void;
  /** If set, open directly in edit mode for this node. */
  editNodeId?: string | null;
  /** If true, open directly in create mode. */
  createMode?: boolean;
}

export function ControlNodeModal({
  open,
  onClose,
  editNodeId,
  createMode,
}: ControlNodeModalProps): React.ReactElement | null {
  const { nodes, addNode, updateNode, removeNode, switchNode, activeNode } = useControlNode();

  const [view, setView] = useState<ModalView>('list');
  const [formMode, setFormMode] = useState<FormMode>('create');
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form fields
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [apiSecret, setApiSecret] = useState('');

  // Simplified create fields — hostname drives name, URL, and SSH host
  const [hostname, setHostname] = useState('');
  const [controlApiPort, setControlApiPort] = useState('4000');

  // State
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult>('idle');

  // Keep a stable ref to the latest nodes so the effect below doesn't
  // re-run (and reset form / steal focus) every time the nodes array
  // reference changes.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Decide initial view based on props
  useEffect(() => {
    if (!open) return;
    setError(null);
    setTestResult('idle');

    if (createMode) {
      setView('form');
      setFormMode('create');
      setEditingId(null);
      resetForm();
    } else if (editNodeId) {
      const node = nodesRef.current.find((n) => n.id === editNodeId);
      if (node) {
        setView('form');
        setFormMode('edit');
        setEditingId(node.id);
        setName(node.name);
        setUrl(node.url);
        setApiSecret('');
      }
    } else {
      setView('list');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, createMode, editNodeId]);

  function resetForm(): void {
    setName('');
    setUrl('');
    setApiSecret('');
    setHostname('');
    setControlApiPort('4000');
    setError(null);
    setTestResult('idle');
  }

  function handleClose(): void {
    setApiSecret('');
    setError(null);
    setSaving(false);
    setTestResult('idle');
    onClose();
  }

  function handleOpenCreate(): void {
    setView('form');
    setFormMode('create');
    setEditingId(null);
    resetForm();
  }

  function handleOpenEdit(node: ControlNode): void {
    setView('form');
    setFormMode('edit');
    setEditingId(node.id);
    setName(node.name);
    setUrl(node.url);
    setApiSecret('');
    setError(null);
    setTestResult('idle');
  }

  async function handleDelete(id: string): Promise<void> {
    try {
      await removeNode(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    }
  }

  async function handleTestConnection(): Promise<void> {
    const effectiveHostname = hostname.trim();
    const testUrl = formMode === 'create'
      ? `https://${effectiveHostname}:${parseInt(controlApiPort, 10) || 4000}`
      : url;
    if (!testUrl || (formMode === 'create' && !effectiveHostname)) {
      setError('Hostname/URL is required to test connection');
      return;
    }
    setTestResult('testing');
    setError(null);
    try {
      // Route through Next.js proxy to avoid browser TLS rejection
      const headers = proxyTargetHeaders(testUrl);
      const res = await fetch('/api/proxy/health', {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        setTestResult('ok');
      } else {
        setTestResult('fail');
        setError(`Connection failed: HTTP ${res.status}`);
      }
    } catch (err) {
      setTestResult('fail');
      setError(err instanceof Error ? err.message : 'Connection failed');
    }
  }

  async function handleSave(): Promise<void> {
    // In create mode, derive URL from hostname + controlApiPort; name defaults to hostname
    const effectiveName = formMode === 'create'
      ? (name.trim() || hostname.trim())
      : name.trim();
    const effectiveUrl = formMode === 'create'
      ? `https://${hostname.trim()}:${parseInt(controlApiPort, 10) || 4000}`
      : url.trim();

    if (formMode === 'create' && !hostname.trim()) {
      setError('Hostname is required');
      return;
    }
    if (formMode === 'edit' && !name.trim()) {
      setError('Name is required');
      return;
    }
    if (formMode === 'edit' && !url.trim()) {
      setError('URL is required');
      return;
    }

    setSaving(true);
    setError(null);
    const apiSecretForRequest = apiSecret;
    setApiSecret('');

    try {
      if (formMode === 'create') {
        const created = await addNode({
          name: effectiveName,
          url: effectiveUrl,
          ...(apiSecretForRequest ? { apiSecret: apiSecretForRequest } : {}),
        });
        switchNode(created.id);
      } else if (editingId) {
        await updateNode(editingId, {
          name: name.trim(),
          url: url.trim(),
          ...(apiSecretForRequest ? { apiSecret: apiSecretForRequest } : {}),
        });
      }
      setSaving(false);
      if (nodes.length === 0 && formMode === 'create') {
        // First node added — close modal
        handleClose();
      } else {
        setView('list');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
      setSaving(false);
    }
  }

  // ── Update view state ──
  const [updateStatus, setUpdateStatus] = useState<{
    controlApiVersion: string;
    agentVersion: string;
    repoRoot: string;
    gitBranch: string | null;
    gitCommit: string | null;
    lastChecked: string | null;
    isGitRepo: boolean;
  } | null>(null);
  const [updateCheck, setUpdateCheck] = useState<{
    available: boolean;
    behindBy: number;
    currentCommit: string;
    remoteCommit: string;
    error?: string;
  } | null>(null);
  const [updateLoading, setUpdateLoading] = useState<UpdateLoading>('idle');
  const [updateResult, setUpdateResult] = useState<string | null>(null);

  function handleOpenUpdate(): void {
    setView('update');
    setError(null);
    setUpdateCheck(null);
    setUpdateResult(null);
    setUpdateLoading('idle');
    // Fetch current status
    void (async () => {
      try {
        const res = await api.selfUpdate.status();
        if (res.success) setUpdateStatus(res.data ?? null);
      } catch {
        // ignore — might not be reachable
      }
    })();
  }

  async function handleCheckUpdates(): Promise<void> {
    setUpdateLoading('checking');
    setError(null);
    setUpdateResult(null);
    try {
      const res = await api.selfUpdate.check();
      if (res.success) {
        setUpdateCheck(res.data ?? null);
        if (res.data!.error) {
          setError(res.data!.error);
        } else if (!res.data!.available) {
          setUpdateResult('Already up to date.');
        }
      }
    } catch (err) {
      let message = 'Failed to check for updates';
      if (err && typeof err === 'object' && 'response' in err) {
        try {
          const body = await (err as { response: Response }).response.json() as { error?: { message?: string } };
          if (body?.error?.message) message = body.error.message;
        } catch { /* ignore parse errors */ }
      } else if (err instanceof Error) {
        message = err.message;
      }
      setError(message);
    } finally {
      setUpdateLoading('idle');
    }
  }

  async function handleApplyUpdate(restart: boolean): Promise<void> {
    setUpdateLoading('applying');
    setError(null);
    setUpdateResult(null);
    try {
      const res = await api.selfUpdate.apply(restart);
      if (res.success) {
        const d = res.data;
        if (!d) return;
        if (d.updated) {
          setUpdateResult(
            `Updated from v${d.previousVersion} → v${d.currentVersion}` +
            (d.restart?.scheduled ? `. Restarting via ${d.restart.method}…` : '. Restart manually to apply.'),
          );
        } else {
          setUpdateResult('Code pulled but no version change detected.');
        }
        setUpdateCheck(null);
        // Refresh status
        const statusRes = await api.selfUpdate.status();
        if (statusRes.success) setUpdateStatus(statusRes.data ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setUpdateLoading('idle');
    }
  }

  async function handleRestart(): Promise<void> {
    setUpdateLoading('restarting');
    setError(null);
    try {
      const res = await api.selfUpdate.restart();
      if (res.success) {
        setUpdateResult(`Restart scheduled via ${res.data!.method}. Reconnecting shortly…`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restart failed');
    } finally {
      setUpdateLoading('idle');
    }
  }

  if (!open) return null;

  const modalTitle =
    view === 'list'
      ? 'Control Nodes'
      : view === 'update'
        ? 'Update Control Node'
        : formMode === 'create'
            ? 'Add Control Node'
            : 'Edit Control Node';

  const modalDescription =
    view === 'list'
      ? 'Manage remote Control API endpoints'
      : view === 'update'
        ? `Update the active Control Node (${activeNode.name})`
        : formMode === 'create'
            ? 'Connect to a remote Control API instance'
            : 'Update control node settings';

  const modalIcon =
    view === 'update' ? (
      <Download className="h-5 w-5 text-primary" />
    ) : (
      <Server className="h-5 w-5 text-primary" />
    );

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={modalTitle}
      description={modalDescription}
      icon={modalIcon}
      className="max-w-xl"
    >
      {error && (
        <div className="mb-4 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">
          {error}
        </div>
      )}

      {view === 'list' && (
        <NodeListPanel
          nodes={nodes}
          activeNodeId={activeNode.id}
          onEdit={handleOpenEdit}
          onDelete={(id) => void handleDelete(id)}
          onAdd={handleOpenCreate}
          onUpdate={handleOpenUpdate}
        />
      )}

      {view === 'form' && (
        <NodeFormPanel
          formMode={formMode}
          name={name}
          setName={setName}
          apiSecret={apiSecret}
          setApiSecret={setApiSecret}
          hasStoredApiSecret={Boolean(editingId && nodes.find((node) => node.id === editingId)?.hasApiSecret)}
          hostname={hostname}
          setHostname={setHostname}
          controlApiPort={controlApiPort}
          setControlApiPort={setControlApiPort}
          url={url}
          setUrl={(v) => {
            setUrl(v);
            setTestResult('idle');
          }}
          saving={saving}
          testResult={testResult}
          onTestConnection={() => void handleTestConnection()}
          onSave={() => void handleSave()}
          onCancel={() => {
            if (nodes.length > 0) {
              setApiSecret('');
              setView('list');
              setError(null);
            } else {
              handleClose();
            }
          }}
        />
      )}

      {view === 'update' && (
        <UpdatePanel
          activeNodeName={activeNode.name}
          updateStatus={updateStatus}
          updateCheck={updateCheck}
          updateLoading={updateLoading}
          updateResult={updateResult}
          onCheckUpdates={() => void handleCheckUpdates()}
          onApplyUpdate={(restart) => void handleApplyUpdate(restart)}
          onRestart={() => void handleRestart()}
          onBack={() => setView('list')}
        />
      )}
    </Modal>
  );
}
