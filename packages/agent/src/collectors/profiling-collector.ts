/**
 * Profiling Collector — V8 CPU & Memory Profiling
 *
 * Captures V8 heap snapshots and CPU profiles from the agent's
 * Node.js process. Useful for diagnosing memory leaks, high CPU usage,
 * and performance bottlenecks on fleet nodes.
 */

import { cpus, totalmem, freemem, loadavg } from 'node:os'
import v8 from 'node:v8'
import { performance } from 'node:perf_hooks'

// ── Types ────────────────────────────────────────────────────────────────────

export interface HeapProfile {
  timestamp: string
  heapUsed: number
  heapTotal: number
  external: number
  arrayBuffers: number
  rss: number
  heapSpaces: v8.HeapSpaceInfo[]
}

export interface CpuProfile {
  timestamp: string
  cpuCount: number
  model: string
  speed: number
  loadAvg: number[]
  usage: { user: number; system: number; idle: number }
}

export interface ProcessProfile {
  timestamp: string
  pid: number
  uptime: number
  memoryUsage: NodeJS.MemoryUsage
  cpuUsage: NodeJS.CpuUsage
  resourceUsage: ReturnType<typeof process.resourceUsage>
  v8HeapStats: v8.HeapInfo
  eventLoopUtilization?: { idle: number; active: number; utilization: number }
}

// ── Collectors ───────────────────────────────────────────────────────────────

export function collectHeapProfile(): HeapProfile {
  const mem = process.memoryUsage()
  return {
    timestamp: new Date().toISOString(),
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    rss: mem.rss,
    heapSpaces: v8.getHeapSpaceStatistics(),
  }
}

export function collectCpuProfile(): CpuProfile {
  const cpuInfo = cpus()
  const avgUser = cpuInfo.reduce((sum, c) => sum + c.times.user, 0) / cpuInfo.length
  const avgSys = cpuInfo.reduce((sum, c) => sum + c.times.sys, 0) / cpuInfo.length
  const avgIdle = cpuInfo.reduce((sum, c) => sum + c.times.idle, 0) / cpuInfo.length
  const total = avgUser + avgSys + avgIdle
  const loads = loadavg()

  return {
    timestamp: new Date().toISOString(),
    cpuCount: cpuInfo.length,
    model: cpuInfo[0]?.model ?? 'unknown',
    speed: cpuInfo[0]?.speed ?? 0,
    loadAvg: loads.map((l) => parseFloat(l.toFixed(2))),
    usage: {
      user: total > 0 ? avgUser / total : 0,
      system: total > 0 ? avgSys / total : 0,
      idle: total > 0 ? avgIdle / total : 0,
    },
  }
}

export function collectProcessProfile(): ProcessProfile {
  let elu: { idle: number; active: number; utilization: number } | undefined
  try {
    const eluFn = (performance as unknown as Record<string, unknown>).eventLoopUtilization
    if (typeof eluFn === 'function') {
      elu = eluFn() as { idle: number; active: number; utilization: number }
    }
  } catch {
    // Not available on all Node.js versions
  }

  return {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    cpuUsage: process.cpuUsage(),
    resourceUsage: process.resourceUsage(),
    v8HeapStats: v8.getHeapStatistics(),
    eventLoopUtilization: elu,
  }
}

export function collectFullProfile() {
  return {
    heap: collectHeapProfile(),
    cpu: collectCpuProfile(),
    process: collectProcessProfile(),
    system: {
      totalMemory: totalmem(),
      freeMemory: freemem(),
    },
  }
}
