import type pg from 'pg';

/** No DDL, seeding or repairs: reconcile only an already committed owner receipt. */
export async function verifyInitialization(client: pg.Client): Promise<void> {
  const result = await client.query<{ completed: boolean; actor: boolean; sentinels: boolean }>(`SELECT
    EXISTS (SELECT 1 FROM product_initializations WHERE id = 'base-data-v1') AS completed,
    EXISTS (SELECT 1 FROM users WHERE (id = 'system' OR email = 'system@magnus.local') AND active = true AND role = 'ADMIN') AS actor,
    (SELECT count(*) = 2 FROM nodes WHERE id IN ('__control-api__', '__dashboard__') AND os = 'internal' AND arch = 'internal') AS sentinels`);
  const row = result.rows[0];
  if (!row?.completed || !row.actor || !row.sentinels) {
    throw Error('Base initialization is incomplete or its required system records changed; activation remains held. Use the product recovery procedure; no seeding or migration was replayed.');
  }
}
