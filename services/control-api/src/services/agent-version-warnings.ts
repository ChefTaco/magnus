import { compareVersions, isVersion } from '@hivemagnus/magnus-contracts';
import { agentFixCommand } from './update-check-service.js';

export interface AgentVersionStatus {
  /** The agent is older than the version this server ships with. */
  updateAvailable: boolean;
  relation: 'current' | 'behind' | 'ahead' | 'unknown';
}

export function agentVersionStatus(agentVersion: string | undefined, expected: string): AgentVersionStatus {
  if (!agentVersion || !isVersion(agentVersion) || !isVersion(expected)) return { updateAvailable: false, relation: 'unknown' };
  const order = compareVersions(agentVersion, expected);
  return { updateAvailable: order < 0, relation: order === 0 ? 'current' : order < 0 ? 'behind' : 'ahead' };
}

const warned = new Map<string, string>();

/**
 * One loud log line per node and version pair, with the exact fix. Mixed
 * versions work within a major, but features and fixes need matching agents.
 */
export function warnOnAgentVersionMismatch(node: { id: string; name: string }, agentVersion: string | undefined, expected: string,
  log: (line: string) => void = line => console.warn(line)): AgentVersionStatus {
  const status = agentVersionStatus(agentVersion, expected);
  if (status.relation !== 'behind' && status.relation !== 'ahead') {
    warned.delete(node.id);
    return status;
  }
  const key = `${agentVersion}->${expected}`;
  if (warned.get(node.id) === key) return status;
  warned.set(node.id, key);
  const major = agentVersion!.split('.')[0] !== expected.split('.')[0];
  log(status.relation === 'behind'
    ? `[agents] VERSION MISMATCH: node ${node.name} runs magnus-agent ${agentVersion}, this server ships ${expected}`
      + `${major ? ' (different major version: some features will not work)' : ''}. Fix: ${agentFixCommand([node.name])}`
    : `[agents] VERSION MISMATCH: node ${node.name} runs magnus-agent ${agentVersion}, newer than this server (${expected}). Upgrade the server: magnus upgrade`);
  return status;
}
