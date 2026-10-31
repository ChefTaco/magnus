'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, type WebhookEndpoint, type WebhookCreateInput, type WebhookUpdateInput } from '@/lib/api-client';
import { Save, X, Plus, Trash2 } from 'lucide-react';

const EVENT_OPTIONS = [
  'node.offline', 'node.degraded', 'node.recovered',
  'command.failed', 'deploy.failed', 'upgrade.failed',
  'ai.heartbeat', 'ai.anomaly',
];

interface Props {
  endpoint?: WebhookEndpoint;
}

export function WebhookForm({ endpoint }: Props) {
  const router = useRouter();
  const isEdit = !!endpoint;

  const parsedEvents: string[] = (() => {
    if (!endpoint) return [];
    try { return JSON.parse(endpoint.events); } catch { return []; }
  })();
  const [name, setName] = useState(endpoint?.name ?? '');
  const [url, setUrl] = useState('');
  const [type, setType] = useState(endpoint?.type ?? 'generic');
  const [secret, setSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [events, setEvents] = useState<string[]>(parsedEvents);
  const [headers, setHeaders] = useState<Array<{ key: string; value: string }>>([]);
  const [headersTouched, setHeadersTouched] = useState(false);
  const [retries, setRetries] = useState(endpoint?.retries ?? 3);
  const [timeoutMs, setTimeoutMs] = useState(endpoint?.timeoutMs ?? 10000);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const toggleEvent = (evt: string) => {
    setEvents((prev) =>
      prev.includes(evt) ? prev.filter((e) => e !== evt) : [...prev, evt],
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || (!isEdit && !url.trim())) return;

    setSaving(true);
    setError('');

    try {
      const headersObj: Record<string, string> = {};
      for (const h of headers) {
        if (h.key.trim()) headersObj[h.key.trim()] = h.value;
      }

      if (isEdit) {
        const data: WebhookUpdateInput = {
          name: name.trim(),
          ...(url.trim() ? { url: url.trim() } : {}),
          type,
          events,
          retries,
          timeoutMs,
        };
        if (clearSecret) data.secret = null;
        else if (secret) data.secret = secret;
        if (headersTouched) data.headers = headersObj;
        await api.webhooks.update(endpoint.id, data);
      } else {
        const data: WebhookCreateInput = {
          name: name.trim(),
          url: url.trim(),
          type,
          events,
          headers: headersObj,
          retries,
          timeoutMs,
        };
        if (secret) data.secret = secret;
        await api.webhooks.create(data);
      }
      router.push('/webhooks');
      router.refresh();
    } catch {
      setError('Failed to save webhook. Check the URL and try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-2xl">
      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-4 text-sm text-danger">
          {error}
        </div>
      )}

      {/* Name */}
      <div>
        <label className="block text-xs uppercase tracking-wider text-text-muted mb-2">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          placeholder="My Webhook"
          className="w-full text-sm bg-bg border border-border/50 rounded-lg px-3 py-2 text-text focus:outline-none focus:border-accent/50"
        />
      </div>

      {/* URL */}
      <div>
        <label className="block text-xs uppercase tracking-wider text-text-muted mb-2">URL</label>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
          placeholder={isEdit ? `Leave blank to keep ${endpoint.url}` : "https://example.com/webhook"}
          className="w-full text-sm bg-bg border border-border/50 rounded-lg px-3 py-2 text-text font-mono focus:outline-none focus:border-accent/50"
        />
      </div>

      {/* Type */}
      <div>
        <label className="block text-xs uppercase tracking-wider text-text-muted mb-2">Type</label>
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="text-sm bg-bg border border-border/50 rounded-lg px-3 py-2 text-text focus:outline-none focus:border-accent/50"
        >
          <option value="generic">Generic</option>
          <option value="slack">Slack</option>
          <option value="discord">Discord</option>
        </select>
      </div>

      {/* Secret */}
      <div>
        <label className="block text-xs uppercase tracking-wider text-text-muted mb-2">
          Secret {isEdit && <span className="normal-case text-text-muted/60">
            ({endpoint.secretConfigured ? 'configured; ' : ''}leave empty to keep current)
          </span>}
        </label>
        <input
          type="password"
          value={secret}
          onChange={(e) => {
            setSecret(e.target.value);
            setClearSecret(false);
          }}
          placeholder={isEdit ? '••••••••' : 'HMAC signing secret (optional)'}
          className="w-full text-sm bg-bg border border-border/50 rounded-lg px-3 py-2 text-text focus:outline-none focus:border-accent/50"
        />
        {isEdit && endpoint.secretConfigured && (
          <button
            type="button"
            onClick={() => {
              setSecret('');
              setClearSecret(true);
            }}
            className="mt-2 text-xs text-danger hover:text-danger"
          >
            {clearSecret ? 'Signing secret will be cleared' : 'Clear saved signing secret'}
          </button>
        )}
      </div>

      {/* Events */}
      <div>
        <label className="block text-xs uppercase tracking-wider text-text-muted mb-2">
          Events <span className="normal-case text-text-muted/60">(empty = all events)</span>
        </label>
        <div className="flex flex-wrap gap-2">
          {EVENT_OPTIONS.map((evt) => (
            <button
              key={evt}
              type="button"
              onClick={() => toggleEvent(evt)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                events.includes(evt)
                  ? 'border-accent/50 bg-accent/10 text-accent'
                  : 'border-border/50 bg-surface text-text-muted hover:text-text'
              }`}
            >
              {evt}
            </button>
          ))}
        </div>
      </div>

      {/* Custom headers */}
      <div>
        <label className="block text-xs uppercase tracking-wider text-text-muted mb-2">
          Custom Headers
          {isEdit && endpoint.headersConfigured && !headersTouched && (
            <span className="normal-case text-text-muted/60"> (configured; values are write-only)</span>
          )}
        </label>
        <div className="space-y-2">
          {headers.map((h, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={h.key}
                onChange={(e) => {
                  setHeaders(headers.map((item, idx) => idx === i ? { key: e.target.value, value: item.value } : item));
                  setHeadersTouched(true);
                }}
                placeholder="Header name"
                className="flex-1 text-xs bg-bg border border-border/50 rounded px-2 py-1.5 text-text focus:outline-none focus:border-accent/50"
              />
              <input
                type="text"
                value={h.value}
                onChange={(e) => {
                  setHeaders(headers.map((item, idx) => idx === i ? { key: item.key, value: e.target.value } : item));
                  setHeadersTouched(true);
                }}
                placeholder="Value"
                className="flex-1 text-xs bg-bg border border-border/50 rounded px-2 py-1.5 text-text focus:outline-none focus:border-accent/50"
              />
              <button
                type="button"
                onClick={() => {
                  setHeaders(headers.filter((_, idx) => idx !== i));
                  setHeadersTouched(true);
                }}
                className="text-danger hover:text-danger p-1"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => {
              setHeaders([...headers, { key: '', value: '' }]);
              setHeadersTouched(true);
            }}
            className="flex items-center gap-1 text-xs text-accent hover:text-accent/80"
          >
            <Plus className="h-3 w-3" /> Add header
          </button>
          {isEdit && endpoint.headersConfigured && (
            <button
              type="button"
              onClick={() => {
                setHeaders([]);
                setHeadersTouched(true);
              }}
              className="ml-3 text-xs text-danger hover:text-danger"
            >
              Clear saved headers
            </button>
          )}
        </div>
      </div>

      {/* Retries + Timeout */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs uppercase tracking-wider text-text-muted mb-2">Retries</label>
          <input
            type="number"
            min={0}
            max={10}
            value={retries}
            onChange={(e) => setRetries(Number(e.target.value))}
            className="w-full text-sm bg-bg border border-border/50 rounded-lg px-3 py-2 text-text focus:outline-none focus:border-accent/50"
          />
        </div>
        <div>
          <label className="block text-xs uppercase tracking-wider text-text-muted mb-2">Timeout (ms)</label>
          <input
            type="number"
            min={1000}
            max={60000}
            step={1000}
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(Number(e.target.value))}
            className="w-full text-sm bg-bg border border-border/50 rounded-lg px-3 py-2 text-text focus:outline-none focus:border-accent/50"
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={saving || !name.trim() || !url.trim()}
          className="flex items-center gap-2 text-sm px-4 py-2 rounded-lg bg-accent/20 text-accent hover:bg-accent/30 disabled:opacity-50 transition-colors"
        >
          <Save className="h-4 w-4" /> {isEdit ? 'Update' : 'Create'}
        </button>
        <button
          type="button"
          onClick={() => router.push('/webhooks')}
          className="flex items-center gap-1 text-sm px-4 py-2 rounded-lg text-text-muted hover:text-text transition-colors"
        >
          <X className="h-4 w-4" /> Cancel
        </button>
      </div>
    </form>
  );
}
