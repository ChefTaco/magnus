import { Hono } from 'hono';

export const updateRoutes = new Hono();

// In-band npm self-update is retired: it installed an unpinned registry
// version outside the verified release bundle. Agent code changes ship only
// through the pinned artifact release in docs/deployment/MAGNUS_RELEASE_RUNBOOK.md.
const retired = {
  success: false,
  error: {
    code: 'SELF_UPDATE_RETIRED',
    message: 'In-band agent self-update is retired; use the pinned routine artifact release.',
  },
} as const;

updateRoutes.all('/', (c) => c.json(retired, 410));
updateRoutes.all('/status', (c) => c.json(retired, 410));
