import { createHash } from 'node:crypto';

export interface EngineeringMetricEvidenceInput {
  applicationId: string;
  nodeId: string;
  metric: string;
  sourceKey: string;
  unit: string;
  value: number;
  observedAt: Date | string;
  probeContractSha256: string;
  method: string;
  path: string;
  httpStatus: number;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function engineeringMetricEvidenceSha256(input: EngineeringMetricEvidenceInput): string {
  return createHash('sha256').update(canonical({
    version: 1,
    applicationId: input.applicationId,
    nodeId: input.nodeId,
    metric: input.metric,
    sourceKey: input.sourceKey,
    unit: input.unit,
    value: input.value,
    observedAt: typeof input.observedAt === 'string' ? input.observedAt : input.observedAt.toISOString(),
    probeContractSha256: input.probeContractSha256,
    method: input.method,
    path: input.path,
    httpStatus: input.httpStatus,
  })).digest('hex');
}
