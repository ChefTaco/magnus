import { z } from 'zod';

const id = z.string().min(1).max(200);
const timestamp = z.string().datetime();
export const magnusObservationSchema = z.object({
  schemaVersion: z.literal(1),
  collectedAt: timestamp,
  complete: z.boolean(),
  nodes: z
    .array(
      z.object({
        id,
        hostname: id,
        status: z.string(),
        lastHeartbeatAt: timestamp.nullable(),
        agentVersion: z.string().nullable(),
      }),
    )
    .max(10000),
  deployments: z
    .array(
      z.object({
        id,
        nodeId: id,
        projectId: id,
        serviceId: id,
        status: z.enum(['pass', 'fail', 'unknown', 'unconfigured']),
        observedAt: timestamp.nullable(),
        releaseRevision: z.string().nullable(),
        dependsOn: z.array(id).max(100).default([]),
      }),
    )
    .max(10000),
});
export type MagnusObservation = z.infer<typeof magnusObservationSchema>;
