/**
 * Log Collector — tails systemd journal and batch-ships log entries
 * to the control API's /logs/ingest endpoint.
 *
 * Opt-in via ENABLE_LOG_FORWARDING=true (default: false).
 * Filters by LOG_UNITS env (comma-separated systemd unit patterns).
 * Ships batches every 5 seconds to avoid overwhelming the API.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import ky from 'ky';
import { logger } from '../utils/logger.js';
import { CONTROL_API_URL, LOG_INGEST_TOKEN } from '../env.js';
import { getFqdn } from '../fqdn.js';
import { controlApiFetch } from '../tls.js';

export const ENABLE_LOG_FORWARDING =
  (process.env['ENABLE_LOG_FORWARDING'] ?? 'false').toLowerCase() === 'true';

const LOG_UNITS = (process.env['LOG_UNITS'] ?? '')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);

const FLUSH_INTERVAL_MS = 5_000;
const MAX_QUEUE_SIZE = 500;
const BATCH_SIZE = 50;

export interface LogEntry {
  nodeId: string;
  source: string;
  level: string;
  message: string;
  metadata: Record<string, unknown>;
  timestamp: string;
}

/**
 * FIFO queue with a hard ingress ceiling. Failed batches are restored ahead of
 * newer entries and displace from the tail, so retries cannot grow memory or
 * silently reorder the oldest unsent logs.
 */
export class BoundedLogQueue {
  readonly #entries: LogEntry[] = [];

  public constructor(readonly maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error('maxEntries must be a positive integer');
    }
  }

  public get length(): number {
    return this.#entries.length;
  }

  public enqueue(entry: LogEntry): boolean {
    if (this.#entries.length >= this.maxEntries) return false;
    this.#entries.push(entry);
    return true;
  }

  public take(limit: number): LogEntry[] {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    return this.#entries.splice(0, limit);
  }

  /** Restore a failed batch and return any newer entries displaced by the cap. */
  public requeueFront(entries: readonly LogEntry[]): LogEntry[] {
    const restored = entries.slice(0, this.maxEntries);
    const dropped = entries.slice(this.maxEntries);
    while (this.#entries.length + restored.length > this.maxEntries) {
      const displaced = this.#entries.pop();
      if (!displaced) break;
      dropped.push(displaced);
    }
    this.#entries.unshift(...restored);
    return dropped;
  }
}

/** Coalesce threshold and timer flushes into one in-flight network request. */
export function singleFlight<T>(operation: () => Promise<T>): () => Promise<T> {
  let active: Promise<T> | null = null;
  return () => {
    if (active) return active;
    active = operation().finally(() => {
      active = null;
    });
    return active;
  };
}

const queue = new BoundedLogQueue(MAX_QUEUE_SIZE);
let flushTimer: NodeJS.Timeout | null = null;
let journalProc: ChildProcess | null = null;
let nodeId = '';

/** Map journald priority numbers to log levels. */
function priorityToLevel(priority: string): string {
  switch (priority) {
    case '0': case '1': case '2': return 'error';   // emerg, alert, crit
    case '3': return 'error';
    case '4': return 'warning';
    case '5': return 'notice';
    case '6': return 'info';
    case '7': return 'debug';
    default: return 'info';
  }
}

/** Parse a journald JSON line into a LogEntry. */
function parseJournalLine(line: string): LogEntry | null {
  try {
    const j = JSON.parse(line) as Record<string, string>;
    return {
      nodeId,
      source: j['_SYSTEMD_UNIT'] ?? j['SYSLOG_IDENTIFIER'] ?? 'system',
      level: priorityToLevel(j['PRIORITY'] ?? '6'),
      message: j['MESSAGE'] ?? '',
      metadata: {
        hostname: j['_HOSTNAME'] ?? getFqdn(),
        unit: j['_SYSTEMD_UNIT'] ?? '',
        pid: j['_PID'] ?? '',
      },
      timestamp: j['__REALTIME_TIMESTAMP']
        ? new Date(parseInt(j['__REALTIME_TIMESTAMP'], 10) / 1000).toISOString()
        : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** Flush queued log entries to the control API. */
async function flushOnce(): Promise<void> {
  if (queue.length === 0) return;

  const batch = queue.take(BATCH_SIZE);
  try {
    await ky.post(`${CONTROL_API_URL}/api/v1/logs/ingest`, {
      json: batch,
      headers: { 'x-log-token': LOG_INGEST_TOKEN },
      timeout: 10_000,
      fetch: controlApiFetch,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('LogCollector: Failed to ship batch, re-queuing', {
      error: msg,
      batchSize: batch.length,
    });
    const dropped = queue.requeueFront(batch);
    if (dropped.length > 0) {
      logger.error('LogCollector: Queue full during retry, dropping newer entries', {
        dropped: dropped.length,
      });
    }
  }
}

const flush = singleFlight(flushOnce);

const RESTART_BASE_MS = 5_000;
const RESTART_MAX_MS = 5 * 60_000;
const DROP_REPORT_INTERVAL_MS = 60_000;
let collectorRunning = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let restartAttempts = 0;
let droppedAtIngress = 0;
let dropReportTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Report ingress drops as one periodic summary. Logging each dropped entry
 * would write new journal lines that this collector then reads back.
 */
function reportDrops(): void {
  if (droppedAtIngress === 0) return;
  logger.warn('LogCollector: Queue full at ingress, dropped entries', { dropped: droppedAtIngress, maxQueueSize: MAX_QUEUE_SIZE });
  droppedAtIngress = 0;
}

function scheduleRestart(args: string[]): void {
  if (!collectorRunning || restartTimer) return;
  const delayMs = Math.min(RESTART_BASE_MS * 2 ** restartAttempts, RESTART_MAX_MS);
  restartAttempts++;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    spawnJournal(args);
  }, delayMs);
  restartTimer.unref();
}

function spawnJournal(args: string[]): void {
  if (!collectorRunning) return;
  let proc: ChildProcess;
  try {
    proc = spawn('journalctl', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    logger.warn('LogCollector: journalctl could not start', { error: err instanceof Error ? err.message : String(err) });
    scheduleRestart(args);
    return;
  }
  journalProc = proc;

  let buffer = '';

  proc.stdout?.on('data', (chunk: Buffer) => {
    restartAttempts = 0;
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = parseJournalLine(line);
      if (entry && entry.message) {
        if (!queue.enqueue(entry)) {
          droppedAtIngress++;
          continue;
        }
        // Flush if batch full
        if (queue.length >= BATCH_SIZE) {
          void flush();
        }
      }
    }
  });

  // ENOENT and similar spawn failures arrive asynchronously as 'error'.
  proc.on('error', (err) => {
    logger.warn('LogCollector: journalctl failed', { error: err.message });
  });

  proc.on('close', (code, signal) => {
    if (journalProc === proc) journalProc = null;
    if (!collectorRunning) return;
    logger.warn('LogCollector: journalctl process exited; restarting', { code, signal });
    scheduleRestart(args);
  });
}

/** Start tailing the systemd journal and shipping logs. */
export function startLogCollector(agentNodeId: string): void {
  if (!ENABLE_LOG_FORWARDING || collectorRunning) return;

  nodeId = agentNodeId;
  collectorRunning = true;
  restartAttempts = 0;

  // Build journalctl args
  const args = ['-f', '-o', 'json', '--since', '5 seconds ago'];
  for (const unit of LOG_UNITS) {
    args.push('-u', unit);
  }

  spawnJournal(args);

  // Periodic flush
  flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  dropReportTimer = setInterval(reportDrops, DROP_REPORT_INTERVAL_MS);
  dropReportTimer.unref();

  logger.info('LogCollector: Started', {
    units: LOG_UNITS.length > 0 ? LOG_UNITS : ['all'],
    flushIntervalMs: FLUSH_INTERVAL_MS,
  });
}

/** Stop the log collector and flush remaining entries. */
export async function stopLogCollector(): Promise<void> {
  collectorRunning = false;
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (dropReportTimer) {
    clearInterval(dropReportTimer);
    dropReportTimer = null;
  }
  reportDrops();

  if (journalProc) {
    journalProc.kill('SIGTERM');
    journalProc = null;
  }

  await flush();
  logger.info('LogCollector: Stopped');
}
