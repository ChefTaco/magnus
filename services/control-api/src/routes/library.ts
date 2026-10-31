import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { getDb } from '../db/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { logAuditEvent, sanitizeDetails } from '../services/audit-service.js';
import { HttpError } from '../middleware/error-handler.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { parseBody } from '../utils/validate.js';
import { NodeApiClient } from '../sdk/node-api-client.js';
import {
  createCategorySchema,
  updateCategorySchema,
  createLibraryFileSchema,
  updateLibraryFileSchema,
  moveFilesSchema,
  deployLibrarySchema,
} from '../schemas/library.js';
import { enforceIdempotencyFromHeader } from '../utils/idempotency.js';
import { parseStringArray, serializeStringArray } from '../utils/json-fields.js';
import { createCronSchema } from '../schemas/cron.js';
import { cronMutationMode, installManagedCron, upsertAndRegisterManagedCron } from '../services/managed-cron.js';

export const libraryRouter = new Hono<AppVariables>();
libraryRouter.use('*', authMiddleware);

// ════════════════════════════════════════════════
//  Categories
// ════════════════════════════════════════════════

// ── List all categories ──
libraryRouter.get('/categories', async (c) => {
  const db = getDb();
  const categories = await db.libraryCategory.findMany({
    orderBy: { sortOrder: 'asc' },
    include: { _count: { select: { files: true } } },
  });

  const data = categories.map((cat) => ({
    ...cat,
    fileCount: cat._count.files,
    _count: undefined,
  }));

  return c.json({ success: true, data });
});

// ── Create category ──
libraryRouter.post('/categories', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const body = await parseBody(c, createCategorySchema);

  const existing = await db.libraryCategory.findUnique({ where: { name: body.name.trim() } });
  if (existing) {
    throw new HttpError(409, 'CONFLICT', 'A category with this name already exists');
  }

  const category = await db.libraryCategory.create({
    data: {
      name: body.name.trim(),
      description: body.description ?? '',
      color: body.color ?? '#6366f1',
      sortOrder: body.sortOrder ?? 0,
    },
  });

  await logAuditEvent({
    action: 'library.category.create',
    actorId: user.userId,
    targetType: 'library_category',
    targetId: category.id,
    details: { name: category.name },
  });

  return c.json({ success: true, data: category }, 201);
});

// ── Update category ──
libraryRouter.patch('/categories/:categoryId', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const categoryId = c.req.param('categoryId')!;
  const body = await parseBody(c, updateCategorySchema);

  const existing = await db.libraryCategory.findUnique({ where: { id: categoryId } });
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Category not found');

  const category = await db.libraryCategory.update({
    where: { id: categoryId },
    data: {
      ...(body.name !== undefined && { name: body.name.trim() }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.color !== undefined && { color: body.color }),
      ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
    },
  });

  await logAuditEvent({
    action: 'library.category.update',
    actorId: user.userId,
    targetType: 'library_category',
    targetId: categoryId,
    details: { name: body.name, description: body.description },
  });

  return c.json({ success: true, data: category });
});

// ── Delete category ──
libraryRouter.delete('/categories/:categoryId', requireRole('ADMIN'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const categoryId = c.req.param('categoryId')!;

  const existing = await db.libraryCategory.findUnique({ where: { id: categoryId } });
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Category not found');

  // Unset categoryId on files, then delete the category
  await db.libraryFile.updateMany({
    where: { categoryId },
    data: { categoryId: null },
  });
  await db.libraryCategory.delete({ where: { id: categoryId } });

  await logAuditEvent({
    action: 'library.category.delete',
    actorId: user.userId,
    targetType: 'library_category',
    targetId: categoryId,
    details: { name: existing.name },
  });

  return c.json({ success: true, data: { deleted: true } });
});

// ════════════════════════════════════════════════
//  Files
// ════════════════════════════════════════════════

// ── List / search files ──
libraryRouter.get('/files', async (c) => {
  const db = getDb();
  const query = c.req.query('query');
  const categoryId = c.req.query('categoryId');
  const mimeType = c.req.query('mimeType');
  const page = parseInt(c.req.query('page') ?? '1', 10);
  const pageSize = parseInt(c.req.query('pageSize') ?? '50', 10);

  const where: Record<string, unknown> = {};
  if (query) {
    where.name = { contains: query };
  }
  if (categoryId) {
    where.categoryId = categoryId === 'uncategorized' ? null : categoryId;
  }
  if (mimeType) {
    where.mimeType = { startsWith: mimeType };
  }

  const [files, total] = await Promise.all([
    db.libraryFile.findMany({
      where,
      include: { category: { select: { id: true, name: true, color: true } } },
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.libraryFile.count({ where }),
  ]);

  // Parse tags from JSON string
  const data = files.map((f) => ({
    ...f,
    tags: parseStringArray(f.tags),
    // Strip content from list view to save bandwidth
    content: undefined,
  }));

  return c.json({
    success: true,
    data,
    meta: { total, page, pageSize, hasMore: page * pageSize < total },
  });
});

// ── Get single file (with content) ──
libraryRouter.get('/files/:fileId', async (c) => {
  const db = getDb();
  const fileId = c.req.param('fileId')!;

  const file = await db.libraryFile.findUnique({
    where: { id: fileId },
    include: { category: { select: { id: true, name: true, color: true } } },
  });
  if (!file) throw new HttpError(404, 'NOT_FOUND', 'Library file not found');

  return c.json({
    success: true,
    data: {
      ...file,
      tags: parseStringArray(file.tags),
    },
  });
});

// ── Create file (upload) ──
libraryRouter.post('/files', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const body = await parseBody(c, createLibraryFileSchema);

  const content = body.content ?? '';

  const file = await db.libraryFile.create({
    data: {
      name: body.name.trim(),
      fileName: body.fileName.trim(),
      mimeType: body.mimeType ?? 'text/markdown',
      content,
      sizeBytes: Buffer.byteLength(content, 'utf-8'),
      categoryId: body.categoryId ?? null,
      tags: serializeStringArray(body.tags),
      createdBy: user.userId,
    },
    include: { category: { select: { id: true, name: true, color: true } } },
  });

  await logAuditEvent({
    action: 'library.file.create',
    actorId: user.userId,
    targetType: 'library_file',
    targetId: file.id,
    details: { name: body.name, fileName: body.fileName, mimeType: body.mimeType },
  });

  return c.json({
    success: true,
    data: { ...file, tags: parseStringArray(file.tags) },
  }, 201);
});

// ── Update file ──
libraryRouter.patch('/files/:fileId', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const fileId = c.req.param('fileId')!;
  const body = await parseBody(c, updateLibraryFileSchema);

  const existing = await db.libraryFile.findUnique({ where: { id: fileId } });
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Library file not found');

  const updateData: Record<string, unknown> = {};
  if (body.name !== undefined) updateData.name = body.name.trim();
  if (body.fileName !== undefined) updateData.fileName = body.fileName.trim();
  if (body.mimeType !== undefined) updateData.mimeType = body.mimeType;
  if (body.content !== undefined) {
    updateData.content = body.content;
    updateData.sizeBytes = Buffer.byteLength(body.content, 'utf-8');
  }
  if (body.categoryId !== undefined) updateData.categoryId = body.categoryId;
  if (body.tags !== undefined) updateData.tags = serializeStringArray(body.tags);

  const file = await db.libraryFile.update({
    where: { id: fileId },
    data: updateData,
    include: { category: { select: { id: true, name: true, color: true } } },
  });

  await logAuditEvent({
    action: 'library.file.update',
    actorId: user.userId,
    targetType: 'library_file',
    targetId: fileId,
    details: { name: body.name, fileName: body.fileName },
  });

  return c.json({
    success: true,
    data: { ...file, tags: parseStringArray(file.tags) },
  });
});

// ── Delete file ──
libraryRouter.delete('/files/:fileId', requireRole('ADMIN'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const fileId = c.req.param('fileId')!;

  const existing = await db.libraryFile.findUnique({ where: { id: fileId } });
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Library file not found');

  await db.libraryFile.delete({ where: { id: fileId } });

  await logAuditEvent({
    action: 'library.file.delete',
    actorId: user.userId,
    targetType: 'library_file',
    targetId: fileId,
    details: { name: existing.name, fileName: existing.fileName },
  });

  return c.json({ success: true, data: { deleted: true } });
});

// ── Move files to a category (drag-and-drop support) ──
libraryRouter.post('/files/move', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const body = await parseBody(c, moveFilesSchema);

  const fileIds = body.fileIds;
  const categoryId = body.categoryId ?? null;

  if (categoryId) {
    const cat = await db.libraryCategory.findUnique({ where: { id: categoryId } });
    if (!cat) throw new HttpError(404, 'NOT_FOUND', 'Target category not found');
  }

  await db.libraryFile.updateMany({
    where: { id: { in: fileIds } },
    data: { categoryId },
  });

  await logAuditEvent({
    action: 'library.file.move',
    actorId: user.userId,
    targetType: 'library_category',
    targetId: categoryId ?? 'uncategorized',
    details: { fileIds, categoryId },
  });

  return c.json({ success: true, data: { moved: fileIds.length } });
});

// ════════════════════════════════════════════════
//  Deploy Library Item to Nodes
// ════════════════════════════════════════════════

libraryRouter.post(
  '/deploy',
  requireRole('ADMIN', 'OPERATOR'),
  async (c) => {
    const db = getDb();
    const user = getUser(c);
    const body = await parseBody(c, deployLibrarySchema);

    // Load library file with content
    const file = await db.libraryFile.findUnique({ where: { id: body.fileId } });
    if (!file) throw new HttpError(404, 'NOT_FOUND', 'Library file not found');

    // Parse content based on MIME type
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(file.content) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Library file content is not valid JSON');
    }

    // Load target nodes
    const nodes = await db.node.findMany({
      where: { id: { in: body.nodeIds }, status: 'ONLINE' },
      select: { id: true, name: true, ipAddress: true, port: true },
    });

    if (nodes.length === 0) {
      throw new HttpError(400, 'NO_ONLINE_NODES', 'No online nodes found from the provided list');
    }

    // Claim after validation/preview/preflight so a rejected retry is not a duplicate.
    await enforceIdempotencyFromHeader(c);
    const results = await Promise.allSettled(
      nodes.map(async (node) => {
        const client = new NodeApiClient({
          baseUrl: getNodeBaseUrl(node.ipAddress, node.port),
          resourceNodeId: node.id,
          nodeToken: getNodeManagerSecret(),
          timeout: 30_000,
        });

        try {
          if (file.mimeType === 'application/x-magnus-skill') {
            // Deploy skill: write each file to /opt/magnus/skills/{name}/{version}/
            const manifest = parsed['manifest'] as Record<string, string> | undefined;
            const files = parsed['files'] as Record<string, string> | undefined;
            const skillName = (manifest?.['name'] ?? file.name) as string;
            const skillVersion = (manifest?.['version'] ?? '1.0.0') as string;

            if (files) {
              for (const [fileName, content] of Object.entries(files)) {
                const filePath = `/opt/magnus/skills/${skillName}/${skillVersion}/${fileName}`;
                await client.writeFile({
                  filePath,
                  content: content as string,
                  createIfMissing: true,
                });
              }
            }
          } else if (file.mimeType === 'application/x-magnus-cronjob') {
            const cron = createCronSchema.parse({ ...parsed, nodeId: node.id, name: parsed['name'] ?? file.name });
            const mode = await cronMutationMode(node.id);
            if (mode === 'legacy') {
              await client.syncCronJob({ nodeId: node.id, name: cron.name, description: cron.description,
                schedule: cron.schedule, command: cron.command, args: cron.args,
                workingDirectory: cron.workingDirectory ?? undefined,
                environment: sanitizeDetails(cron.environment) as Record<string, string>, timeoutSeconds: cron.timeoutSeconds });
            } else {
              if (!cron.managed) throw new Error('Activated nodes require an exact finite managed cron revision');
              const { job } = await upsertAndRegisterManagedCron(node.id, cron.name, {
                description: cron.description, schedule: cron.schedule, command: cron.command,
                args: JSON.stringify(cron.args), workingDirectory: cron.workingDirectory ?? null,
                environment: JSON.stringify(sanitizeDetails(cron.environment)), timeoutSeconds: cron.timeoutSeconds,
                status: 'ACTIVE', createdBy: user.userId,
              }, cron.managed);
              await installManagedCron(job.id, user.userId);
            }
          } else {
            throw new Error(`Unsupported MIME type for deploy: ${file.mimeType}`);
          }

          return {
            nodeId: node.id,
            nodeName: node.name,
            status: 'success' as const,
          };
        } catch (err: unknown) {
          return {
            nodeId: node.id,
            nodeName: node.name,
            status: 'failed' as const,
            error: err instanceof Error ? err.message : 'Unknown error',
          };
        }
      }),
    );

    const data = results.map((r) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            nodeId: 'unknown',
            nodeName: 'unknown',
            status: 'failed' as const,
            error: r.reason instanceof Error ? r.reason.message : 'Unknown error',
          },
    );

    await logAuditEvent({
      action: 'library.deploy',
      actorId: user.userId,
      targetType: 'library_file',
      targetId: body.fileId,
      details: {
        fileName: file.name,
        mimeType: file.mimeType,
        nodeCount: body.nodeIds.length,
        successCount: data.filter((d) => d.status === 'success').length,
      },
    });

    return c.json({ success: true, data });
  },
);
