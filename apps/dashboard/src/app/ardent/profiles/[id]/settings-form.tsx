'use client';

import { useState } from 'react';
import YAML from 'yaml';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { ardentError } from './action-button';

type Entry = { text: string; revision: string };
type Props = { nodeId: string; profileId: string; entry: Entry; section: 'providers' | 'channels'; running: boolean };
const classes = 'mt-1 block w-full rounded border border-border bg-bg px-3 py-2 text-xs text-text';
const list = (value: unknown): string => Array.isArray(value) ? value.join(', ') : '';
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const bool = (value: unknown): boolean => value === true;

function numbers(value: string, signed = false): number[] {
  const entries = value.split(',').map(item => item.trim()).filter(Boolean);
  if (entries.some(item => !(signed ? /^-?\d+$/ : /^\d+$/).test(item))) throw new Error('Allowlist IDs must be comma-separated integers');
  const parsed = entries.map(Number);
  if (parsed.some(item => !Number.isSafeInteger(item) || (!signed && item <= 0))) throw new Error('Allowlist IDs are outside the supported integer range');
  return parsed;
}

export function SettingsForm({ nodeId, profileId, entry, section, running }: Props): React.ReactElement {
  const [saved, setSaved] = useState(entry);
  const initial = YAML.parseDocument(entry.text, { uniqueKeys: true });
  const configData: unknown = initial.toJS();
  const get = (...path: string[]): unknown => path.reduce<unknown>((current, key) =>
    current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>)[key] : undefined, configData);
  const [backend, setBackend] = useState(text(get('execution', 'backend')) || 'llamacpp');
  const [llamaUrl, setLlamaUrl] = useState(text(get('providers', 'llamacpp', 'base_url')));
  const [llamaModel, setLlamaModel] = useState(text(get('providers', 'llamacpp', 'model')));
  const [codexModel, setCodexModel] = useState(text(get('providers', 'codex', 'model')));
  const [telegramEnabled, setTelegramEnabled] = useState(bool(get('channels', 'telegram', 'enabled')));
  const [telegramTokenEnv, setTelegramTokenEnv] = useState(text(get('channels', 'telegram', 'token_env')));
  const [telegramUsers, setTelegramUsers] = useState(list(get('channels', 'telegram', 'allowed_user_ids')));
  const [telegramChats, setTelegramChats] = useState(list(get('channels', 'telegram', 'allowed_chat_ids')));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');

  async function save(): Promise<void> {
    setBusy(true); setError(''); setFeedback('');
    try {
      const document = YAML.parseDocument(saved.text, { uniqueKeys: true });
      if (document.errors.length) throw new Error('Current configuration YAML is invalid');
      if (section === 'providers') {
        document.setIn(['execution', 'backend'], backend);
        document.setIn(['providers', 'llamacpp', 'base_url'], llamaUrl.trim());
        document.setIn(['providers', 'llamacpp', 'model'], llamaModel.trim());
        document.setIn(['providers', 'codex', 'model'], codexModel.trim());
      } else {
        document.setIn(['channels', 'telegram', 'enabled'], telegramEnabled);
        document.setIn(['channels', 'telegram', 'token_env'], telegramTokenEnv.trim());
        document.setIn(['channels', 'telegram', 'allowed_user_ids'], numbers(telegramUsers));
        document.setIn(['channels', 'telegram', 'allowed_chat_ids'], numbers(telegramChats, true));
      }
      const next = String(document);
      const validation = await api.ardent.action<{ valid: boolean }>(nodeId, profileId, 'config-validate', { text: next });
      if (!validation.data?.valid) throw new Error('Node rejected the configuration');
      const response = await api.ardent.action<{ revision: string; activation_required: boolean }>(nodeId, profileId, 'config-save', { text: next, revision: saved.revision });
      if (!response.data?.revision) throw new Error('Node did not confirm the saved revision');
      setSaved({ text: next, revision: response.data.revision });
      setFeedback(running ? 'Saved. Restart this profile to activate the new settings.' : 'Saved. Settings activate when this profile starts.');
    } catch (reason) { setError(await ardentError(reason)); }
    finally { setBusy(false); }
  }

  const input = (label: string, value: string, setter: (value: string) => void, hint?: string) =>
    <label className="block text-[11px] text-text-muted">{label}<input value={value} onChange={event => setter(event.target.value)} className={classes} autoComplete="off" />{hint && <span className="mt-1 block text-[10px] text-text-muted">{hint}</span>}</label>;
  const toggle = (label: string, value: boolean, setter: (value: boolean) => void) =>
    <label className="flex items-center gap-2 text-xs text-text"><input type="checkbox" checked={value} onChange={event => setter(event.target.checked)} />{label}</label>;

  return <div className="mt-4 rounded border border-border/60 bg-surface p-4">
    <p className="text-xs font-semibold uppercase tracking-wider text-text">{section === 'providers' ? 'Provider settings' : 'Channel settings'}</p>
    {section === 'providers' ? <div className="mt-4 grid gap-3 md:grid-cols-2">
      <label className="block text-[11px] text-text-muted">Selected backend<select value={backend} onChange={event => setBackend(event.target.value)} className={classes}><option value="llamacpp">llama.cpp</option><option value="codex">Codex App Server</option></select></label>
      {input('llama.cpp endpoint', llamaUrl, setLlamaUrl, 'HTTP(S) endpoint or ${ENV_REFERENCE}; no embedded credentials.')}
      {input('llama.cpp model', llamaModel, setLlamaModel)}
      {input('Codex model', codexModel, setCodexModel, 'Uses the existing node-local ChatGPT login.')}
    </div> : <div className="mt-4 grid gap-5 lg:grid-cols-2">
      <div className="space-y-3">{toggle('Enable Telegram polling', telegramEnabled, setTelegramEnabled)}{input('Telegram token environment variable', telegramTokenEnv, setTelegramTokenEnv)}{input('Allowed Telegram user IDs', telegramUsers, setTelegramUsers, 'Comma-separated numeric IDs.')}{input('Allowed chat IDs', telegramChats, setTelegramChats, 'Comma-separated signed numeric IDs.')}</div>
      <p className="text-[11px] leading-5 text-text-muted">Other channel adapters are configured in the Configuration tab.</p>
    </div>}
    <div className="mt-4 flex flex-wrap items-center gap-3"><Button size="sm" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Validate and save'}</Button><span className="text-[11px] text-text-muted">Credential values stay in the profile environment file.</span></div>
    {feedback && <p role="status" className="mt-3 text-xs text-success">{feedback}</p>}
    {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
  </div>;
}
