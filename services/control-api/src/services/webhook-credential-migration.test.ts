import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyWebhookCredentialMigration,
  assertWebhookMigrationCanApply,
  type WebhookCredentialRow,
  type WebhookCredentialStore,
} from './webhook-credential-migration.js';
import { decryptWebhookCredential } from './webhook-security.js';

const encryptionKey = 'webhook-migration-test-key-with-more-than-32-bytes';

function cloneRows(rows: readonly WebhookCredentialRow[]): WebhookCredentialRow[] {
  return rows.map((row) => ({ ...row }));
}

function fakeTransactionalStore(initial: readonly WebhookCredentialRow[], failOnUpdate = Number.POSITIVE_INFINITY): {
  store: WebhookCredentialStore;
  rows: () => WebhookCredentialRow[];
} {
  let committed = cloneRows(initial);
  const unusedEndpointMethods = {
    findMany: async () => cloneRows(committed),
    update: async () => undefined,
  };
  const store: WebhookCredentialStore = {
    webhookEndpoint: unusedEndpointMethods,
    $transaction: async (operation) => {
      const working = cloneRows(committed);
      let updates = 0;
      const result = await operation({
        webhookEndpoint: {
          findMany: async () => cloneRows(working),
          update: async ({ where, data }) => {
            updates += 1;
            if (updates === failOnUpdate) throw new Error('injected migration write failure');
            const row = working.find((candidate) => candidate.id === where.id);
            if (!row) throw new Error('missing fake webhook row');
            Object.assign(row, data);
          },
        },
      });
      committed = working;
      return result;
    },
  };
  return { store, rows: () => cloneRows(committed) };
}

beforeEach(() => {
  process.env['WEBHOOK_ENCRYPTION_KEY'] = encryptionKey;
});

afterEach(() => {
  delete process.env['WEBHOOK_ENCRYPTION_KEY'];
  delete process.env['WEBHOOK_MIGRATION_SERVICE_STOPPED'];
});

describe('webhook credential migration', () => {
  it('requires an explicit stopped-service assertion before apply mode', () => {
    expect(() => assertWebhookMigrationCanApply(true, undefined)).toThrow(/stop magnus-control-api/);
    expect(() => assertWebhookMigrationCanApply(true, '0')).toThrow(/stop magnus-control-api/);
    expect(() => assertWebhookMigrationCanApply(true, '1')).not.toThrow();
    expect(() => assertWebhookMigrationCanApply(false, undefined)).not.toThrow();
  });

  it('encrypts plaintext rows, emits no plaintext, and is byte-idempotent on a second run', async () => {
    const signingSecret = 'legacy-signing-secret';
    const authHeader = 'Bearer legacy-header-secret';
    const fake = fakeTransactionalStore([{
      id: 'endpoint-a',
      secret: signingSecret,
      headers: JSON.stringify({ authorization: authHeader }),
    }]);

    await expect(applyWebhookCredentialMigration(fake.store)).resolves.toEqual({ total: 1, migrated: 1 });
    const migrated = fake.rows();
    expect(JSON.stringify(migrated)).not.toContain(signingSecret);
    expect(JSON.stringify(migrated)).not.toContain(authHeader);
    expect(decryptWebhookCredential(migrated[0]!.secret!, 'endpoint-a', 'secret')).toBe(signingSecret);
    expect(decryptWebhookCredential(migrated[0]!.headers, 'endpoint-a', 'headers'))
      .toBe(JSON.stringify({ authorization: authHeader }));

    const beforeSecondRun = JSON.stringify(migrated);
    await expect(applyWebhookCredentialMigration(fake.store)).resolves.toEqual({ total: 1, migrated: 0 });
    expect(JSON.stringify(fake.rows())).toBe(beforeSecondRun);
  });

  it('rolls back every row when a transactional write or verification fails', async () => {
    const initial = [
      { id: 'endpoint-a', secret: 'secret-a', headers: '{}' },
      { id: 'endpoint-b', secret: 'secret-b', headers: '{}' },
    ];
    const fake = fakeTransactionalStore(initial, 2);
    await expect(applyWebhookCredentialMigration(fake.store)).rejects.toThrow(/injected migration write failure/);
    expect(fake.rows()).toEqual(initial);
  });

  it('rejects unsupported envelope versions instead of double-encrypting them', async () => {
    const initial = [{ id: 'endpoint-a', secret: null, headers: 'magnus-webhook:v2:payload' }];
    const fake = fakeTransactionalStore(initial);
    await expect(applyWebhookCredentialMigration(fake.store)).rejects.toThrow(/unsupported encrypted envelope/);
    expect(fake.rows()).toEqual(initial);
  });
});
