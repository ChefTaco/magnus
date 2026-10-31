/**
 * User management routes — provision / check / change password for linux users.
 * Auth: x-node-token (nodeAuthMiddleware applied at mount).
 */
import { Hono } from 'hono';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';

const usernameSchema = z.string().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/);
// chpasswd reads one `user:password` record per line, so a line break would
// let a caller append a record for another account.
const passwordSchema = z.string().min(1).max(512).refine((value) => !/[\r\n\0]/.test(value), 'Password must not contain line breaks or NUL');
// Privileged groups would turn a provisioned login into root-equivalent access.
const PRIVILEGED_GROUPS = new Set(['root', 'sudo', 'wheel', 'adm', 'admin', 'docker', 'lxd', 'disk', 'shadow', 'systemd-journal']);

const ProvisionSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  group: z.string().min(1).max(32).regex(/^[a-z_][a-z0-9_-]*$/)
    .refine((value) => !PRIVILEGED_GROUPS.has(value), 'Privileged groups are not allowed').default('magnus'),
});

const ChangePasswordSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});

export const userRoutes = new Hono();

/** Set a user's password securely via chpasswd stdin (avoids /proc exposure). */
function setPassword(username: string, password: string): void {
  execFileSync('chpasswd', [], { input: `${username}:${password}\n` });
}

/** GET / — list linux usernames (UID >= 1000, excluding nobody/nfsnobody). */
userRoutes.get('/', (_c) => {
  try {
    const output = execFileSync('getent', ['passwd'], { encoding: 'utf8', timeout: 10_000 });
    const users = output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(':');
        return { username: parts[0]!, uid: Number(parts[2]) };
      })
      .filter((u) => u.uid >= 1000 && u.username !== 'nobody' && u.username !== 'nfsnobody')
      .map((u) => u.username);
    return _c.json({ success: true, data: users });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to list users';
    return _c.json({ success: false, error: msg }, 500);
  }
});

/** POST /provision — create linux user in specified group with password. */
userRoutes.post('/provision', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = ProvisionSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      { success: false, error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: parsed.error.flatten().fieldErrors } },
      400,
    );
  }

  const { username, password, group } = parsed.data;

  try {
    // Ensure group exists
    try {
      execFileSync('getent', ['group', group], { encoding: 'utf8', timeout: 10_000 });
    } catch {
      execFileSync('groupadd', [group]);
    }

    // Check if user already exists
    try {
      execFileSync('id', [username], { encoding: 'utf8' });
      return c.json({ success: false, error: { code: 'CONFLICT', message: `User '${username}' already exists on this node` } }, 409);
    } catch {
      // User does not exist — proceed
    }

    // Create user with group
    execFileSync('useradd', ['-m', '-g', group, '-s', '/bin/bash', '--', username]);

    // Set password securely via stdin
    setPassword(username, password);

    return c.json({ success: true, data: { username, group } }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to provision user';
    return c.json({ success: false, error: { code: 'PROVISION_ERROR', message: msg } }, 500);
  }
});

/** POST /change-password — change password for an existing linux user. */
userRoutes.post('/change-password', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = ChangePasswordSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      { success: false, error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: parsed.error.flatten().fieldErrors } },
      400,
    );
  }

  const { username, password } = parsed.data;

  try {
    // Verify user exists
    try {
      execFileSync('id', [username], { encoding: 'utf8' });
    } catch {
      return c.json({ success: false, error: { code: 'NOT_FOUND', message: `User '${username}' does not exist on this node` } }, 404);
    }

    // Change password securely via stdin
    setPassword(username, password);

    return c.json({ success: true, data: { username } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to change password';
    return c.json({ success: false, error: { code: 'PASSWORD_ERROR', message: msg } }, 500);
  }
});
