import { describe, expect, it } from 'vitest';
import { calculatePwmPercent, parseCsvRow, parseMillidegrees, parseNvidiaSmi } from './gpu-collector.js';

describe('GPU collector parsing', () => {
  it('parses quoted NVIDIA names and bounded percentage metrics', () => {
    const devices = parseNvidiaSmi([
      '0, GPU-123, "NVIDIA RTX, Example", 87, 100, 72',
      '1, GPU-456, NVIDIA A100, 12, [Not Supported], 41',
    ].join('\n'));

    expect(devices).toEqual([
      {
        index: 0,
        vendor: 'nvidia',
        name: 'NVIDIA RTX, Example',
        uuid: 'GPU-123',
        utilizationPercent: 87,
        fanPercent: 100,
        temperatureCelsius: 72,
      },
      {
        index: 1,
        vendor: 'nvidia',
        name: 'NVIDIA A100',
        uuid: 'GPU-456',
        utilizationPercent: 12,
        fanPercent: null,
        temperatureCelsius: 41,
      },
    ]);
  });

  it('handles escaped quotes in CSV fields', () => {
    expect(parseCsvRow('0, "GPU ""Ada""", 50')).toEqual(['0', 'GPU "Ada"', '50']);
  });

  it('keeps unavailable AMD hwmon sensors null and scales PWM readings', () => {
    expect(calculatePwmPercent(null, null)).toBeNull();
    expect(calculatePwmPercent('255', null)).toBe(100);
    expect(calculatePwmPercent('128', '255')).toBe(50.2);
    expect(parseMillidegrees(null)).toBeNull();
    expect(parseMillidegrees('73500')).toBe(73.5);
  });
});
