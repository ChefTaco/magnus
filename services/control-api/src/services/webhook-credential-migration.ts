import {
  decryptWebhookCredential,
  encryptWebhookCredential,
  isEncryptedWebhookCredential,
} from './webhook-security.js';

export interface WebhookCredentialRow {
  id: string;
  secret: string | null;
  headers: string;
  url?: string;
}

interface WebhookCredentialTransaction {
  webhookEndpoint: {
    findMany(args: { orderBy: { id: 'asc' } }): Promise<WebhookCredentialRow[]>;
    update(args: {
      where: { id: string };
      data: { secret?: string; headers?: string; url?: string };
    }): Promise<unknown>;
  };
}

export interface WebhookCredentialStore extends WebhookCredentialTransaction {
  $transaction<T>(
    operation: (transaction: WebhookCredentialTransaction) => Promise<T>,
    options: { maxWait: number; timeout: number },
  ): Promise<T>;
}

interface MigrationPlan {
  id: string;
  secretPlaintext: string | null;
  headersPlaintext: string;
  migrateSecret: boolean;
  migrateHeaders: boolean;
  urlPlaintext?: string;
  migrateUrl: boolean;
}

export function assertWebhookMigrationCanApply(
  apply: boolean,
  serviceStopped = process.env['WEBHOOK_MIGRATION_SERVICE_STOPPED'],
): void {
  if (apply && serviceStopped !== '1') {
    throw new Error('Refusing live migration: stop magnus-control-api and set WEBHOOK_MIGRATION_SERVICE_STOPPED=1');
  }
}

function rejectUnsupportedEnvelope(value: string, field: 'secret' | 'headers' | 'url'): void {
  if (value.startsWith('magnus-webhook:') && !isEncryptedWebhookCredential(value)) {
    throw new Error(`Webhook ${field} has an unsupported encrypted envelope`);
  }
}

function validateHeaders(plaintext: string): void {
  const parsed = JSON.parse(plaintext) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored webhook headers must be a JSON object');
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (!name || typeof value !== 'string') {
      throw new Error('Stored webhook headers must contain string names and values');
    }
  }
}

function planMigration(rows: readonly WebhookCredentialRow[]): MigrationPlan[] {
  return rows.map((endpoint) => {
    if (endpoint.secret !== null) rejectUnsupportedEnvelope(endpoint.secret, 'secret');
    rejectUnsupportedEnvelope(endpoint.headers, 'headers');
    if (endpoint.url) rejectUnsupportedEnvelope(endpoint.url, 'url');
    const secretPlaintext = endpoint.secret === null
      ? null
      : isEncryptedWebhookCredential(endpoint.secret)
        ? decryptWebhookCredential(endpoint.secret, endpoint.id, 'secret')
        : endpoint.secret;
    const headersPlaintext = isEncryptedWebhookCredential(endpoint.headers)
      ? decryptWebhookCredential(endpoint.headers, endpoint.id, 'headers')
      : endpoint.headers;
    validateHeaders(headersPlaintext);
    return {
      id: endpoint.id,
      urlPlaintext: endpoint.url ? (isEncryptedWebhookCredential(endpoint.url) ? decryptWebhookCredential(endpoint.url, endpoint.id, 'url') : endpoint.url) : undefined,
      migrateUrl: Boolean(endpoint.url && !isEncryptedWebhookCredential(endpoint.url)),
      secretPlaintext,
      headersPlaintext,
      migrateSecret: endpoint.secret !== null && !isEncryptedWebhookCredential(endpoint.secret),
      migrateHeaders: !isEncryptedWebhookCredential(endpoint.headers),
    };
  });
}

export function inspectWebhookCredentialMigration(rows: readonly WebhookCredentialRow[]): {
  total: number;
  pending: number;
} {
  const plans = planMigration(rows);
  return {
    total: plans.length,
    pending: plans.filter((plan) => plan.migrateSecret || plan.migrateHeaders || plan.migrateUrl).length,
  };
}

export async function applyWebhookCredentialMigration(store: WebhookCredentialStore): Promise<{
  total: number;
  migrated: number;
}> {
  return store.$transaction(async (transaction) => {
    const rows = await transaction.webhookEndpoint.findMany({ orderBy: { id: 'asc' } });
    const plans = planMigration(rows);
    const pending = plans.filter((plan) => plan.migrateSecret || plan.migrateHeaders || plan.migrateUrl);
    for (const plan of pending) {
      const data: { secret?: string; headers?: string; url?: string } = {};
      if (plan.migrateSecret && plan.secretPlaintext !== null) {
        data.secret = encryptWebhookCredential(plan.secretPlaintext, plan.id, 'secret');
      }
      if (plan.migrateUrl && plan.urlPlaintext) data.url = encryptWebhookCredential(plan.urlPlaintext, plan.id, 'url');
      if (plan.migrateHeaders) {
        data.headers = encryptWebhookCredential(plan.headersPlaintext, plan.id, 'headers');
      }
      await transaction.webhookEndpoint.update({ where: { id: plan.id }, data });
    }

    const expected = new Map(plans.map((plan) => [plan.id, plan]));
    const verified = await transaction.webhookEndpoint.findMany({ orderBy: { id: 'asc' } });
    if (verified.length !== plans.length) {
      throw new Error('Webhook migration verification row count changed');
    }
    for (const endpoint of verified) {
      const plan = expected.get(endpoint.id);
      if (!plan) throw new Error('Webhook migration verification found an unexpected endpoint');
      if (endpoint.secret !== null) {
        const secret = decryptWebhookCredential(endpoint.secret, endpoint.id, 'secret');
        if (secret !== plan.secretPlaintext) throw new Error('Webhook secret migration verification failed');
      }
      if (plan.urlPlaintext && (!endpoint.url || decryptWebhookCredential(endpoint.url, endpoint.id, 'url') !== plan.urlPlaintext)) throw new Error('Webhook URL migration verification failed');
      const headers = decryptWebhookCredential(endpoint.headers, endpoint.id, 'headers');
      if (headers !== plan.headersPlaintext) throw new Error('Webhook header migration verification failed');
    }
    return { total: plans.length, migrated: pending.length };
  }, { maxWait: 5_000, timeout: 60_000 });
}
