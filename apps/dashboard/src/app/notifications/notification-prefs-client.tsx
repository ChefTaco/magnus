'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api-client';

const CATEGORIES = [
  { id: 'node.offline', label: 'Node Offline', group: 'Fleet' },
  { id: 'node.degraded', label: 'Node Degraded', group: 'Fleet' },
  { id: 'node.recovered', label: 'Node Recovered', group: 'Fleet' },
  { id: 'command.failed', label: 'Command Failed', group: 'Operations' },
  { id: 'deploy.failed', label: 'Deploy Failed', group: 'Operations' },
  { id: 'deploy.success', label: 'Deploy Success', group: 'Operations' },
  { id: 'upgrade.failed', label: 'Upgrade Failed', group: 'Operations' },
  { id: 'ai.anomaly', label: 'AI Anomaly', group: 'AI' },
  { id: 'ai.heartbeat', label: 'AI Heartbeat', group: 'AI' },
];

const CHANNELS = ['in_app', 'email', 'webhook'] as const;
const SEVERITIES = ['info', 'warning', 'critical'] as const;

interface Preference {
  userId: string;
  channel: string;
  category: string;
  enabled: boolean;
  minSeverity: string;
}

export default function NotificationPrefsClient() {
  const [prefs, setPrefs] = useState<Preference[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');

  const fetchPrefs = useCallback(async () => {
    try {
      const data = await api.get<Preference[]>('notifications/preferences');
      setPrefs(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPrefs();
  }, [fetchPrefs]);

  function getPref(channel: string, category: string): Preference | undefined {
    return prefs.find((p) => p.channel === channel && p.category === category);
  }

  function togglePref(channel: string, category: string) {
    const existing = getPref(channel, category);
    if (existing) {
      setPrefs((prev) =>
        prev.map((p) =>
          p.channel === channel && p.category === category ? { ...p, enabled: !p.enabled } : p,
        ),
      );
    } else {
      setPrefs((prev) => [
        ...prev,
        { userId: '', channel, category, enabled: true, minSeverity: 'info' },
      ]);
    }
    setDirty(true);
  }

  function setSeverity(channel: string, category: string, sev: string) {
    const existing = getPref(channel, category);
    if (existing) {
      setPrefs((prev) =>
        prev.map((p) =>
          p.channel === channel && p.category === category ? { ...p, minSeverity: sev } : p,
        ),
      );
    } else {
      setPrefs((prev) => [
        ...prev,
        { userId: '', channel, category, enabled: true, minSeverity: sev },
      ]);
    }
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const preferences = CATEGORIES.flatMap((cat) =>
        CHANNELS.map((ch) => {
          const p = getPref(ch, cat.id);
          return {
            channel: ch,
            category: cat.id,
            enabled: p?.enabled ?? (ch === 'in_app'),
            minSeverity: p?.minSeverity ?? 'info',
          };
        }),
      );

      const data = await api.put<Preference[]>('notifications/preferences', { preferences });
      setPrefs(data.data ?? []);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const groups = [...new Set(CATEGORIES.map((c) => c.group))];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold uppercase tracking-wider text-primary glow-text-primary">Notification Preferences</h1>
          <p className="text-sm text-text-muted mt-1">Configure which notifications you receive and how</p>
        </div>
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="px-4 py-2 text-xs font-medium transition-all rounded-chip border border-primary/60 bg-primary/10 text-primary uppercase tracking-wider hover:bg-primary/20 hover:shadow-[0_0_12px_var(--color-glow)] disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Preferences'}
        </button>
      </div>

      {error && (
        <div className="bg-danger/10 border border-danger/50 rounded-lg p-3 text-danger text-sm">{error}</div>
      )}

      {groups.map((group) => (
        <div key={group} className="rounded-xl border border-border bg-surface/50 overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-text">{group}</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-muted text-xs border-b border-border">
                  <th className="text-left py-2 px-4 w-48">Category</th>
                  {CHANNELS.map((ch) => (
                    <th key={ch} className="text-center py-2 px-3 capitalize">
                      {ch.replace('_', ' ')}
                    </th>
                  ))}
                  <th className="text-center py-2 px-3">Min Severity</th>
                </tr>
              </thead>
              <tbody>
                {CATEGORIES.filter((c) => c.group === group).map((cat) => (
                  <tr key={cat.id} className="border-b border-border/50 hover:bg-surface-hover/30">
                    <td className="py-2 px-4 text-text">{cat.label}</td>
                    {CHANNELS.map((ch) => {
                      const p = getPref(ch, cat.id);
                      const enabled = p?.enabled ?? (ch === 'in_app');
                      return (
                        <td key={ch} className="py-2 px-3 text-center">
                          <button
                            onClick={() => togglePref(ch, cat.id)}
                            className={`w-8 h-5 rounded-full relative transition-colors ${
                              enabled ? 'bg-primary shadow-[0_0_10px_var(--color-glow)]' : 'bg-border-strong'
                            }`}
                          >
                            <div
                              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                                enabled ? 'left-3.5' : 'left-0.5'
                              }`}
                            />
                          </button>
                        </td>
                      );
                    })}
                    <td className="py-2 px-3 text-center">
                      <select
                        value={getPref('in_app', cat.id)?.minSeverity ?? 'info'}
                        onChange={(e) => {
                          for (const ch of CHANNELS) {
                            setSeverity(ch, cat.id, e.target.value);
                          }
                        }}
                        className="bg-surface-hover border border-border text-text text-xs rounded px-2 py-1"
                      >
                        {SEVERITIES.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
