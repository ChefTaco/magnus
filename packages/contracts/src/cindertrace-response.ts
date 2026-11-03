import { z } from "zod";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const responseRequestSchema = z
  .object({
    version: z.literal(1),
    executionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
    actionId: z.string().min(1).max(160),
    caseId: z.string().min(1).max(160),
    operation: z.enum(["execute", "release"]),
    nodeId: z.string().min(1).max(160),
    kind: z.enum(["service_restart", "host_isolation"]),
    serviceName: z
      .string()
      .regex(/^[a-zA-Z0-9@_.-]{1,200}$/)
      .nullable(),
    isolationMinutes: z.number().int().min(1).max(30).nullable(),
    previewSha256: digest,
    planSha256: digest,
    approvalId: z.string().min(1).max(160),
    approvedBy: z.string().min(1).max(200),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type ResponseRequest = z.infer<typeof responseRequestSchema>;
