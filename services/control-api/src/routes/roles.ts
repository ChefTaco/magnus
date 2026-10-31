import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { getDb } from '../db/index.js';
import type { Role, RoleApplication } from '../db/generated/prisma/client.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { logAuditEvent } from '../services/audit-service.js';
import { HttpError } from '../middleware/error-handler.js';
import { applyRole, removeRole } from '../services/role-service.js';
import { parseBody } from '../utils/validate.js';
import {
  createRoleSchema,
  updateRoleSchema,
  assignRoleSchema,
  unassignRoleSchema,
  applyRoleSchema,
} from '../schemas/roles.js';
import { enforceIdempotencyFromHeader } from '../utils/idempotency.js';
import { serializeStringArray, serializeRecord, parseStringArray, parseStringRecord, parseJsonArray } from '../utils/json-fields.js';

export const rolesRouter = new Hono<AppVariables>();
rolesRouter.use('*', authMiddleware);

// ─── Helpers ───

/** Formatted role with JSON string fields parsed to their proper types. */
interface FormattedRole {
  id: string;
  name: string;
  description: string;
  libraryFileIds: string[];
  skillNames: string[];
  aptPackages: string[];
  npmPackages: string[];
  envConfig: Record<string, string>;
  dockerEnabled: boolean;
  dockerNonRoot: boolean;
  dockerImage: string | null;
  dockerVolumes: string[];
  firewallEnabled: boolean;
  firewallMode: string;
  firewallAllowRules: string[];
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Formatted role application with steps parsed from JSON string. */
interface FormattedApplication {
  id: string;
  nodeId: string;
  roleId: string;
  action: string;
  status: string;
  steps: unknown[];
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

/** Transform a DB role record into a clean API response. */
function formatRole<T extends Role>(role: T): Omit<T, keyof Role> & FormattedRole {
  return {
    ...role,
    libraryFileIds: parseStringArray(role.libraryFileIds),
    skillNames: parseStringArray(role.skillNames),
    aptPackages: parseStringArray(role.aptPackages),
    npmPackages: parseStringArray(role.npmPackages),
    envConfig: parseStringRecord(role.envConfig),
    dockerVolumes: parseStringArray(role.dockerVolumes),
    firewallAllowRules: parseStringArray(role.firewallAllowRules),
  };
}

/** Transform a DB role application record. */
function formatApplication<T extends RoleApplication>(app: T): Omit<T, keyof RoleApplication> & FormattedApplication {
  return {
    ...app,
    steps: parseJsonArray(app.steps),
  };
}

// ─── List roles ───
rolesRouter.get('/', async (c) => {
  const db = getDb();
  const roles = await db.role.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: { select: { nodes: true } },
    },
  });

  const data = roles.map((r) => formatRole(r));
  return c.json({ success: true, data });
});

// ─── Get single role ───
rolesRouter.get('/:roleId', async (c) => {
  const db = getDb();
  const roleId = c.req.param('roleId')!;

  const role = await db.role.findUnique({
    where: { id: roleId },
    include: {
      nodes: { select: { id: true, name: true, hostname: true, status: true } },
      _count: { select: { nodes: true } },
    },
  });
  if (!role) throw new HttpError(404, 'NOT_FOUND', 'Role not found');

  return c.json({ success: true, data: formatRole(role) });
});

// ─── Create role ───
rolesRouter.post('/', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const body = await parseBody(c, createRoleSchema);

  if (!body.name?.trim()) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Role name is required');
  }

  // Check name uniqueness
  const existing = await db.role.findUnique({ where: { name: body.name } });
  if (existing) {
    throw new HttpError(409, 'CONFLICT', `Role "${body.name}" already exists`);
  }

  // Validate library file IDs exist
  if (body.libraryFileIds?.length) {
    const count = await db.libraryFile.count({
      where: { id: { in: body.libraryFileIds } },
    });
    if (count !== body.libraryFileIds.length) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'One or more library file IDs are invalid');
    }
  }

  const role = await db.role.create({
    data: {
      name: body.name.trim(),
      description: body.description ?? '',
      libraryFileIds: serializeStringArray(body.libraryFileIds),
      skillNames: serializeStringArray(body.skillNames),
      aptPackages: serializeStringArray(body.aptPackages),
      npmPackages: serializeStringArray(body.npmPackages),
      envConfig: serializeRecord(body.envConfig as Record<string, unknown> | undefined),
      dockerEnabled: body.dockerEnabled ?? false,
      dockerNonRoot: body.dockerNonRoot ?? false,
      dockerImage: body.dockerImage ?? null,
      dockerVolumes: serializeStringArray(body.dockerVolumes),
      firewallEnabled: body.firewallEnabled ?? false,
      firewallMode: body.firewallMode ?? 'restrictive',
      firewallAllowRules: serializeStringArray(body.firewallAllowRules),
      status: body.status ?? 'active',
    },
  });

  await logAuditEvent({
    action: 'role.create',
    actorId: user.userId,
    targetType: 'role',
    targetId: role.id,
    details: { name: role.name, status: role.status },
  });

  return c.json({ success: true, data: formatRole(role) }, 201);
});

// ─── Update role ───
rolesRouter.patch('/:roleId', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const roleId = c.req.param('roleId')!;
  const body = await parseBody(c, updateRoleSchema);

  const existing = await db.role.findUnique({ where: { id: roleId } });
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Role not found');

  // Check name uniqueness if changing
  if (body.name && body.name !== existing.name) {
    const dupe = await db.role.findUnique({ where: { name: body.name } });
    if (dupe) throw new HttpError(409, 'CONFLICT', `Role "${body.name}" already exists`);
  }

  const role = await db.role.update({
    where: { id: roleId },
    data: {
      ...(body.name !== undefined && { name: body.name.trim() }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.libraryFileIds !== undefined && { libraryFileIds: serializeStringArray(body.libraryFileIds) }),
      ...(body.skillNames !== undefined && { skillNames: serializeStringArray(body.skillNames) }),
      ...(body.aptPackages !== undefined && { aptPackages: serializeStringArray(body.aptPackages) }),
      ...(body.npmPackages !== undefined && { npmPackages: serializeStringArray(body.npmPackages) }),
      ...(body.envConfig !== undefined && { envConfig: serializeRecord(body.envConfig as Record<string, unknown>) }),
      ...(body.dockerEnabled !== undefined && { dockerEnabled: body.dockerEnabled }),
      ...(body.dockerNonRoot !== undefined && { dockerNonRoot: body.dockerNonRoot }),
      ...(body.dockerImage !== undefined && { dockerImage: body.dockerImage }),
      ...(body.dockerVolumes !== undefined && { dockerVolumes: serializeStringArray(body.dockerVolumes) }),
      ...(body.firewallEnabled !== undefined && { firewallEnabled: body.firewallEnabled }),
      ...(body.firewallMode !== undefined && { firewallMode: body.firewallMode }),
      ...(body.firewallAllowRules !== undefined && { firewallAllowRules: serializeStringArray(body.firewallAllowRules) }),
      ...(body.status !== undefined && { status: body.status }),
    },
  });

  await logAuditEvent({
    action: 'role.update',
    actorId: user.userId,
    targetType: 'role',
    targetId: roleId,
    details: { name: body.name, status: body.status },
  });

  return c.json({ success: true, data: formatRole(role) });
});

// ─── Delete role ───
rolesRouter.delete('/:roleId', requireRole('ADMIN'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const roleId = c.req.param('roleId')!;

  const role = await db.role.findUnique({
    where: { id: roleId },
    include: { _count: { select: { nodes: true } } },
  });
  if (!role) throw new HttpError(404, 'NOT_FOUND', 'Role not found');

  // Unassign all nodes first
  if (role._count.nodes > 0) {
    await db.node.updateMany({
      where: { roleId },
      data: { roleId: null },
    });
  }

  await db.role.delete({ where: { id: roleId } });

  await logAuditEvent({
    action: 'role.delete',
    actorId: user.userId,
    targetType: 'role',
    targetId: roleId,
    details: { name: role.name },
  });

  return c.json({ success: true, data: { deleted: true } });
});

// ─── Assign role to node(s) ───
rolesRouter.post('/:roleId/assign', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const roleId = c.req.param('roleId')!;
  const body = await parseBody(c, assignRoleSchema);
  const { nodeIds, defer } = body;

  if (!nodeIds?.length) throw new HttpError(400, 'VALIDATION_ERROR', 'nodeIds required');

  const role = await db.role.findUnique({ where: { id: roleId } });
  if (!role) throw new HttpError(404, 'NOT_FOUND', 'Role not found');

  // Assign roleId on each node
  await db.node.updateMany({
    where: { id: { in: nodeIds } },
    data: { roleId },
  });

  await logAuditEvent({
    action: 'role.assign',
    actorId: user.userId,
    targetType: 'role',
    targetId: roleId,
    details: { nodeIds, roleName: role.name },
  });

  // If not deferred, trigger apply for each node
  const applications = [];
  if (!defer && role.status === 'active') {
    for (const nodeId of nodeIds) {
      const application = await db.roleApplication.create({
        data: {
          nodeId,
          roleId,
          action: 'apply',
          status: 'pending',
          steps: '[]',
        },
      });
      applications.push(application);

      // Fire and forget — apply runs in background
      void applyRole(application.id).catch((err: unknown) => {
        console.error(`Role apply failed for ${application.id}:`, err instanceof Error ? err.message : String(err));
      });
    }
  }

  return c.json({
    success: true,
    data: {
      assigned: nodeIds.length,
      deferred: !!defer,
      applications: applications.map((a) => formatApplication(a)),
    },
  });
});

// ─── Unassign role from node(s) ───
rolesRouter.post('/:roleId/unassign', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const roleId = c.req.param('roleId')!;
  const body = await parseBody(c, unassignRoleSchema);
  const { nodeIds } = body;

  if (!nodeIds?.length) throw new HttpError(400, 'VALIDATION_ERROR', 'nodeIds required');

  const role = await db.role.findUnique({ where: { id: roleId } });
  if (!role) throw new HttpError(404, 'NOT_FOUND', 'Role not found');

  // Trigger removal for each node
  const applications = [];
  for (const nodeId of nodeIds) {
    const application = await db.roleApplication.create({
      data: {
        nodeId,
        roleId,
        action: 'remove',
        status: 'pending',
        steps: '[]',
      },
    });
    applications.push(application);

    // Fire and forget
    void removeRole(application.id).catch((err: unknown) => {
      console.error(`Role remove failed for ${application.id}:`, err instanceof Error ? err.message : String(err));
    });
  }

  await logAuditEvent({
    action: 'role.unassign',
    actorId: user.userId,
    targetType: 'role',
    targetId: roleId,
    details: { nodeIds, roleName: role.name },
  });

  return c.json({
    success: true,
    data: {
      unassigned: nodeIds.length,
      applications: applications.map((a) => formatApplication(a)),
    },
  });
});

// ─── Manually trigger apply (for deferred/draft roles) ───
rolesRouter.post('/:roleId/apply', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const roleId = c.req.param('roleId')!;
  const body = await parseBody(c, applyRoleSchema);
  const { nodeIds } = body;

  const role = await db.role.findUnique({
    where: { id: roleId },
    include: { nodes: { select: { id: true } } },
  });
  if (!role) throw new HttpError(404, 'NOT_FOUND', 'Role not found');

  const targetNodeIds = nodeIds ?? role.nodes.map((n) => n.id);
  if (targetNodeIds.length === 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'No nodes assigned to this role');
  }

  // Claim after validation/preview/preflight so a rejected retry is not a duplicate.
  await enforceIdempotencyFromHeader(c);
  const applications = [];
  for (const nodeId of targetNodeIds) {
    const application = await db.roleApplication.create({
      data: {
        nodeId,
        roleId,
        action: 'apply',
        status: 'pending',
        steps: '[]',
      },
    });
    applications.push(application);

    void applyRole(application.id).catch((err: unknown) => {
      console.error(`Role apply failed for ${application.id}:`, err instanceof Error ? err.message : String(err));
    });
  }

  await logAuditEvent({
    action: 'role.apply',
    actorId: user.userId,
    targetType: 'role',
    targetId: roleId,
    details: { nodeIds: targetNodeIds, roleName: role.name },
  });

  return c.json({
    success: true,
    data: {
      applied: targetNodeIds.length,
      applications: applications.map((a) => formatApplication(a)),
    },
  });
});

// ─── List role applications ───
rolesRouter.get('/applications/list', async (c) => {
  const db = getDb();
  const roleId = c.req.query('roleId');
  const nodeId = c.req.query('nodeId');
  const status = c.req.query('status');

  const where: Record<string, unknown> = {};
  if (roleId) where['roleId'] = roleId;
  if (nodeId) where['nodeId'] = nodeId;
  if (status) where['status'] = status;

  const applications = await db.roleApplication.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      role: { select: { name: true } },
      node: { select: { name: true } },
    },
  });

  const data = applications.map((a) => formatApplication(a));
  return c.json({ success: true, data });
});

// ─── Get single application status ───
rolesRouter.get('/applications/:appId', async (c) => {
  const db = getDb();
  const appId = c.req.param('appId')!;

  const application = await db.roleApplication.findUnique({
    where: { id: appId },
    include: {
      role: { select: { name: true } },
      node: { select: { name: true } },
    },
  });
  if (!application) throw new HttpError(404, 'NOT_FOUND', 'Application not found');

  return c.json({ success: true, data: formatApplication(application) });
});
