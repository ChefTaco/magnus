import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

export const terminalTicketRouter = new Hono<AppVariables>();
terminalTicketRouter.use('*', authMiddleware);
terminalTicketRouter.use('*', requireRole('ADMIN', 'OPERATOR'));

/** The password-backed Control API terminal is retired; use the dashboard's
 * dedicated restricted key and inventory-pinned terminal transport. */
terminalTicketRouter.post('/ticket', (c) => c.json({
  success: false,
  error: {
    code: 'TERMINAL_RETIRED',
    message: 'Control API terminal tickets are retired; use the dashboard terminal.',
  },
}, 410));
