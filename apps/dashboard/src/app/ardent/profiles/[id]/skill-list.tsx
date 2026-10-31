'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { Badge, statusVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ardentError } from './action-button';

type Skill = { name: string; description: string; hash: string; enabled: boolean };
export function SkillList({ nodeId, profileId, initial, initialRevision }: { nodeId: string; profileId: string; initial: Skill[]; initialRevision: string }): React.ReactElement {
  const [skills, setSkills] = useState(initial);
  const [revision, setRevision] = useState(initialRevision);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  useEffect(() => { setSkills(initial); setRevision(initialRevision); setError(''); setFeedback(''); }, [initial, initialRevision]);
  async function toggle(skill: Skill): Promise<void> {
    setBusy(skill.name); setError(''); setFeedback('');
    try {
      const response = await api.ardent.action<{ revision: string; activation_required: boolean }>(nodeId, profileId, 'skill-set', { enabled: !skill.enabled, revision }, skill.name);
      if (!response.data?.revision) throw new Error('Ardent did not acknowledge the skill revision');
      setRevision(response.data.revision);
      setSkills(previous => previous.map(item => item.name === skill.name ? { ...item, enabled: !skill.enabled } : item));
      setFeedback(`${skill.name} ${skill.enabled ? 'disabled' : 'enabled'}. Restart the profile to activate.`);
    } catch (reason) { setError(await ardentError(reason)); }
    finally { setBusy(''); }
  }
  return <div className="space-y-3">
    <div className="flex flex-wrap justify-between gap-2 text-[11px] text-text-muted"><span>Working methods available to this profile</span><span className="font-mono">Configuration revision {revision.slice(0, 12)}</span></div>
    <div className="grid gap-3 lg:grid-cols-2">{skills.length ? skills.map(skill => <div key={skill.name} className="min-w-0 rounded border border-border/60 bg-surface p-4"><div className="flex items-start justify-between gap-2"><p className="text-sm font-semibold text-text">{skill.name}</p><Badge variant={statusVariant(skill.enabled ? 'running' : 'stopped')}>{skill.enabled ? 'Enabled' : 'Disabled'}</Badge></div><p className="mt-2 text-xs leading-5 text-text-muted">{skill.description}</p><p className="mt-3 font-mono text-[10px] text-text-muted">{skill.hash.slice(0, 16)}</p><Button className="mt-3" size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => void toggle(skill)}>{skill.enabled ? 'Disable' : 'Enable'}</Button></div>) : <p className="rounded border border-border bg-surface p-6 text-xs text-text-muted lg:col-span-2">No skills were reported.</p>}</div>
    {feedback && <p role="status" className="text-xs text-success">{feedback}</p>}{error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </div>;
}
