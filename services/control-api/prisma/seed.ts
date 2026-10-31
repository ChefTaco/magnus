// `npm run db:seed` entry point; the seed itself lives in src/db/seed.ts.
import { getDb, disconnectDb } from '../src/db/client.js';
import { seedDatabase } from '../src/db/seed.js';

seedDatabase(getDb())
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
