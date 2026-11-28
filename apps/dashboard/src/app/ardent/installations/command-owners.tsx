'use client';

import { useState } from 'react';
import { CommandReconcileDecisionResultSchema, type ArdentCommandOwner, type ArdentFleetInstallation } from '@hivemagnus/magnus-contracts';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Modal, selectClass, textareaClass } from '@/components/ui/modal';
import { ardentError } from '../profiles/[id]/action-button';

function Owner({ owner, installation, admin, refresh }: { owner: ArdentCommandOwner; installation: ArdentFleetInstallation;
  admin: boolean; refresh: () => Promise<void> }): React.ReactElement {
  const [disposition, setDisposition] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = Date.now() >= Date.parse(owner.reconcilableAfter);
  const complete = disposition !== '' && reason.trim().length >= 10 && reason.trim().length <= 500;
  async function reconcile(): Promise<void> {
    if (!admin || owner.reconcilable === false || !ready || !complete || busy) return;
    setConfirming(false); setBusy(true); setError('');
    try {
      const decision = { disposition, reason: reason.trim() };
      // An Ardent action is bound to the profile inventory; any other command goes to the generic command route.
      const response = owner.ardent
        ? await api.ardent.action(installation.nodeId, owner.profile ?? installation.profiles[0]?.id ?? 'default', 'command-reconcile', decision, owner.commandId)
        : await api.commands.reconcileResource(owner.commandId, decision);
      const result = CommandReconcileDecisionResultSchema.parse(response.data);
      if (result.commandId !== owner.commandId) throw new Error('The node returned another command receipt');
      await refresh();
    } catch (cause) { setError(await ardentError(cause)); }
    finally { setBusy(false); }
  }
  return <li className="space-y-2 rounded border border-border/50 p-3">
    <p className="font-semibold">{owner.action ? `${owner.action} on ${owner.profile}` : 'Node command'} · {owner.state}</p>
    <p className="break-all font-mono">{owner.commandId}</p>
    {owner.state !== 'unknown' ? <p>Still running; other Ardent actions wait until it finishes.</p>
      : owner.reconcilable === false ? <p>This scheduled run or skill publication settles only from its own retained evidence on the node, not from a decision. See docs/COMMAND_RESOURCE_LEASES.md.</p>
      : !admin ? <p>An ADMIN must inspect and reconcile this command.</p> : <>
        <p>{owner.ardent ? 'Check the profile’s service state, journal, files and Ardent status on the node before recording what happened.'
          : 'This is a node command, not an Ardent action. Check what it ran and the node’s journal before recording what happened.'}</p>
        {!ready && <p>Reconciliation is available after {new Date(owner.reconcilableAfter).toLocaleString()}. Refresh then.</p>}
        {installation.commandReconciliation?.configured === false && <p>No reconciliation key is configured. Only the node’s own evidence can settle this command.</p>}
        <label className="block">What did it do?
          <select className={selectClass} value={disposition} onChange={event => setDisposition(event.target.value)} disabled={busy}>
            <option value="">Select what you verified</option><option value="effects_verified">It took effect, fully or partly</option>
            <option value="no_effect_verified">It changed nothing</option>
          </select>
        </label>
        <label className="block">What you checked (10 to 500 characters)
          <textarea className={textareaClass} value={reason} onChange={event => setReason(event.target.value)} maxLength={500} disabled={busy} />
        </label>
        <Button size="sm" disabled={!ready || !complete || busy} onClick={() => setConfirming(true)}>Review reconciliation</Button>
        <Modal open={confirming} onClose={() => setConfirming(false)} title="Reconcile this command?">
          <div className="space-y-3 text-xs">
            <p>Command {owner.commandId} on {installation.nodeName}.</p>
            <p>The node’s recorded result or proof that it never ran takes precedence. Only when the node itself records an unknown outcome does Magnus sign your decision and reason. The decision is audited under your name.</p>
            <p>Verified outcome: {disposition === 'effects_verified' ? 'It took effect, fully or partly' : 'It changed nothing'}.</p>
            <p className="whitespace-pre-wrap">{reason.trim()}</p>
            <p>Reconciliation releases the command owner without running the command again. Afterwards you can resume the stopped operation.</p>
            <Button variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button>{' '}
            <Button onClick={() => void reconcile()}>Confirm reconciliation</Button>
          </div>
        </Modal>
      </>}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </li>;
}

export function CommandOwners({ installation, admin, refresh }: { installation: ArdentFleetInstallation; admin: boolean;
  refresh: () => Promise<void> }): React.ReactElement | null {
  if (!installation.commandOwners?.length) return null;
  return <section aria-label={`Unsettled commands on ${installation.nodeName}`} className="mt-3 space-y-3 rounded border border-warning/50 p-3 text-xs">
    <p className="font-semibold">Unsettled commands hold this node’s Ardent actions</p>
    <ul className="space-y-3">{installation.commandOwners.map(owner => <Owner key={owner.commandId} owner={owner}
      installation={installation} admin={admin} refresh={refresh} />)}</ul>
  </section>;
}
