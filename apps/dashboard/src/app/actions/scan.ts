'use server';

import { controlNodeFetchById } from '@/lib/control-node-server';

/**
 * Server Actions for scanning nodes.
 *
 * The browser supplies only a configured control-node ID. URL and credential
 * resolution happen against protected server state before any request.
 */

interface ScanSkillResult {
  nodeId: string;
  nodeName: string;
  status: string;
  skills: Array<{
    name: string;
    version: string;
    description: string;
    author: string;
    entryPoint: string;
    dependencies: string[];
    tags: string[];
    files: Array<string | { name: string; content: string }>;
  }>;
  error?: string;
}

interface ScanCronResult {
  nodeId: string;
  nodeName: string;
  status: string;
  jobs: Array<{
    user?: string;
    name: string;
    schedule: string;
    command: string;
  }>;
  error?: string;
}

interface ScanResponse<T> {
  success: boolean;
  data?: T;
  error?: { message: string };
}

/**
 * Scan all online nodes for installed skills.
 * Runs server-side, calling the control-api directly.
 */
export async function scanSkills(
  controlNodeId: string,
): Promise<ScanResponse<ScanSkillResult[]>> {
  try {
    const scanRes = await controlNodeFetchById(controlNodeId, 'scan/skills', {
      method: 'POST',
    });

    if (scanRes.ok) {
      return (await scanRes.json()) as ScanResponse<ScanSkillResult[]>;
    }

    const text = await scanRes.text().catch(() => '');
    return {
      success: false,
      error: {
        message: scanRes.status === 404
          ? 'Control API skill scanning is unavailable; direct agent secret fallback is disabled'
          : `Control API returned ${scanRes.status}: ${text}`,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const causeMsg = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
    console.error('[scanSkills] Error:', message, causeMsg);
    return {
      success: false,
      error: { message: `Control node unreachable: ${message}${causeMsg ? ` (${causeMsg})` : ''}` },
    };
  }
}

/**
 * Scan all online nodes for cron jobs.
 * Runs server-side, calling the control-api directly.
 */
export async function scanCron(
  controlNodeId: string,
): Promise<ScanResponse<ScanCronResult[]>> {
  try {
    const scanRes = await controlNodeFetchById(controlNodeId, 'scan/cron', {
      method: 'POST',
    });

    if (scanRes.ok) {
      return (await scanRes.json()) as ScanResponse<ScanCronResult[]>;
    }

    const text = await scanRes.text().catch(() => '');
    return {
      success: false,
      error: {
        message: scanRes.status === 404
          ? 'Control API cron scanning is unavailable; direct agent secret fallback is disabled'
          : `Control API returned ${scanRes.status}: ${text}`,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const causeMsg = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
    console.error('[scanCron] Error:', message, causeMsg);
    return {
      success: false,
      error: { message: `Control node unreachable: ${message}${causeMsg ? ` (${causeMsg})` : ''}` },
    };
  }
}
