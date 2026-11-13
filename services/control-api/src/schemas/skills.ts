/**
 * Zod schemas for skill routes.
 */

import { z } from 'zod';

/** A new skill's directory name: the same shape the skill routes accept. */
export const SKILL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
/** A new entry point: a plain file name. */
export const SKILL_FILE_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
// The name becomes a directory and the entry point a file in it, on this server and on nodes.
const entryPoint = z.string().regex(SKILL_FILE_NAME_PATTERN, 'entryPoint must be a file name inside the skill directory');

// ── POST /skills ──
export const createSkillSchema = z.object({
  name: z.string().min(1, 'name is required').regex(SKILL_NAME_PATTERN, 'name may contain only letters, digits, underscores and hyphens (at most 100)'),
  version: z.string().min(1, 'version is required'),
  description: z.string().optional(),
  entryPoint: entryPoint.optional(),
  dependencies: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});

// ── PATCH /skills/:name ──
export const updateSkillSchema = z.object({
  version: z.string().optional(),
  description: z.string().optional(),
  entryPoint: entryPoint.optional(),
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
