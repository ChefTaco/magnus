import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Hono } from 'hono';
import { z } from 'zod';
import { requirePrivileged } from '../privileged.js';
const execute = promisify(execFile);
const schema = z
  .object({
    operation: z.enum(['execute', 'release']),
    kind: z.enum(['service_restart', 'host_isolation']),
    serviceName: z
      .string()
      .regex(/^[a-zA-Z0-9@_.-]+\.service$/)
      .nullable(),
    isolationMinutes: z.number().int().min(1).max(30).nullable(),
  })
  .strict();
export const securityResponseRoutes = new Hono();
securityResponseRoutes.post('/', requirePrivileged('security-response'), async (c) => {
  const parsed = schema.safeParse(await c.req.json());
  if (!parsed.success || process.env['MAGNUS_SECURITY_RESPONSE_ENABLED'] !== 'true')
    return c.json(
      {
        success: false,
        error: {
          code: 'RESPONSE_DISABLED',
          message: 'Explicit node response capability is required',
        },
      },
      403,
    );
  const helper = process.env['MAGNUS_SECURITY_CONTAINMENT_COMMAND'] ?? '';
  if (!/^\/[A-Za-z0-9._/-]{1,255}$/.test(helper) || helper.includes('..'))
    return c.json(
      {
        success: false,
        error: { code: 'RESPONSE_DISABLED', message: 'Containment helper is not configured' },
      },
      403,
    );
  for (
    let parent = helper.slice(0, helper.lastIndexOf('/')) || '/';
    ;
    parent = parent.slice(0, parent.lastIndexOf('/')) || '/'
  ) {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0)
      throw new Error('Containment helper must be under root-controlled directories');
    if (parent === '/') break;
  }
  const stat = await lstat(helper);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    (stat.mode & 0o022) !== 0 ||
    (await realpath(helper)) !== helper
  )
    throw new Error('Unsafe containment helper');
  const p = parsed.data;
  const args =
    p.operation === 'release'
      ? ['release']
      : p.kind === 'service_restart'
        ? ['restart-service', p.serviceName ?? '']
        : ['isolate', '--minutes', String(p.isolationMinutes ?? 15)];
  if (p.operation !== 'release' && p.kind === 'service_restart' && !p.serviceName)
    return c.json(
      { success: false, error: { code: 'INVALID_SERVICE', message: 'Service is required' } },
      400,
    );
  try {
    await execute(helper, args, {
      timeout: 110000,
      maxBuffer: 65536,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
    });
    return c.json({ success: true, data: { exitCode: 0 } });
  } catch (error) {
    const code = (error as { code?: unknown; killed?: boolean }).code;
    if (typeof code !== 'number' || code === 70 || (error as { killed?: boolean }).killed)
      throw new Error('Containment completion is unknown');
    return c.json({ success: true, data: { exitCode: code } });
  }
});
