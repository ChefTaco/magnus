import { defineConfig } from 'prisma/config';

// DATABASE_URL is required for migrations in production. The fallback matches
// the development-only default in src/db/client.ts (local role `magnus`, no
// password) and is never used when NODE_ENV=production.
const url = process.env['DATABASE_URL']
  ?? (process.env['NODE_ENV'] === 'production' ? undefined : 'postgresql://magnus@127.0.0.1:5432/magnus');
if (!url) throw new Error('DATABASE_URL is required when NODE_ENV=production');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url },
});
