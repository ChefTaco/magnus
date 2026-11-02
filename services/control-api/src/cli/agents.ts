/** `magnus-server agents upgrade`: the console's "Upgrade agents" action from a shell. */
import { UsageError } from './args.js';

export const AGENTS_USAGE = `Usage: magnus-server agents upgrade [options] [--env-file FILE]
       magnus-server agents stop RUN_ID [--env-file FILE]

Upgrades agents to the version bundled with this server (or --to), one canary
first, then MAGNUS_AGENT_UPGRADE_CONCURRENCY at a time. Each agent installs the
exact version beside the running one and switches back by itself if the new
version does not report a heartbeat in time. A revert, a release problem or an
agent that goes silent stops the run; an agent that refuses before changing
anything (busy, enrollment, unreachable) is reported as refused and the run
goes on.

Options:
  --to X.Y.Z            Agent version (default: the one bundled with this server)
  --integrity sha512-…  npm integrity of that version (default: read from the registry)
  --nodes a,b           Only these nodes (names, host names or ids)
  --canary NODE         Upgrade this node first (default: the first eligible one)
  --allow-prerelease    Required for a prerelease version such as 1.2.0-rc.1
  --retry-reverted      Also offer nodes that already reverted this version
  --retry RUN_ID        Retry the failed, refused, skipped and interrupted nodes of a run
  --dry-run             Show which agents would be upgraded, and why others would not

Ctrl-C asks the run to stop after the nodes in progress; a second Ctrl-C leaves
at once, and the run is then shown as interrupted.

Agents are called over TLS. NODE_EXTRA_CA_CERTS from --env-file is honoured, so
the command trusts the same CA as the service.`;

interface AgentsOptions {
  to?: string;
  integrity?: string;
  nodes?: string[];
  canary?: string;
  allowPrerelease?: true;
  retryReverted?: true;
  retry?: string;
  stop?: string;
  dryRun: boolean;
}

export function parseAgentsArgs(args: readonly string[]): AgentsOptions | 'help' {
  const [sub, ...rest] = args;
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') return 'help';
  if (sub === 'stop') {
    const [id, ...extra] = rest;
    if (id === '--help' || id === '-h') return 'help';
    if (!id || id.startsWith('--') || extra.length) throw new UsageError('agents stop takes one RUN_ID');
    return { stop: id, dryRun: false };
  }
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
    else if (name === '--canary') options.canary = value();
    else if (name === '--retry') options.retry = value();
    else if (name === '--allow-prerelease') options.allowPrerelease = true;
    else if (name === '--retry-reverted') options.retryReverted = true;
    else if (name === '--dry-run') options.dryRun = true;
    else if (name === '--help' || name === '-h') return 'help';
    else throw new UsageError(`unknown option ${name}`);
  }
  if (options.nodes?.length === 0) throw new UsageError('--nodes needs at least one node');
  if (options.retry && (options.to || options.integrity || options.nodes || options.dryRun))
    throw new UsageError('--retry reuses the version, integrity and nodes of that run; drop --to, --integrity, --nodes and --dry-run');
  return options;
}

type Service = typeof import('../services/agent-upgrade-service.js');
type Run = Awaited<ReturnType<Service['executeUpgradeRun']>>;

const nodeLine = (node: Run['nodes'][number]) =>
  `  ${node.name}: ${node.state}${node.detail ? ` (${node.code ? `${node.code}: ` : ''}${node.detail})` : node.code ? ` (${node.code})` : ''}`;

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
    if (options.stop) {
      const run = await service.stopUpgradeRun(options.stop, 'system:magnus-server-cli');
      console.log(`Asked run ${run.id} to stop; it stops before its next batch.`);
      return 0;
    }
    const resolveNodes = async (names: string[]) => {
      const rows = await getDb().node.findMany({
        where: { OR: [{ id: { in: names } }, { name: { in: names } }, { hostname: { in: names } }] },
        select: { id: true, name: true, hostname: true },
      });
      const unknown = names.filter(node => !rows.some(row => row.id === node || row.name === node || row.hostname === node));
      return { ids: rows.map(row => row.id), unknown, byName: (name: string) => rows.find(row => row.id === name || row.name === name || row.hostname === name)?.id };
    };
    let nodeIds: string[] | undefined;
    let canaryNodeId: string | undefined;
    const wanted = [...options.nodes ?? [], ...options.canary ? [options.canary] : []];
    if (wanted.length) {
      const resolved = await resolveNodes(wanted);
      if (resolved.unknown.length) {
        console.error(`Unknown node(s): ${resolved.unknown.join(', ')}`);
        return 1;
      }
      if (options.nodes) nodeIds = options.nodes.map(name => resolved.byName(name)!);
      if (options.canary) canaryNodeId = resolved.byName(options.canary);
    }
    const deps = service.defaultDeps();
    const seen = new Map<string, string>();
    const save = deps.save;
    deps.save = async run => {
      for (const node of run.nodes) {
        if (seen.get(node.nodeId) === node.state) continue;
        seen.set(node.nodeId, node.state);
        if (node.state !== 'pending') console.log(nodeLine(node));
      }
      await save(run);
    };
    let started: Awaited<ReturnType<Service['startUpgradeRun']>>;
    if (options.retry) {
      started = await service.retryUpgradeRun(options.retry, { actorId: 'system:magnus-server-cli', deps, canaryNodeId,
        allowRetryReverted: options.retryReverted, allowPrerelease: options.allowPrerelease });
      console.log(`Retrying run ${options.retry} as ${started.run.id}: ${started.run.nodes.length} agent(s) to ${started.run.version}`);
    } else {
      const release = await service.resolveAgentRelease({ version: options.to, integrity: options.integrity });
      const candidates = await service.listUpgradeCandidates(release.version, nodeIds, { allowRetryReverted: options.retryReverted });
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
      started = await service.startUpgradeRun({ version: release.version, integrity: release.integrity, nodeIds: eligible.map(node => node.nodeId),
        canaryNodeId, allowPrerelease: options.allowPrerelease, allowRetryReverted: options.retryReverted, actorId: 'system:magnus-server-cli', deps });
    }
    let interrupts = 0;
    const onSigint = () => {
      if (++interrupts > 1) {
        console.error('Leaving now; the run shows as interrupted once its lease runs out.');
        process.exit(130);
      }
      console.error('Stopping after the nodes in progress (Ctrl-C again to leave now)…');
      void service.stopUpgradeRun(started.run.id, 'system:magnus-server-cli').catch(() => undefined);
    };
    process.on('SIGINT', onSigint);
    try {
      const run = await started.done;
      for (const node of run.excluded ?? []) if (options.nodes || options.retry) console.log(`  ${node.name}: not upgraded (${node.reason})`);
      console.log(`${run.status === 'succeeded' ? 'Done' : run.status === 'stopped' ? 'Stopped' : 'Failed'}: ${run.message ?? run.status}`);
      console.log(`Run ${run.id}${run.nodes.every(node => node.state === 'confirmed') ? '' : `; retry the rest with: magnus-server agents upgrade --retry ${run.id}`}`);
      return run.status === 'succeeded' ? 0 : 1;
    } finally {
      process.off('SIGINT', onSigint);
    }
  } finally {
    await disconnectDb().catch(() => undefined);
    await disconnectRedis().catch(() => undefined);
  }
}
