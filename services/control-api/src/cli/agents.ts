/** `magnus-server agents upgrade`: the console's "Upgrade agents" action from a shell. */
import { UsageError } from './args.js';

export const AGENTS_USAGE = `Usage: magnus-server agents upgrade [options] [--env-file FILE]

Upgrades agents to the version this server ships with (or --to), one canary
first, then MAGNUS_AGENT_UPGRADE_CONCURRENCY at a time. Each agent installs the
exact version beside the running one and switches back by itself if the new
version does not report a heartbeat in time. Stops at the first failure.

Options:
  --to X.Y.Z            Agent version (default: the one bundled with this server)
  --integrity sha512-…  npm integrity of that version (default: read from the registry)
  --nodes a,b           Only these nodes (names, host names or ids)
  --dry-run             Show which agents would be upgraded, and why others would not

Agents are called over TLS. NODE_EXTRA_CA_CERTS from --env-file is honoured, so
the command trusts the same CA as the service.`;

interface AgentsOptions {
  to?: string;
  integrity?: string;
  nodes?: string[];
  dryRun: boolean;
}

export function parseAgentsArgs(args: readonly string[]): AgentsOptions | 'help' {
  const [sub, ...rest] = args;
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') return 'help';
  if (sub !== 'upgrade') throw new UsageError(`unknown agents subcommand "${sub}"`);
  const options: AgentsOptions = { dryRun: false };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    const [name, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      const next = inline ?? rest[++index];
      if (!next || next.startsWith('--')) throw new UsageError(`${name} requires a value`);
      return next;
    };
    if (name === '--to') options.to = value();
    else if (name === '--integrity') options.integrity = value();
    else if (name === '--nodes') options.nodes = value().split(',').map(node => node.trim()).filter(Boolean);
    else if (name === '--dry-run') options.dryRun = true;
    else if (name === '--help' || name === '-h') return 'help';
    else throw new UsageError(`unknown option ${name}`);
  }
  return options;
}

export async function commandAgents(args: readonly string[]): Promise<number> {
  const options = parseAgentsArgs(args);
  if (options === 'help') {
    console.log(AGENTS_USAGE);
    return 0;
  }
  const { getDb, disconnectDb } = await import('../db/client.js');
  const { disconnectRedis } = await import('../queue/redis.js');
  const service = await import('../services/agent-upgrade-service.js');
  try {
    let nodeIds: string[] | undefined;
    if (options.nodes) {
      const rows = await getDb().node.findMany({
        where: { OR: [{ id: { in: options.nodes } }, { name: { in: options.nodes } }, { hostname: { in: options.nodes } }] },
        select: { id: true, name: true, hostname: true },
      });
      const unknown = options.nodes.filter(node => !rows.some(row => row.id === node || row.name === node || row.hostname === node));
      if (unknown.length) {
        console.error(`Unknown node(s): ${unknown.join(', ')}`);
        return 1;
      }
      nodeIds = rows.map(row => row.id);
    }
    const release = await service.resolveAgentRelease({ version: options.to, integrity: options.integrity });
    const candidates = await service.listUpgradeCandidates(release.version, nodeIds);
    console.log(`magnus-agent ${release.version} (${release.integrity.slice(0, 19)}…)`);
    for (const candidate of candidates) {
      console.log(`  ${candidate.eligible ? '→' : '·'} ${candidate.name.padEnd(28)} ${candidate.version.padEnd(12)} ${candidate.eligible ? 'will upgrade' : candidate.reason}`);
    }
    const eligible = candidates.filter(candidate => candidate.eligible);
    if (options.dryRun) {
      console.log(`Dry run: ${eligible.length} of ${candidates.length} agent(s) would be upgraded.`);
      return 0;
    }
    if (eligible.length === 0) {
      console.log('Nothing to upgrade.');
      return candidates.some(candidate => candidate.reason !== 'already on this version') ? 1 : 0;
    }
    const deps = service.defaultDeps();
    const seen = new Map<string, string>();
    const save = deps.save;
    deps.save = async run => {
      for (const node of run.nodes) {
        if (seen.get(node.nodeId) === node.state) continue;
        seen.set(node.nodeId, node.state);
        if (node.state !== 'pending') console.log(`  ${node.name}: ${node.state}${node.detail ? ` (${node.detail})` : ''}`);
      }
      await save(run);
    };
    const { done } = await service.startUpgradeRun({ version: release.version, integrity: release.integrity, nodeIds: eligible.map(node => node.nodeId),
      actorId: 'system:magnus-server-cli', deps });
    const run = await done;
    console.log(`${run.status === 'succeeded' ? 'Done' : 'Stopped'}: ${run.message ?? run.status}`);
    return run.status === 'succeeded' ? 0 : 1;
  } finally {
    await disconnectDb().catch(() => undefined);
    await disconnectRedis().catch(() => undefined);
  }
}
