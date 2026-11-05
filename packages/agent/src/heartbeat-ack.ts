import { z } from 'zod';
const acknowledgement = z.object({
  data: z.object({
    accepted: z.literal(true),
    expectedVersion: z.string().optional(),
    updateAvailable: z.boolean().optional(),
  }),
});
/** An HTTP response alone is not proof that the control plane accepted a heartbeat. */
export function parseHeartbeatAcknowledgement(value: unknown) {
  return acknowledgement.parse(value);
}
