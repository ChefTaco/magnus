/**
 * Zod schemas for skill routes.
 */

import { z } from 'zod';

// ── POST /skills ──
export const createSkillSchema = z.object({
  name: z.string().min(1, 'name is required'),
  version: z.string().min(1, 'version is required'),
  description: z.string().optional(),
  entryPoint: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});

// ── PATCH /skills/:name ──
export const updateSkillSchema = z.object({
  version: z.string().optional(),
  description: z.string().optional(),
  entryPoint: z.string().optional(),
  tags: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).optional(),
});

// ── PUT /skills/:name/files/:fileName ──
export const updateSkillFileSchema = z.object({
  content: z.string(),
});

// ── POST /skills/push ──
export const pushSkillSchema = z.object({
  nodeIds: z.array(z.string().min(1)).min(1, 'At least one nodeId is required')
    .max(100).refine(values => new Set(values).size === values.length, 'nodeIds must be unique'),
  skillName: z.string().min(1, 'skillName is required'),
  version: z.string().min(1).max(128).optional(),
});

// ── POST /skills/registry/:slug/publish ──
export const publishVersionSchema = z.object({
  version: z.string().min(1, 'version is required'),
  changelog: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

// ── POST /skills/registry/:slug/tags ──
export const setTagSchema = z.object({
  tag: z.string().min(1, 'tag is required'),
  versionId: z.string().min(1, 'versionId is required'),
});
