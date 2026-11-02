/**
 * Operator-reviewed historical mutation records, from a root-controlled file
 * (MAGNUS_AGENT_REVIEWED_HISTORICAL_RECORDS, default
 * /etc/magnus/reviewed-historical-records.json). Only records listed there can
 * be settled by, or count as settled through, a signed historical receipt.
 *
 * Read once when the agent starts, so the set cannot change under a running
 * drain; edit the file and restart the agent to change it. A missing file is
 * the empty set. A file that root does not control (not owned by uid 0, group-
 * or world-writable, a symlink, in such a directory) or that fails the schema
 * is refused as a whole: the set is empty and the reason is logged.
 *
 * {
 *   "version": 1,
 *   "records": {
 *     "<record id (UUID)>": { "nodeFqdn": "node-1.example.com", "recordSha256": "<64 hex>" }
 *   }
 * }
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

export const DEFAULT_REVIEWED_HISTORICAL_RECORDS_PATH = '/etc/magnus/reviewed-historical-records.json';
export const REVIEWED_RECORDS_MAX_BYTES = 1024 * 1024;

export type ReviewedHistoricalRecords = Readonly<Record<string, Readonly<{ nodeFqdn: string; recordSha256: string }>>>;

const reviewedFileSchema = z.object({
  version: z.literal(1),
  records: z.record(z.string().guid(), z.object({
    nodeFqdn: z.string().min(1).max(253),
    recordSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()),
}).strict();

export interface ReviewedRecordsLoad {
  path: string;
  records: ReviewedHistoricalRecords;
  /** Entries for this node that were loaded. */
  count: number;
  /** Why the file was refused, or null (also when it is absent). */
  problem: string | null;
}

export interface LoadOptions {
  path?: string;
  hostname: string;
  /** Owner the file and its directory must have; 0 (root) except in tests. */
  ownerUid?: number;
}

function controlled(info: Stats, what: string, ownerUid: number): string | null {
  if (info.isSymbolicLink()) return `${what} is a symlink`;
  if (info.uid !== ownerUid) return `${what} is owned by uid ${info.uid}, not ${ownerUid === 0 ? 'root' : ownerUid}`;
  if (info.mode & 0o022) return `${what} is group- or world-writable`;
  return null;
}

const empty: ReviewedHistoricalRecords = Object.freeze({});

export function loadReviewedHistoricalRecords(options: LoadOptions): ReviewedRecordsLoad {
  const path = resolve(options.path || DEFAULT_REVIEWED_HISTORICAL_RECORDS_PATH);
  const ownerUid = options.ownerUid ?? 0;
  const refuse = (problem: string): ReviewedRecordsLoad => ({ path, records: empty, count: 0, problem });
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, records: empty, count: 0, problem: null };
    return refuse(`cannot inspect ${path}: ${(error as Error).message}`);
  }
  const problem = controlled(info, path, ownerUid);
  if (problem) return refuse(problem);
  if (!info.isFile()) return refuse(`${path} is not a regular file`);
  if (info.size > REVIEWED_RECORDS_MAX_BYTES) return refuse(`${path} is larger than ${REVIEWED_RECORDS_MAX_BYTES} bytes`);
  let parent: Stats;
  try { parent = lstatSync(dirname(path)); } catch (error) { return refuse(`cannot inspect ${dirname(path)}: ${(error as Error).message}`); }
  const parentProblem = controlled(parent, dirname(path), ownerUid);
  if (parentProblem) return refuse(parentProblem);
  if (!parent.isDirectory()) return refuse(`${dirname(path)} is not a directory`);

  let text: string;
  try {
    // O_NOFOLLOW and the same inode as inspected: the file cannot be swapped in between.
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size > REVIEWED_RECORDS_MAX_BYTES) return refuse(`${path} changed while it was read`);
      const buffer = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < buffer.length) {
        const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (read === 0) break;
        offset += read;
      }
      text = buffer.subarray(0, offset).toString('utf8');
    } finally { closeSync(fd); }
  } catch (error) {
    return refuse(`cannot read ${path}: ${(error as Error).message}`);
  }
  let parsed: z.infer<typeof reviewedFileSchema>;
  try {
    const result = reviewedFileSchema.safeParse(JSON.parse(text));
    if (!result.success) return refuse(`${path} does not match the schema: ${result.error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
    parsed = result.data;
  } catch (error) {
    return refuse(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  // Entries for other nodes are ignored, so one file can serve a whole fleet.
  const records: Record<string, Readonly<{ nodeFqdn: string; recordSha256: string }>> = {};
  for (const [id, entry] of Object.entries(parsed.records)) {
    if (entry.nodeFqdn === options.hostname) records[id] = Object.freeze({ nodeFqdn: entry.nodeFqdn, recordSha256: entry.recordSha256 });
  }
  return { path, records: Object.freeze(records), count: Object.keys(records).length, problem: null };
}
