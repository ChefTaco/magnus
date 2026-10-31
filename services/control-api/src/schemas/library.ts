/**
 * Zod schemas for library routes.
 */

import { z } from 'zod';

// ── POST /library/categories ──
export const createCategorySchema = z.object({
  name: z.string().min(1, 'Category name is required'),
  description: z.string().optional().default(''),
  color: z.string().optional().default('#6366f1'),
  sortOrder: z.number().int().optional().default(0),
});

// ── PATCH /library/categories/:categoryId ──
export const updateCategorySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  color: z.string().optional(),
  sortOrder: z.number().int().optional(),
});

// ── POST /library/files ──
export const createLibraryFileSchema = z.object({
  name: z.string().min(1, 'File name is required'),
  fileName: z.string().min(1, 'File name is required'),
  mimeType: z.string().optional().default('text/markdown'),
  content: z.string().optional().default(''),
  categoryId: z.string().nullable().optional(),
  tags: z.array(z.string()).optional().default([]),
});

// ── PATCH /library/files/:fileId ──
export const updateLibraryFileSchema = z.object({
  name: z.string().min(1).optional(),
  fileName: z.string().min(1).optional(),
  mimeType: z.string().optional(),
  content: z.string().optional(),
  categoryId: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
});

// ── POST /library/files/move ──
export const moveFilesSchema = z.object({
  fileIds: z.array(z.string().min(1)).min(1, 'fileIds array is required'),
  categoryId: z.string().nullable().optional(),
});

// ── POST /library/deploy ──
export const deployLibrarySchema = z.object({
  fileId: z.string().min(1, 'fileId is required'),
  nodeIds: z.array(z.string().min(1)).min(1, 'At least one nodeId is required'),
  overwrite: z.boolean().optional().default(false),
});
