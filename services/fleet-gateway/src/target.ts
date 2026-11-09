/**
 * The only way a node becomes an SSH destination: a client names a node id, the Magnus API says what
 * that node is, an operator-approved record says where and with which key. No request value reaches
 * the destination, and anything unknown refuses.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { ControlApi } from './control-api.js';
import { GatewayError } from './errors.js';
import type { KnownHosts, TrustedNode } from './known-hosts.js';

export const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;

/** Fleet nodes commonly live on private networks, so those stay reachable. These never hold one. */
const refusedAddresses = new BlockList();
refusedAddresses.addSubnet('0.0.0.0', 8, 'ipv4');
refusedAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
refusedAddresses.addSubnet('169.254.0.0', 16, 'ipv4');
refusedAddresses.addSubnet('224.0.0.0', 4, 'ipv4');
refusedAddresses.addSubnet('240.0.0.0', 4, 'ipv4');
// Cloud instance metadata services outside link-local space.
refusedAddresses.addAddress('100.100.100.200', 'ipv4');
refusedAddresses.addAddress('168.63.129.16', 'ipv4');
// The unspecified address, loopback and the deprecated IPv4-compatible range.
refusedAddresses.addSubnet('::', 96, 'ipv6');
refusedAddresses.addSubnet('fe80::', 10, 'ipv6');
refusedAddresses.addSubnet('fec0::', 10, 'ipv6');
refusedAddresses.addSubnet('ff00::', 8, 'ipv6');
refusedAddresses.addSubnet('fd00:ec2::', 64, 'ipv6');
// Translation prefixes can embed a refused IPv4 address.
refusedAddresses.addSubnet('64:ff9b::', 96, 'ipv6');
refusedAddresses.addSubnet('2002::', 16, 'ipv6');

export function isRefusedAddress(address: string): boolean {
  const family = isIP(address);
  // A zone index names a local interface, so such an address is link-local whatever else it says.
  if (family === 0 || address.includes('%')) return true;
  return refusedAddresses.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

export interface SshTarget {
  nodeId: string;
  /** What resource coordination knows this node by. */
  host: string;
  /** The exact address to dial, so a later DNS answer cannot change the destination. */
  address: string;
  port: number;
  fingerprints: string[];
  managedTerminal?: boolean;
}

export type LookupAddresses = (host: string) => Promise<string[]>;

const DNS_TIMEOUT_MS = 3_000;

/** A stuck resolver must not hold an admission slot, and libuv's small thread pool, indefinitely. */
export const lookupAddresses: LookupAddresses = async (host) => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('DNS lookup timed out')), DNS_TIMEOUT_MS);
  });
  try {
    return (await Promise.race([dnsLookup(host, { all: true, verbatim: true }), timeout])).map((record) => record.address);
  } finally {
    clearTimeout(timer);
  }
};

/** Whether a trust record could ever name this host. The operator's command checks this too. */
export const isUsableHostSyntax = (host: string): boolean => (isIP(host) ? !isRefusedAddress(host) : HOSTNAME.test(host) && !/(^|\.)localhost\.?$/i.test(host));

const sameHost = (left: string, right: string) => left.toLowerCase().replace(/\.$/, '') === right.toLowerCase().replace(/\.$/, '');

async function dialableAddress(host: string, lookup: LookupAddresses): Promise<string> {
  if (!isUsableHostSyntax(host)) throw new GatewayError('NODE_TARGET_REFUSED');
  if (isIP(host)) return host;
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new GatewayError('NODE_TARGET_REFUSED');
  }
  // One bad answer means the name cannot be trusted, even if another answer looks fine.
  if (addresses.length === 0 || addresses.some(isRefusedAddress)) throw new GatewayError('NODE_TARGET_REFUSED');
  return addresses[0]!;
}

export async function resolveSshTarget(
  nodeId: string,
  api: Pick<ControlApi, 'resolveNode'>,
  trust: KnownHosts,
  lookup: LookupAddresses = lookupAddresses,
): Promise<SshTarget> {
  const node = await api.resolveNode(nodeId);
  if (!node) throw new GatewayError('NODE_NOT_FOUND');
  if (node.nodeId !== nodeId || node.status === 'DECOMMISSIONED') throw new GatewayError('NODE_TARGET_REFUSED');
  const record: TrustedNode | undefined = trust.lookup(nodeId);
  if (!record) throw new GatewayError('HOST_KEY_UNTRUSTED');
  // Inventory addresses are node-reported, so a node moving requires a new approval.
  if (!sameHost(record.host, node.hostname) && !sameHost(record.host, node.ipAddress)) throw new GatewayError('NODE_TARGET_CHANGED');
  return {
    nodeId,
    host: node.managedTerminal ? node.hostname : record.host,
    address: await dialableAddress(record.host, lookup),
    port: record.port,
    fingerprints: record.keys.map((key) => key.fingerprint),
    ...(node.managedTerminal ? { managedTerminal: true } : {}),
  };
}
