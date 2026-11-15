import { Hono } from 'hono';
import { collectSystemHealth } from './health-collector.js';
import { enableSystemUpdates } from './system-updates.js';
import { collectSoftwareStatus } from './software-status.js';

export const healthRoutes = new Hono();

healthRoutes.get('/software', async c => c.json({ success: true, data: await collectSoftwareStatus() }));

// ── Collect and return full health snapshot ──
healthRoutes.get('/collect', async (c) => {
  const health = await collectSystemHealth();
  return c.json({ success: true, data: health });
});

healthRoutes.post('/system-updates/enable', async (c) => {
  try {
    const systemUpdates = await enableSystemUpdates();
    return c.json({ success: true, data: systemUpdates });
  } catch (err) {
    return c.json({
      success: false,
      error: { code: 'SYSTEM_UPDATE_ENABLE_FAILED', message: err instanceof Error ? err.message : String(err) },
    }, 500);
  }
});
