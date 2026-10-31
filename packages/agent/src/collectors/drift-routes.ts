import { Hono } from 'hono';
import { z } from 'zod';
import { runDriftScan } from './drift-collector.js';

export const driftRoutes = new Hono();

const driftScanSchema = z.object({
  checks: z.array(z.object({
    type: z.enum(['package', 'file', 'service', 'sysctl', 'user']),
    name: z.string().min(1).max(4096),
    expected: z.string().max(4096),
  })).min(1).max(500),
});

/**
 * POST /drift/scan
 * Accept a list of expected checks and return drift findings.
 * Called by the control API to assess node compliance.
 */
driftRoutes.post('/scan', async (c) => {
  const parsed = driftScanSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ success: false, error: 'checks array is required' }, 400);
  }

  const findings = await runDriftScan(parsed.data);
  const driftCount = findings.filter((f) => f.status === 'drifted' || f.status === 'missing').length;

  return c.json({
    success: true,
    data: {
      status: driftCount > 0 ? 'drifted' : 'clean',
      totalChecks: findings.length,
      driftCount,
      findings,
    },
  });
});
