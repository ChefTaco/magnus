import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';

const GPU_SAMPLE_INTERVAL_MS = 30 * 1000;
const GPU_COMMAND_TIMEOUT_MS = 3_000;
const GPU_COLLECTION_DEADLINE_MS = 4_000;

export interface GpuDeviceMetric {
  index: number;
  vendor: 'nvidia' | 'amd';
  name: string;
  uuid: string | null;
  utilizationPercent: number | null;
  fanPercent: number | null;
  temperatureCelsius: number | null;
}

export interface GpuTelemetry {
  sampledAt: string;
  sampleIntervalSeconds: number;
  status: 'ok' | 'unavailable' | 'error';
  devices: GpuDeviceMetric[];
}

let collectionInFlight: Promise<GpuTelemetry> | null = null;

function boundedPercent(value: string | undefined): number | null {
  if (!value || /^(n\/a|not supported|\[not supported\])$/i.test(value.trim())) return null;
  const parsed = Number.parseFloat(value.replace('%', '').trim());
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : null;
}

function finiteNumber(value: string | undefined): number | null {
  if (!value || /^(n\/a|not supported|\[not supported\])$/i.test(value.trim())) return null;
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function calculatePwmPercent(pwmRaw: string | null, pwmMaxRaw: string | null): number | null {
  if (pwmRaw === null) return null;
  const pwm = Number(pwmRaw);
  const pwmMax = Number(pwmMaxRaw ?? 255);
  if (!Number.isFinite(pwm) || !Number.isFinite(pwmMax) || pwmMax <= 0) return null;
  return Math.round(Math.max(0, Math.min(100, (pwm / pwmMax) * 100)) * 10) / 10;
}

export function parseMillidegrees(value: string | null): number | null {
  if (value === null) return null;
  const millidegrees = Number(value);
  return Number.isFinite(millidegrees) ? Math.round((millidegrees / 1000) * 10) / 10 : null;
}

/** Parse an RFC-4180-style CSV row as emitted by nvidia-smi. */
export function parseCsvRow(row: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const char = row[i]!;
    if (char === '"') {
      if (quoted && row[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      fields.push(field.trim());
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field.trim());
  return fields;
}

export function parseNvidiaSmi(output: string): GpuDeviceMetric[] {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((row): GpuDeviceMetric | null => {
      const [index, uuid, name, utilization, fan, temperature] = parseCsvRow(row);
      const parsedIndex = Number.parseInt(index ?? '', 10);
      if (!Number.isInteger(parsedIndex)) return null;
      return {
        index: parsedIndex,
        vendor: 'nvidia',
        name: name || `NVIDIA GPU ${parsedIndex}`,
        uuid: uuid || null,
        utilizationPercent: boundedPercent(utilization),
        fanPercent: boundedPercent(fan),
        temperatureCelsius: finiteNumber(temperature),
      };
    })
    .filter((device): device is GpuDeviceMetric => device !== null);
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      timeout: GPU_COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function collectNvidia(): Promise<{ devices: GpuDeviceMetric[]; failed: boolean }> {
  try {
    const output = await runCommand('nvidia-smi', [
      '--query-gpu=index,uuid,name,utilization.gpu,fan.speed,temperature.gpu',
      '--format=csv,noheader,nounits',
    ]);
    return { devices: parseNvidiaSmi(output), failed: false };
  } catch (error) {
    const missing = Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
    return { devices: [], failed: !missing };
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return (await fs.readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

/**
 * AMD exposes load and fan PWM through the kernel DRM/hwmon interfaces. This
 * avoids requiring a particular amd-smi/rocm-smi release on every fleet node.
 */
async function collectAmd(): Promise<GpuDeviceMetric[]> {
  let entries: string[];
  try {
    entries = await fs.readdir('/sys/class/drm');
  } catch {
    return [];
  }

  const cards = entries.filter((entry) => /^card\d+$/.test(entry));
  const devices = await Promise.all(cards.map(async (card): Promise<GpuDeviceMetric | null> => {
    const base = `/sys/class/drm/${card}/device`;
    if ((await readText(`${base}/vendor`))?.toLowerCase() !== '0x1002') return null;

    const index = Number.parseInt(card.slice(4), 10);
    const utilizationPercent = boundedPercent((await readText(`${base}/gpu_busy_percent`)) ?? undefined);
    let fanPercent: number | null = null;
    let temperatureCelsius: number | null = null;

    try {
      const hwmons = await fs.readdir(`${base}/hwmon`);
      for (const hwmon of hwmons) {
        const hwmonBase = `${base}/hwmon/${hwmon}`;
        const [pwmRaw, pwmMaxRaw, tempRaw] = await Promise.all([
          readText(`${hwmonBase}/pwm1`),
          readText(`${hwmonBase}/pwm1_max`),
          readText(`${hwmonBase}/temp1_input`),
        ]);
        fanPercent = calculatePwmPercent(pwmRaw, pwmMaxRaw);
        temperatureCelsius = parseMillidegrees(tempRaw);
        if (fanPercent !== null || temperatureCelsius !== null) break;
      }
    } catch {
      // Some cards do not expose a hwmon device or readable fan sensors.
    }

    return {
      index,
      vendor: 'amd',
      name: (await readText(`${base}/product_name`)) || `AMD GPU ${index}`,
      uuid: null,
      utilizationPercent,
      fanPercent,
      temperatureCelsius,
    };
  }));

  return devices.filter((device): device is GpuDeviceMetric => device !== null);
}

async function collectFresh(): Promise<GpuTelemetry> {
  const [nvidia, amd] = await Promise.all([collectNvidia(), collectAmd()]);
  const devices = [...nvidia.devices, ...amd];
  return {
    sampledAt: new Date().toISOString(),
    sampleIntervalSeconds: GPU_SAMPLE_INTERVAL_MS / 1000,
    status: devices.length > 0 ? 'ok' : nvidia.failed ? 'error' : 'unavailable',
    devices,
  };
}

/** Collect GPU utilization and fan percentage on the 30-second heartbeat cadence. */
export async function collectGpuTelemetry(): Promise<GpuTelemetry> {
  if (!collectionInFlight) {
    collectionInFlight = collectFresh()
      .finally(() => {
        collectionInFlight = null;
      });
  }

  const activeCollection = collectionInFlight;
  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      // A wedged driver probe must never stop the fleet heartbeat loop. Keep
      // the in-flight guard in place so an unkillable command cannot pile up.
      resolve({
        sampledAt: new Date().toISOString(),
        sampleIntervalSeconds: GPU_SAMPLE_INTERVAL_MS / 1000,
        status: 'error',
        devices: [],
      });
    }, GPU_COLLECTION_DEADLINE_MS);
    activeCollection.then((value) => {
      clearTimeout(deadline);
      resolve(value);
    }).catch(() => {
      clearTimeout(deadline);
      resolve({
        sampledAt: new Date().toISOString(),
        sampleIntervalSeconds: GPU_SAMPLE_INTERVAL_MS / 1000,
        status: 'error',
        devices: [],
      });
    });
  });
}
