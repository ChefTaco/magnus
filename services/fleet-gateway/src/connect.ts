/** Admission order for a new shell. No SSH connection exists until every earlier step has passed. */
import { ParticipantRefused, type ControlApi } from './control-api.js';
import { GatewayError } from './errors.js';
import type { KnownHosts } from './known-hosts.js';
import { TargetMismatch, type ManagedWork, type ResourceParticipant } from './participant.js';
import type { OpenRequest } from './sessions.js';
import type { ShellChannel, ShellConnector } from './ssh.js';
import { resolveSshTarget, lookupAddresses, type LookupAddresses } from './target.js';

export interface ConnectDependencies {
  api: Pick<ControlApi, 'resolveNode'>;
  knownHosts: KnownHosts;
  participant: Pick<ResourceParticipant, 'begin'>;
  shell: ShellConnector;
  lookup?: LookupAddresses;
}

export function createConnect({ api, knownHosts, participant, shell, lookup = lookupAddresses }: ConnectDependencies) {
  return async (request: OpenRequest, lifetimeMs: number): Promise<{ channel: ShellChannel; work: ManagedWork }> => {
    const target = await resolveSshTarget(request.nodeId, api, knownHosts, lookup);
    let work: ManagedWork;
    try {
      work = await participant.begin(target.host, target.nodeId, lifetimeMs);
    } catch (error) {
      if (error instanceof TargetMismatch) throw new GatewayError('NODE_TARGET_CHANGED');
      if (error instanceof ParticipantRefused) throw new GatewayError('RESOURCE_ADMISSION_REFUSED', error.upstreamCode ?? undefined);
      throw new GatewayError('CONTROL_API_UNAVAILABLE');
    }
    try {
      return { channel: await shell(target, request.size), work };
    } catch (error) {
      // The connection may have reached the node, so this stays "unknown" for a reviewed reconcile.
      work.finish('unknown').catch(() => console.error(JSON.stringify({ type: 'settlement-unacknowledged', workId: work.workId })));
      throw error instanceof GatewayError ? error : new GatewayError('SSH_CONNECT_FAILED');
    }
  };
}
