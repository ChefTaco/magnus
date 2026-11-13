import { z } from 'zod';
const acknowledgement = z.object({
  data: z.object({
    accepted: z.literal(true),
    expectedVersion: z.string().optional(),
    updateAvailable: z.boolean().optional(),
    // Sent by a server with per-node credentials. Read leniently: it must never fail a heartbeat.
    nodeAuth: z.object({ supported: z.boolean().optional(), mode: z.string().optional(), method: z.string().optional(),
      problem: z.string().optional(), evidence: z.number().optional() }).optional().catch(undefined),
  }),
});
/** An HTTP response alone is not proof that the control plane accepted a heartbeat. */
export function parseHeartbeatAcknowledgement(value: unknown) {
  return acknowledgement.parse(value);
}
