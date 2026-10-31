'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Modal, FormField, inputClass, selectClass } from '@/components/ui/modal';
import { api } from '@/lib/api-client';
import { Server, Loader2 } from 'lucide-react';

interface NodeData {
  id: string;
  name: string;
  hostname: string;
  ipAddress: string;
  port: number;
  status: string;
  os: string;
  arch: string;
  tags: string;
  metadata: string;
}

interface EditNodeModalProps {
  open: boolean;
  node: NodeData | null;
  onClose: () => void;
  onSaved: () => void;
}

export function EditNodeModal({ open, node, onClose, onSaved }: EditNodeModalProps): React.ReactElement | null {
  const [name, setName] = useState('');
  const [tags, setTags] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (node) {
      setName(node.name);
      try {
        const parsed = JSON.parse(node.tags) as string[];
        setTags(parsed.join(', '));
      } catch {
        setTags('');
      }
      setStatus(node.status);
      setError('');
    }
  }, [node]);

  const handleSave = async (): Promise<void> => {
    if (!node || !name.trim()) return;
    setSaving(true);
    setError('');

    try {
      const tagArray = tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      await api.nodes.update(node.id, {
        name: name.trim(),
        tags: tagArray,
        status: status.toUpperCase(),
      });
      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update node');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = (): void => {
    setError('');
    setSaving(false);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Edit Node"
      description={node ? `${node.hostname}` : ''}
      icon={<Server className="h-5 w-5 text-primary" />}
    >
      <div className="space-y-4">
        <FormField label="Name" required>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </FormField>

        <FormField label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectClass}>
            <option value="ONLINE">ONLINE</option>
            <option value="OFFLINE">OFFLINE</option>
            <option value="DEGRADED">DEGRADED</option>
            <option value="PROVISIONING">PROVISIONING</option>
            <option value="MAINTENANCE">MAINTENANCE</option>
          </select>
        </FormField>

        <FormField label="Tags">
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="web, production, us-east"
            className={inputClass}
          />
          <p className="mt-1 text-xs text-text-muted">Comma-separated list of tags</p>
        </FormField>

        {error && (
          <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving || !name.trim()}
            icon={saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

interface RegisterNodeModalProps {
  open: boolean;
  onClose: () => void;
  onRegistered: () => void;
}

export function RegisterNodeModal({ open, onClose, onRegistered }: RegisterNodeModalProps): React.ReactElement | null {
  const [name, setName] = useState('');
  const [hostname, setHostname] = useState('');
  const [port, setPort] = useState('4100');
  const [os, setOs] = useState('linux');
  const [arch, setArch] = useState('x86_64');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleRegister = async (): Promise<void> => {
    if (!name.trim() || !hostname.trim()) return;
    setSaving(true);
    setError('');

    try {
      const tagArray = tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      await api.nodes.register({
        name: name.trim(),
        hostname: hostname.trim(),
        ipAddress: hostname.trim(),
        port: Number(port) || 4100,
        os,
        arch,
        tags: tagArray,
        agentVersion: process.env['NEXT_PUBLIC_AGENT_VERSION'] ?? '0.0.0',
      });
      onRegistered();
      handleClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to register node');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = (): void => {
    setName('');
    setHostname('');
    setPort('4100');
    setOs('linux');
    setArch('x86_64');
    setTags('');
    setError('');
    setSaving(false);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Register Node"
      description="Manually register a node already running the agent"
      icon={<Server className="h-5 w-5 text-primary" />}
    >
      <div className="space-y-4">
        <FormField label="Node Name" required>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="web-server-01"
            className={inputClass}
            autoFocus
          />
        </FormField>

        <FormField label="FQDN / Hostname" required>
          <input
            type="text"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder="node-1.example.com"
            className={inputClass}
          />
        </FormField>

        <div className="grid grid-cols-3 gap-3">
          <FormField label="Port">
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              className={inputClass}
            />
          </FormField>
          <FormField label="OS">
            <select value={os} onChange={(e) => setOs(e.target.value)} className={selectClass}>
              <option value="linux">Linux</option>
              <option value="darwin">macOS</option>
              <option value="windows">Windows</option>
            </select>
          </FormField>
          <FormField label="Architecture">
            <select value={arch} onChange={(e) => setArch(e.target.value)} className={selectClass}>
              <option value="x86_64">x86_64</option>
              <option value="aarch64">aarch64</option>
              <option value="arm">arm</option>
            </select>
          </FormField>
        </div>

        <FormField label="Tags">
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="web, production, us-east"
            className={inputClass}
          />
          <p className="mt-1 text-xs text-text-muted">Comma-separated</p>
        </FormField>

        {error && (
          <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void handleRegister()}
            disabled={saving || !name.trim() || !hostname.trim()}
            icon={saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
          >
            {saving ? 'Registering…' : 'Register Node'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Role Assignment ───

interface RoleInfo {
  id: string;
  name: string;
}

interface AssignRoleModalProps {
  open: boolean;
  node: { id: string; name: string; role?: RoleInfo | null } | null;
  onClose: () => void;
  onSaved: (assignedRole: RoleInfo | null) => void;
}

export function AssignRoleModal({ open, node, onClose, onSaved }: AssignRoleModalProps): React.ReactElement | null {
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<string>('');
  const [applyNow, setApplyNow] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loadingRoles, setLoadingRoles] = useState(false);

  useEffect(() => {
    if (open) {
      setError('');
      setSelectedRoleId(node?.role?.id ?? '');
      setApplyNow(true);
      setLoadingRoles(true);
      void (async () => {
        try {
          const res = await api.roles.list();
          setRoles((res.data as RoleInfo[]) ?? []);
        } catch {
          setError('Failed to load roles');
        } finally {
          setLoadingRoles(false);
        }
      })();
    }
  }, [open, node?.role?.id]);

  const handleSave = async (): Promise<void> => {
    if (!node) return;
    setSaving(true);
    setError('');
    try {
      const currentRoleId = node.role?.id;
      // Unassign old role if changing
      if (currentRoleId && currentRoleId !== selectedRoleId) {
        await api.roles.unassign(currentRoleId, { nodeIds: [node.id] });
      }
      // Assign new role
      if (selectedRoleId) {
        await api.roles.assign(selectedRoleId, { nodeIds: [node.id], defer: !applyNow });
      }
      const assignedRole = selectedRoleId
        ? roles.find((r) => r.id === selectedRoleId) ?? null
        : null;
      onSaved(assignedRole);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to assign role');
    } finally {
      setSaving(false);
    }
  };

  const handleUnassign = async (): Promise<void> => {
    if (!node?.role) return;
    setSaving(true);
    setError('');
    try {
      await api.roles.unassign(node.role.id, { nodeIds: [node.id] });
      onSaved(null);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to unassign role');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = (): void => {
    setError('');
    setSaving(false);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={node?.role ? 'Change Role' : 'Assign Role'}
      description={node ? `Node: ${node.name}` : ''}
      icon={<Server className="h-5 w-5 text-primary" />}
    >
      <div className="space-y-4">
        {loadingRoles ? (
          <div className="flex items-center gap-2 py-4 text-xs text-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading roles…
          </div>
        ) : roles.length === 0 ? (
          <p className="text-xs text-text-muted py-4">
            No roles found. Create a role first on the Roles page.
          </p>
        ) : (
          <>
            <FormField label="Role">
              <select
                value={selectedRoleId}
                onChange={(e) => setSelectedRoleId(e.target.value)}
                className={selectClass}
              >
                <option value="">— No role —</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </FormField>

            {selectedRoleId && (
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={applyNow}
                  onChange={(e) => setApplyNow(e.target.checked)}
                  className="rounded border-border"
                />
                Apply role immediately
              </label>
            )}
          </>
        )}

        {error && (
          <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        <div className="flex justify-between pt-2">
          <div>
            {node?.role && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleUnassign()}
                disabled={saving}
              >
                Unassign Role
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSave()}
              disabled={saving || !selectedRoleId || roles.length === 0}
              icon={saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
            >
              {saving ? 'Saving…' : node?.role ? 'Change Role' : 'Assign Role'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
