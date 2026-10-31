import { PrismaClient } from './generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Development-only fallback: a local PostgreSQL database named `magnus`
 * reached as role `magnus` with no password (trust/peer auth). Production
 * (`NODE_ENV=production`) always requires DATABASE_URL.
 */
export const DEVELOPMENT_DATABASE_URL = 'postgresql://magnus@127.0.0.1:5432/magnus';

/** Resolve the PostgreSQL connection string, failing fast in production. */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['DATABASE_URL']?.trim();
  if (configured) return configured;
  if (env['NODE_ENV'] === 'production') throw new Error('DATABASE_URL is required when NODE_ENV=production');
  return DEVELOPMENT_DATABASE_URL;
}

let prisma: PrismaClient | undefined;

/** Singleton Prisma client — reuses connection across hot-reloads in dev. */
export function getDb(): PrismaClient {
  if (!prisma) {
    const adapter = new PrismaPg({
      connectionString: resolveDatabaseUrl(),
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: Number(process.env['DATABASE_POOL_SIZE'] ?? 20),
    });
    prisma = new PrismaClient({
      adapter,
      log:
        process.env['NODE_ENV'] === 'development'
          ? ['query', 'warn', 'error']
          : ['warn', 'error'],
    });
  }
  return prisma;
}

export async function disconnectDb(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = undefined;
  }
}

export { PrismaClient };
