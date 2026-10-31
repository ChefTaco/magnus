import { describe, expect, it } from 'vitest';
import { buildHistogram } from './metrics.js';

function samples(text: string): Map<string, number> {
  return new Map(text.split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const separator = line.lastIndexOf(' ');
      return [line.slice(0, separator), Number(line.slice(separator + 1))];
    }));
}

describe('Prometheus request histogram', () => {
  it('emits exact cumulative buckets, boundaries, infinity, sum, and count', () => {
    const parsed = samples(buildHistogram([0, 5, 6, 10, 11, 100], [5, 10, 50]));
    expect(parsed).toEqual(new Map([
      ['magnus_http_request_duration_ms_bucket{le="5"}', 2],
      ['magnus_http_request_duration_ms_bucket{le="10"}', 4],
      ['magnus_http_request_duration_ms_bucket{le="50"}', 5],
      ['magnus_http_request_duration_ms_bucket{le="+Inf"}', 6],
      ['magnus_http_request_duration_ms_sum', 132],
      ['magnus_http_request_duration_ms_count', 6],
    ]));
  });

  it('emits a valid empty histogram', () => {
    const parsed = samples(buildHistogram([], [5]));
    expect(parsed.get('magnus_http_request_duration_ms_bucket{le="5"}')).toBe(0);
    expect(parsed.get('magnus_http_request_duration_ms_bucket{le="+Inf"}')).toBe(0);
    expect(parsed.get('magnus_http_request_duration_ms_sum')).toBe(0);
    expect(parsed.get('magnus_http_request_duration_ms_count')).toBe(0);
  });
});

describe('Prometheus route latency series', () => {
  it('requires the exact bearer token and bounds route label cardinality', async () => {
    const { metricsRouter, observeLatency } = await import('./metrics.js');
    const previous = process.env['METRICS_TOKEN'];
    process.env['METRICS_TOKEN'] = 'm'.repeat(40);
    try {
      for (let index = 0; index < 700; index++) observeLatency(1, `/random-${index}`, 404);
      observeLatency(1, '/api/v1/nodes/:nodeId', 200);
      expect((await metricsRouter.request('/', { headers: { authorization: `Bearer ${'x'.repeat(40)}` } })).status).toBe(401);
      const response = await metricsRouter.request('/', { headers: { authorization: `Bearer ${'m'.repeat(40)}` } });
      expect(response.status).toBe(200);
      const series = (await response.text()).split('\n').filter(line => line.startsWith('magnus_http_route_duration_ms_count{'));
      expect(series.length).toBeLessThanOrEqual(502);
      expect(series.some(line => line.includes('route="other",outcome="4xx"'))).toBe(true);
      expect(series.some(line => line.includes('route="other",outcome="2xx"'))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['METRICS_TOKEN'];
      else process.env['METRICS_TOKEN'] = previous;
    }
  });
});
