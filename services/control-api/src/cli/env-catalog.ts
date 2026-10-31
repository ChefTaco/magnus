/**
 * Documented environment variables for magnus-server.
 *
 * This catalogue drives `magnus-server env-schema` and the README/.env.example
 * documentation. `required` means the server refuses to start without it;
 * `requiredWhen` names the feature flag that makes an optional variable
 * mandatory. Secrets are never printed by `magnus-server check`.
 */
export type EnvGroup =
  | 'core' | 'database' | 'redis' | 'listener' | 'secrets' | 'paths' | 'agents'
  | 'iam' | 'router' | 'hivemem' | 'security' | 'plugins' | 'hermes' | 'ai' | 'retention';

export interface EnvVariable {
  name: string;
  group: EnvGroup;
  description: string;
  required?: boolean;
  requiredWhen?: string;
  secret?: boolean;
  default?: string;
}

const secret32 = (name: string, description: string): EnvVariable =>
  ({ name, group: 'secrets', required: true, secret: true, description: `${description} At least 32 characters; must differ from every other secret.` });

export const ENV_CATALOG: readonly EnvVariable[] = [
  // ── Core ──
  { name: 'NODE_ENV', group: 'core', default: 'development', description: 'development, production or test. Production enforces TLS, DATABASE_URL and strict CORS.' },
  { name: 'LOG_LEVEL', group: 'core', default: 'info', description: 'debug, info, warn, error or fatal.' },
  { name: 'MAGNUS_HOME', group: 'paths', default: '~/.magnus', description: 'Base directory for server-owned data (audit logs, credential rotation state, backups).' },
  { name: 'MAGNUS_ENV_FILE', group: 'paths', description: 'Env file loaded at startup (set by `--env-file`). Variables already in the environment win.' },
  { name: 'AUDIT_LOG_DIR', group: 'paths', default: '$MAGNUS_HOME/audit-logs', description: 'Directory for the append-only audit log files.' },
  { name: 'CREDENTIAL_ROTATION_STATE_PATH', group: 'paths', default: '$MAGNUS_HOME/state/credential-rotations.json', description: 'Encrypted credential rotation state file.' },
  { name: 'SKILLS_DIR', group: 'paths', description: 'Skill catalogue directory. Defaults to the bundled @hivemagnus/magnus-skills package.' },

  // ── Database / Redis ──
  { name: 'DATABASE_URL', group: 'database', requiredWhen: 'NODE_ENV=production', secret: true, default: 'postgresql://magnus@127.0.0.1:5432/magnus (development only)', description: 'PostgreSQL connection string.' },
  { name: 'DATABASE_POOL_SIZE', group: 'database', default: '20', description: 'Maximum PostgreSQL connections.' },
  { name: 'REDIS_URL', group: 'redis', default: 'redis://127.0.0.1:6379', secret: true, description: 'Redis connection URL (queues, rate limits, event bus).' },
  { name: 'REDIS_PREFIX', group: 'redis', default: 'magnus:', description: 'Key prefix for every Redis key.' },

  // ── Listener ──
  { name: 'CONTROL_API_PORT', group: 'listener', default: '4000', description: 'HTTPS listener port.' },
  { name: 'CONTROL_API_BIND_HOST', group: 'listener', description: 'Bind address. Cleartext HTTP is always confined to loopback.' },
  { name: 'CONTROL_API_URL', group: 'listener', default: 'https://localhost:4000', description: 'Public URL of this server, given to agents.' },
  { name: 'TLS_CERT_PATH', group: 'listener', requiredWhen: 'NODE_ENV=production', description: 'PEM certificate. Relative paths resolve against the working directory.' },
  { name: 'TLS_KEY_PATH', group: 'listener', requiredWhen: 'NODE_ENV=production', secret: true, description: 'PEM private key matching TLS_CERT_PATH.' },
  { name: 'ALLOW_INSECURE_HTTP', group: 'listener', default: 'false', description: 'Development only: serve cleartext HTTP on loopback when no certificate is configured.' },
  { name: 'CORS_ORIGIN', group: 'listener', default: 'https://localhost:3000', description: 'Comma-separated browser origins allowed to call the API (the dashboard).' },
  { name: 'DASHBOARD_PUBLIC_ORIGIN', group: 'listener', description: 'Public HTTPS origin of the dashboard, used for links in notifications.' },

  // ── Required secrets ──
  secret32('API_SECRET', 'Dashboard-to-server shared secret (x-api-secret).'),
  { ...secret32('JWT_SECRET', 'HS256 key for locally issued user tokens.'), required: false, requiredWhen: 'IAM_CORE_URL unset' },
  secret32('NODE_MANAGER_SECRET', 'Shared secret agents use to authenticate heartbeats.'),
  secret32('AUDIT_HMAC_SECRET', 'Dedicated audit-chain HMAC key.'),
  secret32('RESULT_SIGNING_SECRET', 'HMAC key that verifies agent command results.'),
  secret32('LOG_INGEST_SIGNING_SECRET', 'HMAC key that verifies agent log uploads.'),
  secret32('CREDENTIAL_ROTATION_KEY', 'Encryption key for the credential rotation store.'),
  secret32('METRICS_TOKEN', 'Bearer token for GET /metrics (Prometheus).'),
  secret32('WEBHOOK_ENCRYPTION_KEY', 'Encryption key for stored webhook credentials.'),

  // ── Agents ──
  { name: 'ENABLE_AGENT_DISCOVERY', group: 'agents', default: 'false', description: 'Allow agents to self-register through the discovery endpoint.' },
  { name: 'AGENT_DISCOVERY_SECRET', group: 'agents', secret: true, requiredWhen: 'ENABLE_AGENT_DISCOVERY=true', description: 'Shared secret for agent self-registration.' },
  { name: 'AGENT_TLS_DOMAIN_SUFFIX', group: 'agents', description: 'DNS suffix used to derive agent certificate hostnames.' },
  { name: 'MAGNUS_NODE_DNS_SUFFIX', group: 'agents', description: 'Optional DNS suffix (for example a private overlay domain) under which agents report their FQDN.' },
  { name: 'SSH_USERNAME', group: 'agents', description: 'SSH user for agent install and upgrade over SSH.' },
  { name: 'SSH_PRIVATE_KEY_PATH', group: 'agents', description: 'SSH private key for SSH_USERNAME (preferred over a password).' },
  { name: 'SSH_PASSWORD', group: 'agents', secret: true, description: 'SSH password for SSH_USERNAME.' },
  { name: 'MAGNUS_DOCKER_USER', group: 'agents', description: 'Account whose docker group membership the server checks on its own host.' },
  { name: 'MAGNUS_RESOURCE_LEASES_ENABLED', group: 'agents', default: 'false', description: 'Enable durable node and shared-resource lease coordination.' },

  // ── Hive IAM ──
  { name: 'IAM_CORE_URL', group: 'iam', description: 'Hive IAM base URL. When set, RS256 tokens from Hive IAM replace local JWTs.' },
  { name: 'IAM_TOKEN_ISSUER', group: 'iam', requiredWhen: 'IAM_CORE_URL set', description: 'Exact `iss` claim required on IAM access tokens.' },
  { name: 'IAM_TOKEN_AUDIENCE', group: 'iam', requiredWhen: 'IAM_CORE_URL set', description: 'Exact `aud` claim required on IAM access tokens.' },

  // ── Hive Router ──
  { name: 'MAGNUS_ROUTER_URL', group: 'router', description: 'OpenAI-compatible model router (for example Hive Router) for managed Hermes Agents. HIVE_ROUTER_URL is accepted as an alias.' },
  { name: 'MAGNUS_ROUTER_MODEL', group: 'router', description: 'Default model served by the router. HIVE_ROUTER_MODEL is accepted as an alias.' },
  { name: 'MAGNUS_ROUTER_API_KEY', group: 'router', secret: true, description: 'Router API key. HIVE_ROUTER_API_KEY is accepted as an alias.' },
  { name: 'HIVE_ROUTER_HEALTH_URL', group: 'router', description: 'Optional router health endpoint.' },

  // ── HiveMem ──
  { name: 'HIVEMEM_URL', group: 'hivemem', description: 'HiveMem shared agent memory base URL.' },
  { name: 'HIVEMEM_TOKEN', group: 'hivemem', secret: true, description: 'HiveMem API token.' },
  { name: 'MAGNUS_LESSONS_HIVEMEM_URL', group: 'hivemem', description: 'Optional HiveMem URL for operational lessons.' },
  { name: 'MAGNUS_LESSONS_HIVEMEM_TOKEN', group: 'hivemem', secret: true, description: 'Token for MAGNUS_LESSONS_HIVEMEM_URL.' },

  // ── Security Fusion / external security console ──
  { name: 'SECURITY_FUSION_MODE', group: 'security', default: 'off', description: 'off (feature disabled), local (cases and evidence in this server) or remote (export to an external security console).' },
  { name: 'SECURITY_FUSION_RECEIPT_SIGNING_KEY', group: 'security', secret: true, requiredWhen: 'SECURITY_FUSION_MODE=local', description: 'Dedicated key that signs Security Fusion deletion receipts (min 32 chars).' },
  { name: 'SECURITY_FUSION_EVIDENCE_DIR', group: 'security', description: 'Private evidence directory (local mode).' },
  { name: 'SECURITY_FUSION_CONTAINMENT_COMMAND', group: 'security', description: 'Absolute path of an operator-installed containment helper on managed nodes (local mode release).' },
  { name: 'MAGNUS_SECURITY_CONSOLE_URL', group: 'security', description: 'External security console URL returned to clients in remote mode.' },
  { name: 'SECURITY_FUSION_API_URL', group: 'security', description: 'External security console API base URL (HTTPS) for exports and summaries (remote mode).' },
  { name: 'SECURITY_EXPORT_ENABLED', group: 'security', default: 'false', description: 'Export heartbeat service observations to SECURITY_FUSION_API_URL (remote mode).' },
  { name: 'SECURITY_EXPORT_SECRET', group: 'security', secret: true, description: 'HMAC key for signed exports to the external console.' },
  { name: 'SECURITY_SUMMARY_TOKEN', group: 'security', secret: true, description: 'Bearer token for reading the external console summary.' },
  { name: 'SECURITY_INVENTORY_TOKEN_SHA256', group: 'security', description: 'SHA-256 digest of the bearer the external console uses to read node inventory.' },
  { name: 'SECURITY_BACKUP_TOKEN_SHA256', group: 'security', description: 'SHA-256 digest of the bearer allowed to upload encrypted security backups.' },
  { name: 'SECURITY_BACKUP_DIRECTORY', group: 'security', default: '$MAGNUS_HOME/security-backups', description: 'Destination for uploaded security backups.' },
  { name: 'SECURITY_FUSION_MATTERMOST_URL', group: 'security', description: 'Optional Mattermost server for Security Fusion case notifications.' },
  { name: 'SECURITY_FUSION_MATTERMOST_BOT_TOKEN', group: 'security', secret: true, description: 'Mattermost bot token.' },
  { name: 'SECURITY_FUSION_MATTERMOST_CHANNEL_ID', group: 'security', description: 'Mattermost channel ID.' },

  // ── Hermes Agent plugin API ──
  { name: 'MAGNUS_PLUGIN_API_ENABLED', group: 'plugins', default: 'false', description: 'Accept Hermes Agent plugin credentials on the plugin-scoped routes.' },
  { name: 'MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON', group: 'plugins', requiredWhen: 'MAGNUS_PLUGIN_API_ENABLED=true', description: 'JSON object {consumerId: sha256(token)} of 1-16 read-only plugin credentials.' },
  { name: 'MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256', group: 'plugins', requiredWhen: 'MAGNUS_PLUGIN_API_ENABLED=true', description: 'SHA-256 digest of the server-local plugin operator credential.' },
  { name: 'MAGNUS_APPROVAL_BRIDGE_CONSUMER', group: 'plugins', description: 'Plugin read consumer allowed to list approval plans and relay signed decisions.' },
  { name: 'APPROVAL_SIGNER_PUBLIC_KEY_PEM', group: 'plugins', description: 'Ed25519 public key (PEM) that signs approval decisions. _B64 (DER) and _PATH variants are also accepted.' },
  { name: 'APPROVAL_TELEGRAM_ACTOR_SHA256', group: 'plugins', description: 'Actor binding digest for decisions from the Telegram channel.' },
  { name: 'APPROVAL_IPHONE_ACTOR_SHA256', group: 'plugins', description: 'Actor binding digest for decisions from the iPhone channel.' },
  { name: 'MAGNUS_COLLECTOR_TOKEN_SHA256', group: 'plugins', description: 'SHA-256 digest of a read-only external observability collector credential.' },
  { name: 'MAGNUS_FLEET_CHECK_TOKEN_SHA256', group: 'plugins', description: 'SHA-256 digest of the fleet-check reporter credential.' },

  // ── Hermes registry ──
  { name: 'MAGNUS_HERMES_REGISTRY_ENABLED', group: 'hermes', default: 'false', description: 'Import the packaged skill catalogue and monitor tracked plugin sources in the background.' },
  { name: 'MAGNUS_REGISTRY_DEPLOY_HOSTS', group: 'hermes', default: '', description: 'Comma-separated short hostnames (optionally host:stage) allowed to pull registry deployments. Stage 0 hosts are canaries.' },
  { name: 'MAGNUS_REGISTRY_SUBMIT_ONLY_HOSTS', group: 'hermes', default: '', description: 'Comma-separated short hostnames that may submit registry changes but never pull.' },

  // ── AI assistant ──
  { name: 'OLLAMA_URL', group: 'ai', default: 'http://127.0.0.1:11434', description: 'Ollama endpoint for the fleet assistant.' },
  { name: 'OLLAMA_MODEL', group: 'ai', description: 'Ollama model name.' },
  { name: 'LLAMACPP_URL', group: 'ai', default: 'http://127.0.0.1:8080', description: 'llama.cpp (OpenAI-compatible) endpoint.' },
  { name: 'OPENAI_API_KEY', group: 'ai', secret: true, description: 'Optional OpenAI provider key.' },
  { name: 'OPENROUTER_API_KEY', group: 'ai', secret: true, description: 'Optional OpenRouter provider key.' },
  { name: 'ANTHROPIC_API_KEY', group: 'ai', secret: true, description: 'Optional Anthropic provider key.' },

  // ── Retention ──
  { name: 'LOG_RETENTION_DAYS', group: 'retention', default: '30', description: 'Days to keep ingested node logs.' },
  { name: 'HEALTH_SNAPSHOT_RETENTION_DAYS', group: 'retention', default: '7', description: 'Days to keep health snapshots.' },
  { name: 'NOTIFICATION_MAX_RETENTION_DAYS', group: 'retention', default: '90', description: 'Days to keep notifications.' },
];

/** JSON document printed by `magnus-server env-schema`. */
export function buildEnvSchemaDocument() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'magnus-server environment',
    variables: ENV_CATALOG.map(variable => ({
      name: variable.name,
      group: variable.group,
      required: variable.required === true,
      ...(variable.requiredWhen ? { requiredWhen: variable.requiredWhen } : {}),
      secret: variable.secret === true,
      ...(variable.default !== undefined ? { default: variable.default } : {}),
      description: variable.description,
    })),
  };
}

/** Plain-text table for `magnus-server env-schema --format table`. */
export function renderEnvTable(): string {
  const rows = ENV_CATALOG.map(variable => [
    variable.name,
    variable.group,
    variable.required ? 'yes' : variable.requiredWhen ? `if ${variable.requiredWhen}` : 'no',
    variable.default ?? '',
  ]);
  const header = ['NAME', 'GROUP', 'REQUIRED', 'DEFAULT'];
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map(row => row[index]!.length)));
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index]!)).join('  ').trimEnd();
  return [line(header), line(widths.map(width => '-'.repeat(width))), ...rows.map(line)].join('\n') + '\n';
}
