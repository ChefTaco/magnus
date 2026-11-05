import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

export const terminalTicketRouter = new Hono<AppVariables>();
terminalTicketRouter.use('*', authMiddleware);
terminalTicketRouter.use('*', requireRole('ADMIN', 'OPERATOR'));

/** The password-backed Control API terminal is retired. The web terminal lives in the separate
 * fleet gateway, so this process never holds the restricted SSH key. */
terminalTicketRouter.post('/ticket', (c) => c.json({
  success: false,
  error: {
    code: 'TERMINAL_RETIRED',
    message: 'Control API terminal tickets are retired; the fleet gateway carries the web terminal.',
  },
}, 410));
