import { Hono } from 'hono'
import {
  collectHeapProfile,
  collectCpuProfile,
  collectProcessProfile,
  collectFullProfile,
} from './profiling-collector.js'

export const profilingRoutes = new Hono()

// Full profile
profilingRoutes.get('/', (c) => {
  const profile = collectFullProfile()
  return c.json({ success: true, data: profile })
})

// Heap only
profilingRoutes.get('/heap', (c) => {
  const heap = collectHeapProfile()
  return c.json({ success: true, data: heap })
})

// CPU only
profilingRoutes.get('/cpu', (c) => {
  const cpu = collectCpuProfile()
  return c.json({ success: true, data: cpu })
})

// Process only
profilingRoutes.get('/process', (c) => {
  const proc = collectProcessProfile()
  return c.json({ success: true, data: proc })
})
