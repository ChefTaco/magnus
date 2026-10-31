'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Modal, FormField, inputClass, selectClass, textareaClass } from '@/components/ui/modal';
import { api } from '@/lib/api-client';
import { ShieldCheck, Loader2, Plus, Trash2 } from 'lucide-react';

interface RoleData {
  id: string;
  name: string;
  description: string;
  libraryFileIds: string[];
  skillNames: string[];
  aptPackages: string[];
  npmPackages: string[];
  envConfig: Record<string, string>;
  dockerEnabled: boolean;
  dockerNonRoot: boolean;
  dockerImage: string | null;
  dockerVolumes: string[];
  firewallEnabled: boolean;
  firewallMode: string;
  firewallAllowRules: string[];
  status: string;
}

interface LibraryFileOption {
  id: string;
  name: string;
  fileName: string;
  mimeType: string;
}

interface RoleModalProps {
  open: boolean;
  mode: 'create' | 'edit';
  role: RoleData | null;
  onClose: () => void;
  onSaved: () => void;
}

export function RoleModal({ open, mode, role, onClose, onSaved }: RoleModalProps): React.ReactElement | null {
  // Basic info
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState('active');

  // Library items (skills + jobs)
  const [libraryFileIds, setLibraryFileIds] = useState<string[]>([]);

  // Packages
  const [aptPackagesStr, setAptPackagesStr] = useState('');
  const [npmPackagesStr, setNpmPackagesStr] = useState('');

  // Env config
  const [envEntries, setEnvEntries] = useState<Array<{ key: string; value: string }>>([]);

  // Docker
  const [dockerEnabled, setDockerEnabled] = useState(false);
  const [dockerNonRoot, setDockerNonRoot] = useState(false);
  const [dockerImage, setDockerImage] = useState('');
  const [dockerVolumesStr, setDockerVolumesStr] = useState('');

  // Firewall
  const [firewallEnabled, setFirewallEnabled] = useState(false);
  const [firewallMode, setFirewallMode] = useState('restrictive');
  const [firewallRulesStr, setFirewallRulesStr] = useState('');

  // State
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [libraryFiles, setLibraryFiles] = useState<LibraryFileOption[]>([]);
  const [activeTab, setActiveTab] = useState<'basic' | 'packages' | 'files' | 'docker' | 'firewall'>('basic');

  // Load available library items
  const loadOptions = useCallback(async () => {
    try {
      const filesRes = await api.library.files.list({ pageSize: 200 });
      setLibraryFiles(
        ((filesRes.data ?? []) as (LibraryFileOption & { mimeType: string })[]).map((f) => ({
          id: f.id,
          name: f.name,
          fileName: f.fileName,
          mimeType: f.mimeType ?? '',
        })),
      );
    } catch {
      // silently fail
    }
  }, []);

  useEffect(() => {
    if (open) void loadOptions();
  }, [open, loadOptions]);

  // Populate form for editing
  useEffect(() => {
    if (mode === 'edit' && role) {
      setName(role.name);
      setDescription(role.description);
      setStatus(role.status);
      setLibraryFileIds(role.libraryFileIds);
      setAptPackagesStr(role.aptPackages.join(', '));
      setNpmPackagesStr(role.npmPackages.join(', '));
      setEnvEntries(
        Object.entries(role.envConfig).map(([key, value]) => ({ key, value })),
      );
      setDockerEnabled(role.dockerEnabled);
      setDockerNonRoot(role.dockerNonRoot);
      setDockerImage(role.dockerImage ?? '');
      setDockerVolumesStr((role.dockerVolumes ?? []).join('\n'));
      setFirewallEnabled(role.firewallEnabled);
      setFirewallMode(role.firewallMode);
      setFirewallRulesStr(role.firewallAllowRules.join(', '));
    } else if (mode === 'create') {
      setName('');
      setDescription('');
      setStatus('active');
      setLibraryFileIds([]);
      setAptPackagesStr('');
      setNpmPackagesStr('');
      setEnvEntries([{ key: 'OPENROUTER_API_KEY', value: '' }]);
      setDockerEnabled(false);
      setDockerNonRoot(false);
      setDockerImage('');
      setDockerVolumesStr('');
      setFirewallEnabled(false);
      setFirewallMode('restrictive');
      setFirewallRulesStr('');
    }
    setError('');
    setActiveTab('basic');
  }, [mode, role]);

  const parseList = (str: string): string[] =>
    str.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

  const handleSave = async (): Promise<void> => {
    if (!name.trim()) return;
    setSaving(true);
    setError('');

    const envConfig: Record<string, string> = {};
    for (const entry of envEntries) {
      if (entry.key.trim()) envConfig[entry.key.trim()] = entry.value;
    }

    const payload = {
      name: name.trim(),
      description: description.trim(),
      status,
      libraryFileIds,
      aptPackages: parseList(aptPackagesStr),
      npmPackages: parseList(npmPackagesStr),
      envConfig,
      dockerEnabled,
      dockerNonRoot,
      dockerImage: dockerImage.trim() || null,
      dockerVolumes: dockerVolumesStr.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean),
      firewallEnabled,
      firewallMode,
      firewallAllowRules: parseList(firewallRulesStr),
    };

    try {
      if (mode === 'create') {
        await api.roles.create(payload);
      } else if (role) {
        await api.roles.update(role.id, payload);
      }
      onSaved();
      handleClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save role');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = (): void => {
    setError('');
    setSaving(false);
    onClose();
  };

  const addEnvEntry = (): void => {
    setEnvEntries([...envEntries, { key: '', value: '' }]);
  };

  const removeEnvEntry = (index: number): void => {
    setEnvEntries(envEntries.filter((_, i) => i !== index));
  };

  const updateEnvEntry = (index: number, field: 'key' | 'value', val: string): void => {
    const updated = [...envEntries];
    const entry = updated[index];
    if (entry) {
      updated[index] = { key: field === 'key' ? val : entry.key, value: field === 'value' ? val : entry.value };
    }
    setEnvEntries(updated);
  };

  const toggleLibraryFile = (id: string): void => {
    setLibraryFileIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const librarySkills = libraryFiles.filter((f) => f.mimeType === 'application/x-magnus-skill');
  const libraryJobs = libraryFiles.filter((f) => f.mimeType === 'application/x-magnus-cronjob');

  const tabs = [
    { key: 'basic' as const, label: 'Basic' },
    { key: 'packages' as const, label: 'Packages & Env' },
    { key: 'files' as const, label: 'Skills & Jobs' },
    { key: 'docker' as const, label: 'Docker' },
    { key: 'firewall' as const, label: 'Firewall' },
  ];

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={mode === 'create' ? 'Create Role' : 'Edit Role'}
      description={mode === 'create' ? 'Define a reusable configuration for nodes' : `Editing ${role?.name ?? ''}`}
      icon={<ShieldCheck className="h-5 w-5 text-primary" />}
      className="max-w-2xl"
    >
      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-border pb-2">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1.5 text-xs font-bold rounded transition-all ${
              activeTab === tab.key
                ? 'bg-primary/10 text-primary border border-primary/50'
                : 'text-text-muted hover:text-text hover:bg-surface-hover border border-transparent'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
        {/* ── Basic Tab ── */}
        {activeTab === 'basic' && (
          <>
            <FormField label="Role Name" required>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="web-server"
                className={inputClass}
                autoFocus
              />
            </FormField>

            <FormField label="Description">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Standard web server role with Nginx and monitoring..."
                rows={3}
                className={textareaClass}
              />
            </FormField>

            <FormField label="Status">
              <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectClass}>
                <option value="active">Active</option>
                <option value="draft">Draft</option>
              </select>
            </FormField>
          </>
        )}

        {/* ── Packages & Env Tab ── */}
        {activeTab === 'packages' && (
          <>
            <FormField label="APT Packages">
              <input
                type="text"
                value={aptPackagesStr}
                onChange={(e) => setAptPackagesStr(e.target.value)}
                placeholder="nginx, curl, htop, jq"
                className={inputClass}
              />
              <p className="mt-1 text-xs text-text-muted">Comma-separated package names</p>
            </FormField>

            <FormField label="NPM Global Packages">
              <input
                type="text"
                value={npmPackagesStr}
                onChange={(e) => setNpmPackagesStr(e.target.value)}
                placeholder="pm2, tsx"
                className={inputClass}
              />
              <p className="mt-1 text-xs text-text-muted">Comma-separated package names</p>
            </FormField>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
                  Environment Variables
                </label>
                <button
                  onClick={addEnvEntry}
                  className="flex items-center gap-1 text-xs text-primary hover:text-primary-hover"
                >
                  <Plus className="h-3 w-3" /> Add
                </button>
              </div>
              <div className="space-y-2">
                {envEntries.map((entry, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <input
                      type="text"
                      value={entry.key}
                      onChange={(e) => updateEnvEntry(i, 'key', e.target.value)}
                      placeholder="KEY_NAME"
                      className={`${inputClass} flex-1`}
                    />
                    <input
                      type="password"
                      value={entry.value}
                      onChange={(e) => updateEnvEntry(i, 'value', e.target.value)}
                      placeholder="value"
                      className={`${inputClass} flex-1`}
                    />
                    <button
                      onClick={() => removeEnvEntry(i)}
                      className="text-text-muted hover:text-danger p-1"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                {envEntries.length === 0 && (
                  <p className="text-xs text-text-muted py-2">No environment variables configured</p>
                )}
              </div>
            </div>
          </>
        )}

        {/* ── Skills & Jobs Tab ── */}
        {activeTab === 'files' && (
          <>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-text-muted mb-1.5">Skills from Library</label>
              <div className="max-h-40 overflow-y-auto rounded border border-border bg-bg p-2 space-y-1">
                {librarySkills.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-text-muted">No skills in library — publish skills from the Skills page</p>
                ) : (
                  librarySkills.map((f) => (
                    <label
                      key={f.id}
                      className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-hover hover:shadow-[0_0_20px_var(--color-glow)] cursor-pointer transition-all"
                    >
                      <input
                        type="checkbox"
                        checked={libraryFileIds.includes(f.id)}
                        onChange={() => toggleLibraryFile(f.id)}
                        className="accent-primary"
                      />
                      <span className="text-xs">{f.name}</span>
                      <span className="text-xs text-text-muted ml-auto">{f.fileName}</span>
                    </label>
                  ))
                )}
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-text-muted mb-1.5">Cron Jobs from Library</label>
              <div className="max-h-40 overflow-y-auto rounded border border-border bg-bg p-2 space-y-1">
                {libraryJobs.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-text-muted">No cron jobs in library — publish jobs from the Cron page</p>
                ) : (
                  libraryJobs.map((f) => (
                    <label
                      key={f.id}
                      className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-hover hover:shadow-[0_0_20px_var(--color-glow)] cursor-pointer transition-all"
                    >
                      <input
                        type="checkbox"
                        checked={libraryFileIds.includes(f.id)}
                        onChange={() => toggleLibraryFile(f.id)}
                        className="accent-primary"
                      />
                      <span className="text-xs">{f.name}</span>
                      <span className="text-xs text-text-muted ml-auto">{f.fileName}</span>
                    </label>
                  ))
                )}
              </div>
            </div>
          </>
        )}

        {/* ── Docker Tab ── */}
        {activeTab === 'docker' && (
          <>
            <FormField label="Docker Sandboxing">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={dockerEnabled}
                  onChange={(e) => setDockerEnabled(e.target.checked)}
                  className="accent-primary h-4 w-4"
                />
                <span className="text-xs">Run workload inside Docker container</span>
              </label>
            </FormField>

            {dockerEnabled && (
              <>
                <FormField label="Non-Root User">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={dockerNonRoot}
                      onChange={(e) => setDockerNonRoot(e.target.checked)}
                      className="accent-primary h-4 w-4"
                    />
                    <span className="text-xs">Run as non-root user inside container</span>
                  </label>
                </FormField>

                <FormField label="Custom Docker Image">
                  <input
                    type="text"
                    value={dockerImage}
                    onChange={(e) => setDockerImage(e.target.value)}
                    placeholder="node:22-slim (default)"
                    className={inputClass}
                  />
                  <p className="mt-1 text-xs text-text-muted">Leave empty for default node:22-slim</p>
                </FormField>

                <FormField label="Volume Mounts">
                  <textarea
                    value={dockerVolumesStr}
                    onChange={(e) => setDockerVolumesStr(e.target.value)}
                    placeholder="/host/path:/container/path (one per line)"
                    rows={3}
                    className={inputClass}
                  />
                  <p className="mt-1 text-xs text-text-muted">One volume mount per line, e.g. /mnt/data/output:/mnt/data/output</p>
                </FormField>
              </>
            )}

            {!dockerEnabled && (
              <div className="rounded border border-border bg-bg/50 p-4 text-center">
                <p className="text-xs text-text-muted">
                  Enable Docker sandboxing to run workloads in an isolated container with optional non-root user.
                </p>
              </div>
            )}
          </>
        )}

        {/* ── Firewall Tab ── */}
        {activeTab === 'firewall' && (
          <>
            <FormField label="UFW Firewall">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={firewallEnabled}
                  onChange={(e) => setFirewallEnabled(e.target.checked)}
                  className="accent-primary h-4 w-4"
                />
                <span className="text-xs">Enable UFW firewall on the node</span>
              </label>
            </FormField>

            {firewallEnabled && (
              <>
                <FormField label="Firewall Mode">
                  <select
                    value={firewallMode}
                    onChange={(e) => setFirewallMode(e.target.value)}
                    className={selectClass}
                  >
                    <option value="restrictive">Restrictive — Block private LAN, allow SSH + Magnus</option>
                    <option value="permissive">Permissive — Allow SSH + Magnus only</option>
                    <option value="custom">Custom — Define your own rules</option>
                  </select>
                </FormField>

                {firewallMode === 'restrictive' && (
                  <div className="rounded border border-warning/20 bg-warning/10 px-3 py-2 text-[11px] text-warning">
                    <p className="font-bold text-[10px] uppercase tracking-wider">Auto-configured rules:</p>
                    <ul className="text-xs mt-1 space-y-0.5 text-warning/80">
                      <li>• Allow SSH (port 22)</li>
                      <li>• Allow Magnus agent port (4100)</li>
                      <li>• Allow from control-api IP</li>
                      <li>• Deny 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16</li>
                    </ul>
                  </div>
                )}

                {firewallMode === 'custom' && (
                  <FormField label="Custom Allow Rules">
                    <input
                      type="text"
                      value={firewallRulesStr}
                      onChange={(e) => setFirewallRulesStr(e.target.value)}
                      placeholder="80/tcp, 443/tcp, 10.0.0.5"
                      className={inputClass}
                    />
                    <p className="mt-1 text-xs text-text-muted">
                      Comma-separated. Port rules (80/tcp) or IP allow rules (10.0.0.5).
                      SSH + Magnus agent are always allowed.
                    </p>
                  </FormField>
                )}
              </>
            )}

            {!firewallEnabled && (
              <div className="rounded border border-border bg-bg/50 p-4 text-center">
                <p className="text-xs text-text-muted">
                  Enable UFW to firewall the node away from local networks while preserving Magnus agent communication.
                </p>
              </div>
            )}
          </>
        )}
      </div>

      {/* Error + Actions */}
      {error && (
        <div className="mt-4 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-border">
        <Button variant="secondary" size="sm" onClick={handleClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => void handleSave()}
          disabled={saving || !name.trim()}
          icon={saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
        >
          {saving ? 'Saving…' : mode === 'create' ? 'Create Role' : 'Save Changes'}
        </Button>
      </div>
    </Modal>
  );
}
