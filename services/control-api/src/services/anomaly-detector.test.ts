/**
 * anomaly-detector.test.ts — Unit tests for the anomaly detection z-score logic.
 */

import { describe, it, expect } from 'vitest';
import {
  buildMetricBaselines,
  classifyResourceSeverity,
  detectAnomaly,
  hasSustainedCpuPressure,
} from './anomaly-detector.js';

describe('buildMetricBaselines', () => {
  it('extracts every metric from one snapshot pass', () => {
    expect(buildMetricBaselines([
      {
        cpuUsagePercent: 25,
        memoryPercent: 50,
        swapTotalBytes: 100n,
        swapUsedBytes: 20n,
        disks: JSON.stringify([{ usagePercent: 40 }, { usagePercent: 80 }]),
      },
      {
        cpuUsagePercent: 30,
        memoryPercent: 60,
        swapTotalBytes: 0n,
        swapUsedBytes: 0n,
        disks: 'invalid',
      },
    ])).toEqual({
      cpu: [25, 30],
      memory: [50, 60],
      swap: [20, 0],
      disk: [80, 0],
    });
  });
});

describe('detectAnomaly', () => {
  it('should return no anomaly when history is too short', () => {
    const result = detectAnomaly(50, [10, 20, 30]);
    expect(result.isAnomaly).toBe(false);
    expect(result.zScore).toBe(0);
  });

  it('should return no anomaly for a normal value', () => {
    // Mean ≈ 50, stdDev ≈ 3.16
    const history = [47, 49, 50, 51, 53, 48, 52, 50, 49, 51];
    const result = detectAnomaly(50, history);
    expect(result.isAnomaly).toBe(false);
    expect(Math.abs(result.zScore)).toBeLessThan(3);
  });

  it('should detect an anomaly for a high z-score', () => {
    // Mean ≈ 20, stdDev ≈ 1.58
    const history = [18, 19, 20, 21, 22, 19, 20, 21, 20, 19];
    const result = detectAnomaly(95, history);
    expect(result.isAnomaly).toBe(true);
    expect(result.zScore).toBeGreaterThan(3);
    expect(result.severity).toBe('info');
  });

  it('should not detect low resource utilization as an anomaly', () => {
    // Mean ≈ 80
    const history = [78, 79, 80, 81, 82, 79, 80, 81, 80, 79];
    const result = detectAnomaly(5, history);
    expect(result.isAnomaly).toBe(false);
    expect(result.zScore).toBeLessThan(-3);
  });

  it('should handle constant history (zero stddev)', () => {
    const history = [50, 50, 50, 50, 50, 50, 50, 50, 50, 50];
    // Same value: no anomaly
    const same = detectAnomaly(50, history);
    expect(same.isAnomaly).toBe(false);
    expect(same.zScore).toBe(0);

    // Different value: anomaly
    const different = detectAnomaly(51, history);
    expect(different.isAnomaly).toBe(true);
    expect(different.zScore).toBe(999);
  });

  it('should include mean and stdDev in result', () => {
    const history = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const result = detectAnomaly(55, history);
    expect(result.mean).toBe(55);
    expect(result.stdDev).toBeGreaterThan(0);
    expect(result.current).toBe(55);
  });

  it('should handle exactly MIN_SAMPLES data points', () => {
    const history = [50, 50, 50, 50, 50, 50, 50, 50, 50, 50]; // 10 points
    const result = detectAnomaly(50, history);
    expect(result.isAnomaly).toBe(false);
  });
});

describe('resource pressure severity', () => {
  const cpuSamples = (percent: number, minutes: number): Array<{ timestamp: Date; value: number }> =>
    Array.from({ length: minutes * 2 + 1 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2026, 6, 14, 12) + index * 30 * 1000),
      value: percent,
    }));

  it('keeps a CPU spike informational', () => {
    const samples = cpuSamples(20, 15);
    samples[samples.length - 1]!.value = 99;
    expect(classifyResourceSeverity('cpu', 99, { cpuSamples: samples })).toBe('info');
  });

  it('requires sustained CPU pressure for warning and critical severity', () => {
    expect(classifyResourceSeverity('cpu', 85, { cpuSamples: cpuSamples(85, 15) })).toBe('warning');
    expect(classifyResourceSeverity('cpu', 97, { cpuSamples: cpuSamples(97, 15) })).toBe('critical');
  });

  it('rejects sparse CPU samples as sustained pressure', () => {
    const samples = [
      { timestamp: new Date('2026-07-14T12:00:00Z'), value: 99 },
      { timestamp: new Date('2026-07-14T12:15:00Z'), value: 99 },
    ];
    expect(hasSustainedCpuPressure(samples, 80)).toBe(false);
  });

  it('requires disk usage to reach 80 percent', () => {
    expect(classifyResourceSeverity('disk', 79.9)).toBe('info');
    expect(classifyResourceSeverity('disk', 80)).toBe('warning');
    expect(classifyResourceSeverity('disk', 95)).toBe('critical');
  });

  it('requires high memory and swap usage together', () => {
    expect(classifyResourceSeverity('memory', 96, { memoryPercent: 96, swapUsedBytes: 0 })).toBe('info');
    expect(classifyResourceSeverity('memory', 85, { memoryPercent: 85, swapUsedBytes: 1 })).toBe('warning');
    expect(classifyResourceSeverity('memory', 95, { memoryPercent: 95, swapUsedBytes: 1 })).toBe('critical');
    expect(classifyResourceSeverity('swap', 50, { memoryPercent: 40, swapUsedBytes: 1024 })).toBe('info');
  });
});
