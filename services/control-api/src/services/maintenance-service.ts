import { z } from 'zod';
import { getDb } from '../db/index.js';

export const maintenanceSchema = z
  .object({
    reason: z.string().trim().min(5).max(500),
    nodeIds: z.array(z.string().min(1).max(200)).min(1).max(100),
    serviceIds: z.array(z.string().min(1).max(160)).max(100).default([]),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
  })
  .strict()
  .refine(
    (v) =>
      Date.parse(v.endsAt) > Date.parse(v.startsAt) &&
      Date.parse(v.endsAt) - Date.parse(v.startsAt) <= 7 * 86400000,
    'Maintenance must have a positive duration no longer than seven days',
  );

export async function matchingMaintenance(nodeId?: string | null, serviceId?: string | null) {
  if (!nodeId) return null;
  const now = new Date();
  const windows = await getDb().maintenanceWindow.findMany({
    where: { cancelledAt: null, startsAt: { lte: now }, endsAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
  });
  return (
    windows.find((w) => {
      const nodes: string[] = JSON.parse(w.nodeIds);
      const services: string[] = JSON.parse(w.serviceIds);
      return (
        nodes.includes(nodeId) &&
        (!services.length || Boolean(serviceId && services.includes(serviceId)))
      );
    }) ?? null
  );
}
