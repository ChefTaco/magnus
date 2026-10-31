import { createHash } from 'node:crypto';

export interface SkillPublicationIdentity {
  nodeId: string;
  skillName: string;
  version: string;
  versionHash: string;
  bundleSha256: string;
  treeSha256: string;
}

export interface SkillInstallationPublicationState {
  version: string;
  status: string;
  versionHash: string | null;
  bundleSha256: string | null;
  treeSha256: string | null;
  workflowCommandId: string | null;
  workflowRequestSha256: string | null;
  workflowReceiptSha256: string | null;
}

/** The command ledger is the durable successor journal while the installation
 * row continues to describe the last receipt-proven installation. */
function publicationCommandId(identity: SkillPublicationIdentity, retryAfterCommandId?: string): string {
  const digest = createHash('sha256').update(JSON.stringify({
    domain: 'magnus.skill-publication-workflow.v1',
    nodeId: identity.nodeId,
    skillName: identity.skillName,
    version: identity.version,
    versionHash: identity.versionHash,
    bundleSha256: identity.bundleSha256,
    treeSha256: identity.treeSha256,
    ...(retryAfterCommandId ? { retryAfterCommandId } : {}),
  })).digest('hex');
  return `skill-${digest}`;
}

export function skillPublicationCommandId(identity: SkillPublicationIdentity): string {
  return publicationCommandId(identity);
}

/** Advance only from a durable no-effect settlement. Including the prior ID
 * keeps every retry generation bound to one exact, auditable predecessor. */
export function nextSkillPublicationCommandId(
  identity: SkillPublicationIdentity,
  retryAfterCommandId: string,
): string {
  return publicationCommandId(identity, retryAfterCommandId);
}

export function isSameSkillPublication(
  state: Pick<SkillInstallationPublicationState, 'version' | 'versionHash' | 'bundleSha256' | 'treeSha256'>,
  identity: SkillPublicationIdentity,
): boolean {
  return state.version === identity.version
    && state.versionHash === identity.versionHash
    && state.bundleSha256 === identity.bundleSha256
    && state.treeSha256 === identity.treeSha256;
}

export function isExactInstalledPublication(
  state: SkillInstallationPublicationState,
  identity: SkillPublicationIdentity,
  evidence?: { commandId: string; commandSha256: string; receiptSha256: string },
): boolean {
  if (state.status !== 'installed' || !state.workflowCommandId
    || !state.workflowRequestSha256 || !state.workflowReceiptSha256
    || !isSameSkillPublication(state, identity)) return false;
  return !evidence || (state.workflowCommandId === evidence.commandId
    && state.workflowRequestSha256 === evidence.commandSha256
    && state.workflowReceiptSha256 === evidence.receiptSha256);
}
