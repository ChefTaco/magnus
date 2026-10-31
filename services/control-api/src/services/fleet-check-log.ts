import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_LOG_DIR = '/var/log/magnus/fleet-checks';
const MAX_LINE_BYTES = 1024 * 1024;

export interface FleetCheckRunLog {
  runId: string;
  kind: string;
  status: 'ok' | 'warning' | 'critical' | 'error';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  summary: string;
  counts?: Record<string, unknown>;
  data?: Record<string, unknown>;
  errors?: string[];
}

export interface FleetCheckLogFile {
  file: string;
  sizeBytes: number;
  modifiedAt: string;
}

export function getFleetCheckLogDir(): string {
  return process.env['MAGNUS_FLEET_CHECK_LOG_DIR']?.trim() || DEFAULT_LOG_DIR;
}

function safeParseRun(line: string): FleetCheckRunLog | null {
  if (!line.trim() || Buffer.byteLength(line) > MAX_LINE_BYTES) return null;
  try {
    const value = JSON.parse(line) as Partial<FleetCheckRunLog>;
    if (!value.runId || !value.kind || !value.startedAt || !value.completedAt) return null;
    return {
      runId: String(value.runId),
      kind: String(value.kind),
      status: ['ok', 'warning', 'critical', 'error'].includes(String(value.status))
        ? value.status as FleetCheckRunLog['status']
        : 'error',
      startedAt: String(value.startedAt),
      completedAt: String(value.completedAt),
      durationMs: Number(value.durationMs ?? 0),
      summary: String(value.summary ?? ''),
      counts: typeof value.counts === 'object' && value.counts ? value.counts as Record<string, unknown> : undefined,
      data: typeof value.data === 'object' && value.data ? value.data as Record<string, unknown> : undefined,
      errors: Array.isArray(value.errors) ? value.errors.map(String) : undefined,
    };
  } catch {
    return null;
  }
}

async function listLogFiles(): Promise<FleetCheckLogFile[]> {
  const dir = getFleetCheckLogDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const files = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.jsonl'))
      .map(async (entry) => {
        const fullPath = path.join(dir, entry);
        try {
          const info = await stat(fullPath);
          if (!info.isFile()) return null;
          return {
            file: entry,
            sizeBytes: info.size,
            modifiedAt: info.mtime.toISOString(),
          } satisfies FleetCheckLogFile;
        } catch {
          return null;
        }
      }),
  );

  return files
    .filter((file): file is FleetCheckLogFile => Boolean(file))
    .sort((a, b) => b.file.localeCompare(a.file));
}

export async function listFleetCheckLogFiles(): Promise<{
  directory: string;
  files: FleetCheckLogFile[];
}> {
  return {
    directory: getFleetCheckLogDir(),
    files: await listLogFiles(),
  };
}

export async function listFleetCheckRuns(options: {
  limit?: number;
  kind?: string;
} = {}): Promise<{
  directory: string;
  runs: FleetCheckRunLog[];
}> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
  const files = await listLogFiles();
  const runs: FleetCheckRunLog[] = [];
  const dir = getFleetCheckLogDir();

  for (const file of files) {
    if (runs.length >= limit) break;
    const fullPath = path.join(dir, file.file);
    let content = '';
    try {
      content = await readFile(fullPath, 'utf8');
    } catch {
      continue;
    }

    const parsed = content
      .split('\n')
      .reverse()
      .map(safeParseRun)
      .filter((run): run is FleetCheckRunLog => Boolean(run))
      .filter((run) => !options.kind || run.kind === options.kind);

    runs.push(...parsed.slice(0, limit - runs.length));
  }

  runs.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  return { directory: dir, runs: runs.slice(0, limit) };
}

export async function getLatestFleetCheckRun(kind?: string): Promise<{
  directory: string;
  run: FleetCheckRunLog | null;
}> {
  const { directory, runs } = await listFleetCheckRuns({ limit: 1, kind });
  return { directory, run: runs[0] ?? null };
}
