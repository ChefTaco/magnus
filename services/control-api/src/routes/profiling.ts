import { Hono } from 'hono'
import type { AppVariables } from '../types/index.js'
import { authMiddleware, requireRole } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { HttpError } from '../middleware/error-handler.js'
import { getNodeManagerSecret } from '../utils/env.js'

export const profilingRouter = new Hono<AppVariables>()
profilingRouter.use('*', authMiddleware)

/**
 * GET /profiling/:nodeId
 * Collect full V8/CPU/memory profile from a specific node's agent.
 */
profilingRouter.get('/:nodeId', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb()
  const node = await db.node.findUnique({ where: { id: c.req.param('nodeId') } })
  if (!node) throw new HttpError(404, 'NOT_FOUND', 'Node not found')

  const type = c.req.query('type') // heap, cpu, process, or undefined for full
  const path = type ? `/api/v1/profiling/${type}` : '/api/v1/profiling'

  const agentUrl = `https://${node.ipAddress}:${node.port}${path}`

  try {
    const res = await fetch(agentUrl, {
      headers: { 'x-node-token': getNodeManagerSecret() },
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      throw new HttpError(502, 'INTERNAL_ERROR', `Agent returned ${res.status}`)
    }

    const data = await res.json() as Record<string, unknown>
    return c.json({
      success: true,
      data: {
        nodeId: node.id,
        nodeName: node.name,
        ...(data as { data?: unknown }).data as Record<string, unknown>,
      },
    })
  } catch (err) {
    if (err instanceof HttpError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new HttpError(502, 'INTERNAL_ERROR', `Failed to collect profiling data: ${msg}`)
  }
})

/**
 * GET /profiling
 * Collect profiling data from all online nodes.
 */
profilingRouter.get('/', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb()
  const nodes = await db.node.findMany({
    where: { status: { notIn: ['DECOMMISSIONED', 'OFFLINE'] } },
    select: { id: true, name: true, ipAddress: true, port: true },
  })

  const results = await Promise.allSettled(
    nodes.map(async (node) => {
      const res = await fetch(`https://${node.ipAddress}:${node.port}/api/v1/profiling`, {
        headers: { 'x-node-token': getNodeManagerSecret() },
        signal: AbortSignal.timeout(10_000),
      })

      if (!res.ok) return { nodeId: node.id, nodeName: node.name, error: `Agent returned ${res.status}` }

      const data = await res.json() as { data?: Record<string, unknown> }
      return { nodeId: node.id, nodeName: node.name, ...data.data }
    }),
  )

  const profiles = results.map((r) =>
    r.status === 'fulfilled' ? r.value : { error: 'Failed to collect' },
  )

  return c.json({ success: true, data: profiles })
})
