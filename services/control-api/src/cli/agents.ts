/** `magnus-server agents upgrade`: the console's "Upgrade agents" action from a shell, and `agents doctor`, its check. */
import { upgradeRemedy } from '@hivemagnus/magnus-contracts';
import { UsageError } from './args.js';

export const AGENTS_USAGE = `Usage: magnus-server agents upgrade [options] [--env-file FILE]
       magnus-server agents doctor [--nodes a,b] [--to X.Y.Z] [--heal] [--env-file FILE]
       magnus-server agents fence NODE VALUE [--env-file FILE]
       magnus-server agents stop RUN_ID [--env-file FILE]

upgrade: moves agents to the version bundled with this server (or --to). Every
selected node is checked first and blocked nodes are left out with the reason.
One canary goes first, then MAGNUS_AGENT_UPGRADE_CONCURRENCY at a time. Each
agent installs the exact version beside the running one and switches back by
itself if the new version does not report a heartbeat in time.

Only evidence about the release stops a run: an integrity or source failure at
once, a failure on the canary, ambiguous answers from canaries with nothing
confirmed, and after that MAGNUS_AGENT_UPGRADE_MAX_FAILURES reverts or failed
installs. A problem of one node (busy, enrollment, unreachable,
a lost reply) is recorded and the run goes on; transient ones are tried again at
the end. The summary lists each node needing attention, with what to do.

Exit status: 0 succeeded, 2 partial (some nodes need attention), 1 otherwise.

Options:
  --to X.Y.Z            Agent version (default: the one bundled with this server)
  --integrity sha512-…  npm integrity of that version (default: read from the registry)
  --nodes a,b           Only these nodes (names, host names or ids)
  --canary NODE         Upgrade this node first (default: the first eligible one)
  --max-failures N      Release failures that stop this run (default: MAGNUS_AGENT_UPGRADE_MAX_FAILURES)
  --allow-prerelease    Required for a prerelease version such as 1.2.0-rc.1
  --retry-reverted      Also offer nodes that already reverted this version
  --retry RUN_ID        Retry the nodes of a run that were not upgraded
  --dry-run             Show the full per-node report and start nothing

doctor: the same read-only check for every node: what each agent reports about
its layout, launcher, disk, npm, ledger, fences and enrollment, and what to do
about each problem. --heal also repairs what the server owns: it moves a fence
generation up to what the agent signs that it holds, and settles leases stuck
unknown when the agent's ledger proves they never ran. Exit status 1 when a node
is blocked.

fence: moves the server's fence generation for a node to VALUE + 1. Only ever up,
and audited. For agents older than 1.1.8, which do not say what fence they hold:
read it from .magnus/command-receipts/fence-*.json on the node.

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
  doctor?: true;
  heal?: true;
  maxFailures?: number;
  fence?: { node: string; value: string };
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
  if (sub === 'fence') {
    const [node, value, ...extra] = rest;
    if (node === '--help' || node === '-h') return 'help';
    if (!node || !value || node.startsWith('--') || extra.length) throw new UsageError('agents fence takes NODE and VALUE');
    if (!/^[1-9][0-9]{0,18}$/.test(value)) throw new UsageError('agents fence: VALUE must be a positive decimal');
    return { fence: { node, value }, dryRun: false };
  }
  if (sub !== 'upgrade' && sub !== 'doctor') throw new UsageError(`unknown agents subcommand "${sub}"`);
  const options: AgentsOptions = { dryRun: false, ...(sub === 'doctor' ? { doctor: true as const } : {}) };
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
    else if (name === '--heal' && sub === 'doctor') options.heal = true;
    else if (name === '--max-failures') {
      const budget = Number(value());
      if (!Number.isInteger(budget) || budget < 1 || budget > 1000) throw new UsageError('--max-failures must be a whole number from 1 to 1000');
      options.maxFailures = budget;
    }
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

type Report = Awaited<ReturnType<Service['checkUpgrade']>>;

const remedyLines = (item: { name: string; code: string; detail: string | null; cause: string; remedy: string; unknownCode?: boolean }) => [
  `  ${item.name}: ${item.code}${item.unknownCode ? ' [unrecognised code]' : ''}${item.detail ? ` (${item.detail})` : ''}`,
  `    cause:  ${item.cause}`,
  `    remedy: ${item.remedy}`,
];

/** What one node's check found, in the order someone would act on it. */
export function doctorLines(report: Report): string[] {
  const lines = [`Target magnus-agent ${report.version}${report.release.verified ? '' : ` (not verified on the registry: ${report.release.reason ?? 'unknown'})`}`];
  for (const node of report.nodes) {
    const preflight = node.preflight;
    const verdict = node.eligible ? 'ready' : node.code && upgradeRemedy(node.code).informational ? 'not applicable' : 'blocked';
    const facts = preflight?.report ? [preflight.report.layout, preflight.report.disk ? `${Math.floor(preflight.report.disk.freeBytes / (1024 * 1024))} MiB free` : null,
      preflight.report.npm?.version ? `npm ${preflight.report.npm.version}` : null].filter(Boolean).join(', ') : `preflight ${preflight?.status ?? 'not run'}${preflight?.detail ? `: ${preflight.detail}` : ''}`;
    lines.push(`${node.name}  ${node.version}  ${verdict}  (${facts})`);
    if (!node.eligible && node.code) lines.push(...remedyLines({ name: 'reason', code: node.code, detail: node.reason, cause: upgradeRemedy(node.code).cause, remedy: upgradeRemedy(node.code).remedy }));
    for (const problem of preflight?.problems ?? []) {
      if (problem.code === node.code) continue;
      const remedy = upgradeRemedy(problem.code);
      lines.push(...remedyLines({ name: problem.blocking ? 'blocks' : 'note', code: problem.code, detail: problem.detail, cause: remedy.cause, remedy: remedy.remedy }));
    }
    for (const healed of preflight?.healed ?? []) lines.push(`  repaired: ${healed}`);
  }
  lines.push(`${report.eligible} ready, ${report.blocked} blocked, ${report.nodes.length - report.eligible - report.blocked} not applicable.`);
  return lines;
}

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
    if (options.fence) {
      const row = await getDb().node.findFirst({ where: { OR: [{ id: options.fence.node }, { name: options.fence.node }, { hostname: options.fence.node }] }, select: { id: true, name: true } });
      if (!row) {
        console.error(`Unknown node: ${options.fence.node}`);
        return 1;
      }
      const { advanceCommandFence } = await import('../services/command-fence-repair.js');
      const moved = await advanceCommandFence({ nodeId: row.id, resourceKey: `node:${row.id}`, highWater: options.fence.value, source: 'operator', actorId: 'system:magnus-server-cli' });
      if (moved.status === 'rejected') {
        console.error(`${moved.code}: node ${row.name} ${moved.detail}`);
        return 1;
      }
      console.log(moved.status === 'advanced' ? `${row.name}: fence generation moved from ${moved.from} to ${moved.to}.` : `${row.name}: the fence generation is already past ${options.fence.value}; nothing changed.`);
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
    if (options.doctor) {
      const report = await service.checkUpgrade({ version: options.to, integrity: options.integrity, nodeIds, heal: options.heal ?? false, deps, allowRetryReverted: options.retryReverted });
      for (const line of doctorLines(report)) console.log(line);
      return report.blocked ? 1 : 0;
    }
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
        allowRetryReverted: options.retryReverted, allowPrerelease: options.allowPrerelease, ...(options.maxFailures ? { maxFailures: options.maxFailures } : {}) });
      console.log(`Retrying run ${options.retry} as ${started.run.id}: ${started.run.nodes.length} agent(s) to ${started.run.version}`);
    } else {
      const release = await service.resolveAgentRelease({ version: options.to, integrity: options.integrity });
      console.log(`magnus-agent ${release.version} (${release.integrity.slice(0, 19)}…)`);
      const showCandidates = (candidates: Awaited<ReturnType<Service['listUpgradeCandidates']>>) => {
        for (const candidate of candidates) {
          console.log(`  ${candidate.eligible ? '→' : '·'} ${candidate.name.padEnd(28)} ${candidate.version.padEnd(12)} ${candidate.eligible ? 'will upgrade' : candidate.reason}`);
        }
      };
      if (options.dryRun) {
        const report = await service.checkUpgrade({ version: release.version, integrity: release.integrity, nodeIds, deps, everyOnlineNode: false, allowRetryReverted: options.retryReverted });
        showCandidates(report.nodes);
        for (const node of report.nodes) {
          if (!node.eligible && node.code && !upgradeRemedy(node.code).informational) console.log(`    ${node.name}: ${node.code}: ${node.remedy}`);
          if (node.preflight?.status === 'unavailable') console.log(`    ${node.name}: preflight unavailable (${node.preflight.detail ?? 'older agent'}); heartbeat data was used`);
        }
        console.log(`Dry run: ${report.eligible} of ${report.nodes.length} agent(s) would be upgraded.`);
        return 0;
      }
      try {
        started = await service.startUpgradeRun({ version: release.version, integrity: release.integrity, nodeIds, canaryNodeId, allowPrerelease: options.allowPrerelease,
          allowRetryReverted: options.retryReverted, actorId: 'system:magnus-server-cli', deps, ...(options.maxFailures ? { maxFailures: options.maxFailures } : {}) });
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'NO_ELIGIBLE_AGENTS') throw error;
        const candidates = await service.listUpgradeCandidates(release.version, nodeIds, { allowRetryReverted: options.retryReverted });
        showCandidates(candidates);
        console.log('Nothing to upgrade.');
        return candidates.some(candidate => candidate.reason !== 'already on this version') ? 1 : 0;
      }
      showCandidates(started.candidates);
      for (const candidate of started.candidates) for (const healed of candidate.preflight?.healed ?? []) console.log(`    ${candidate.name}: repaired: ${healed}`);
      for (const warning of started.run.warnings ?? []) console.warn(`    ${warning.name}: ${warning.code}: ${warning.detail}`);
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
      if (run.suspectedRelease) console.log(`Suspected release problem: ${run.suspectedRelease}`);
      if (run.attention?.length) {
        console.log(`Needs attention (${run.attention.length}):`);
        for (const item of run.attention) for (const line of remedyLines(item)) console.log(line);
      }
      console.log(`${run.status === 'succeeded' ? 'Done' : run.status === 'partial' ? 'Partial' : run.status === 'stopped' ? 'Stopped' : 'Failed'}: ${run.message ?? run.status}`);
      console.log(`Run ${run.id}${run.nodes.every(node => node.state === 'confirmed') && !run.attention?.length ? '' : `; retry the rest with: magnus-server agents upgrade --retry ${run.id}`}`);
      return run.status === 'succeeded' ? 0 : run.status === 'partial' ? 2 : 1;
    } finally {
      process.off('SIGINT', onSigint);
    }
  } finally {
    await disconnectDb().catch(() => undefined);
    await disconnectRedis().catch(() => undefined);
  }
}
