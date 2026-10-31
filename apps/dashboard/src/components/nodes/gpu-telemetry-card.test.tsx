import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GpuTelemetryCard } from './gpu-telemetry-card';

describe('GpuTelemetryCard', () => {
  it('shows GPU load, fan saturation, and history semantics', () => {
    const html = renderToStaticMarkup(<GpuTelemetryCard telemetry={{
      period: '24h',
      latest: {
        sampledAt: '2026-09-04T08:00:00.000Z',
        sampleIntervalSeconds: 30,
        status: 'ok',
        maxUtilizationPercent: 82,
        maxFanPercent: 100,
        devices: [{
          index: 0,
          vendor: 'nvidia',
          name: 'RTX Test',
          uuid: 'GPU-test',
          utilizationPercent: 82,
          fanPercent: 100,
          temperatureCelsius: 73,
        }],
      },
      history: [
        { sampledAt: '2026-09-04T07:59:30.000Z', sampleIntervalSeconds: 30, status: 'ok', devices: [], maxUtilizationPercent: 70, maxFanPercent: 95 },
        { sampledAt: '2026-09-04T08:00:00.000Z', sampleIntervalSeconds: 30, status: 'ok', devices: [], maxUtilizationPercent: 82, maxFanPercent: 100 },
      ],
    }} />);

    expect(html).toContain('RTX Test');
    expect(html).toContain('fan saturated');
    expect(html).toContain('82.0%');
    expect(html).toContain('100.0%');
    expect(html).toContain('GPU load and fan percentage over the last 24 hours');
  });
});
