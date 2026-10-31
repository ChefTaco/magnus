import { Hono } from 'hono'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'

export const workspaceRoutes = new Hono()

const WORKSPACE_BASE = process.env['MAGNUS_AGENT_WORKSPACE_ROOT'] ?? '/var/lib/magnus-agent/workspaces'
const ALLOWED_SUBDIRS = ['config', 'skills', 'tools', 'heartbeat', 'data', 'logs']

/** Validate an agent name: reject traversal patterns and path separators. */
function isValidAgentName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && !name.includes('..')
}

/** Ensure a resolved path stays under the workspace base. */
function assertSafePath(path: string): void {
  const resolved = resolve(path)
  if (!resolved.startsWith(resolve(WORKSPACE_BASE))) {
    throw new Error('Path traversal detected')
  }
}

const createBodySchema = z.object({
  name: z.string().min(1).refine(isValidAgentName, {
    message: 'Agent name must be alphanumeric (hyphens/dots/underscores allowed), no path separators or traversal',
  }),
  subdirs: z.array(z.string()).optional(),
})

// ── Create workspace ─────────────────────────────────────────────────────────

workspaceRoutes.post('/', async (c) => {
  const body = await c.req.json()
  const parsed = createBodySchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'VALIDATION_ERROR', message: parsed.error.message }, 400)
  }

  const { name, subdirs } = parsed.data
  const workspacePath = join(WORKSPACE_BASE, name)
  assertSafePath(workspacePath)

  const dirs = subdirs?.filter((s) => ALLOWED_SUBDIRS.includes(s)) ?? ALLOWED_SUBDIRS

  // Create base directory and subdirectories
  await mkdir(workspacePath, { recursive: true })
  for (const dir of dirs) {
    await mkdir(join(workspacePath, dir), { recursive: true })
  }

  return c.json({
    data: {
      name,
      path: workspacePath,
      subdirs: dirs,
      created: true,
    },
  })
})

// ── List all workspaces ──────────────────────────────────────────────────────

workspaceRoutes.get('/', async (c) => {
  try {
    const entries = await readdir(WORKSPACE_BASE, { withFileTypes: true })
    const workspaces = entries
      .filter((e) => e.isDirectory() && isValidAgentName(e.name))
      .map((e) => ({
        name: e.name,
        path: join(WORKSPACE_BASE, e.name),
      }))
    return c.json({ data: workspaces })
  } catch {
    // Base directory doesn't exist yet
    return c.json({ data: [] })
  }
})

// ── Get workspace details ────────────────────────────────────────────────────

workspaceRoutes.get('/:name', async (c) => {
  const name = c.req.param('name')
  if (!isValidAgentName(name)) {
    return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid agent name' }, 400)
  }

  const workspacePath = join(WORKSPACE_BASE, name)
  assertSafePath(workspacePath)

  try {
    const info = await stat(workspacePath)
    if (!info.isDirectory()) {
      return c.json({ error: 'NOT_FOUND', message: 'Workspace not found' }, 404)
    }

    const entries = await readdir(workspacePath, { withFileTypes: true })
    const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)

    return c.json({
      data: {
        name,
        path: workspacePath,
        subdirs,
        exists: true,
      },
    })
  } catch {
    return c.json({ error: 'NOT_FOUND', message: 'Workspace not found' }, 404)
  }
})

// ── List skills in workspace ─────────────────────────────────────────────────

workspaceRoutes.get('/:name/skills', async (c) => {
  const name = c.req.param('name')
  if (!isValidAgentName(name)) {
    return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid agent name' }, 400)
  }

  const skillsPath = join(WORKSPACE_BASE, name, 'skills')
  assertSafePath(skillsPath)

  try {
    const entries = await readdir(skillsPath, { withFileTypes: true })
    const skills = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    return c.json({ data: skills })
  } catch {
    return c.json({ data: [] })
  }
})
