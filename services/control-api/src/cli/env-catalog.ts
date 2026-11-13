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
  | 'iam' | 'router' | 'hivemem' | 'security' | 'plugins' | 'hermes' | 'ai' | 'retention' | 'upgrades';

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
  { name: 'HIVE_REHEARSAL', group: 'core', default: 'false', description: 'Isolated restore mode: no workers, timers, queue activation, mutations, host execution or terminal WebSockets. Explicit true/false only.' },
  { name: 'NODE_ENV', group: 'core', default: 'development', description: 'development, production or test. Production enforces TLS, DATABASE_URL and strict CORS.' },
  { name: 'LOG_LEVEL', group: 'core', default: 'info', description: 'debug, info, warn, error or fatal.' },
  { name: 'MAGNUS_ROUTE_ALIASES_JSON', group: 'core', description: 'Optional JSON object mapping legacy /api/v1 path prefixes to current ones, for clients built against older route names. Requests are rewritten before routing, so auth and audit see the current path. Unset means no aliases.' },
  { name: 'MAGNUS_WEBHOOK_TYPE_ALIASES', group: 'core', description: 'Optional comma-separated legacy=format pairs (format: generic, slack, discord or mattermost) so webhook endpoints stored or submitted under an older type name keep their delivery format.' },
  { name: 'WEBHOOK_ALLOWED_ORIGINS', group: 'core', description: 'Comma-separated exact HTTPS origins that webhooks may target. Empty refuses every webhook target.' },
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
  { name: 'MAGNUS_CONSOLE_BASE_PATH', group: 'listener', description: 'Path the console is served under on DASHBOARD_PUBLIC_ORIGIN (for example /fleet), prefixed to links in notifications. Unset means the origin root.' },

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
  { name: 'NODE_AUTH_MODE', group: 'agents', default: 'compat', description: 'How agents authenticate: compat accepts a node signature or the shared node secret (a node with its own key is closed to the secret, and to HMAC-only evidence once its agent signs evidence), warn also logs and audits every use of the shared credentials and reports the readiness check node-credentials as failing while anything blocks enforce, enforce accepts signatures and node-signed evidence only.' },
  { name: 'NODE_AUTH_LEGACY_UPGRADE_UNTIL', group: 'agents', description: 'ISO 8601 date until which existing agents may bind their first node key with the shared node secret. Unset means 30 days from the first start of a server with node credentials.' },
  { name: 'NODE_AUTH_SERVER_KEY_PATH', group: 'agents', default: '$MAGNUS_HOME/state/node-auth/server-signing-key.json', description: 'File (mode 0600, created on first start) holding the Ed25519 key that signs requests to agents. Keep it with the database in backups.' },
  { name: 'NODE_AUTO_REGISTER', group: 'agents', default: 'true', description: 'Add an unknown agent that presents the shared node secret to the inventory on its first heartbeat. Set false to require registration first.' },
  { name: 'MAGNUS_NODE_DNS_SUFFIX', group: 'agents', description: 'Optional DNS suffix (for example a private overlay domain) under which agents report their FQDN.' },
  { name: 'SSH_USERNAME', group: 'agents', description: 'SSH user for agent install and upgrade over SSH.' },
  { name: 'SSH_PRIVATE_KEY_PATH', group: 'agents', description: 'SSH private key for SSH_USERNAME (preferred over a password).' },
  { name: 'SSH_HOST_KEY_PINS_FILE', group: 'agents', description: 'Required for SSH operations: trusted hostname:port to SHA256 host-key fingerprint arrays in a local JSON file.' },
  { name: 'SSH_PASSWORD', group: 'agents', secret: true, description: 'SSH password for SSH_USERNAME.' },
  { name: 'MAGNUS_DOCKER_USER', group: 'agents', description: 'Account whose docker group membership the server checks on its own host.' },
  { name: 'MAGNUS_RESOURCE_LEASES_ENABLED', group: 'agents', default: 'false', description: 'Enable durable node and shared-resource lease coordination.' },

  // ── Hive IAM ──
  { name: 'IAM_CORE_URL', group: 'iam', description: 'Hive IAM base URL. When set, RS256 tokens from Hive IAM replace local JWTs.' },
  { name: 'IAM_TOKEN_ISSUER', group: 'iam', requiredWhen: 'IAM_CORE_URL set', description: 'Exact `iss` claim required on IAM access tokens.' },
  { name: 'IAM_TOKEN_AUDIENCE', group: 'iam', requiredWhen: 'IAM_CORE_URL set', description: 'Exact `aud` claim required on IAM access tokens.' },

  // ── Oathweave browser console tokens ──
  { name: 'OATHWEAVE_ISSUER', group: 'iam', description: 'Exact `iss` claim of Oathweave resource tokens (audience `magnus`). Cannot be combined with IAM_CORE_URL.' },
  { name: 'OATHWEAVE_JWKS_URL', group: 'iam', requiredWhen: 'OATHWEAVE_ISSUER set', description: 'HTTPS JWKS URL that verifies Oathweave token signatures.' },
  { name: 'OATHWEAVE_USERINFO_URL', group: 'iam', requiredWhen: 'OATHWEAVE_ISSUER set', description: 'HTTPS userinfo URL used for online session revocation (logout takes effect within 15 seconds, including on open streams).' },
  { name: 'MAGNUS_OATHWEAVE_IDENTITIES_JSON', group: 'iam', requiredWhen: 'OATHWEAVE_ISSUER set', description: 'JSON array of {issuer,subject,localUserId,role}. Exact issuer and subject match, never by email; a missing or duplicate link is refused. `role` caps what the token permissions magnus:admin, magnus:operate and magnus:view can grant.' },

  // ── Fleet gateway (web terminal) ──
  { name: 'FLEET_GATEWAY_URL', group: 'iam', description: 'HTTPS origin of the fleet gateway, the separate service holding the restricted SSH key. Enables the console terminal capability with FLEET_GATEWAY_TOKEN_SHA256, and receives console drain challenges.' },
  { name: 'FLEET_GATEWAY_TOKEN_SHA256', group: 'iam', requiredWhen: 'FLEET_GATEWAY_URL set', description: 'SHA-256 digest of the credential the fleet gateway presents to resolve nodes and record terminal audit events.' },
  { name: 'RESOURCE_ENROLLMENT_DASHBOARD_PARTICIPANT', group: 'iam', description: '`gateway` (default) sends console drain challenges to FLEET_GATEWAY_URL. `absent` declares no console participant exists: drain evidence is accepted only while the node has no console work rows, in any state.' },

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
  { name: 'MAGNUS_ARDENT_HIVEMEM_URL', group: 'hivemem', description: 'HTTPS HiveMem base URL (before v1/) that issues per-agent credentials for Ardent New Agent and Enable HiveMem. Set together with an Oathweave client (MAGNUS_ARDENT_HIVEMEM_CLIENT_ID) or an enrollment token.' },
  { name: 'MAGNUS_ARDENT_HIVEMEM_AGENT_URL', group: 'hivemem', description: 'HiveMem base URL written into Ardent profile configs, when agents reach HiveMem at another address. Defaults to MAGNUS_ARDENT_HIVEMEM_URL.' },
  { name: 'MAGNUS_ARDENT_HIVEMEM_CLIENT_ID', group: 'hivemem', description: 'Oathweave machine client (audience hivemem) Magnus uses as its own HiveMem service identity to enroll Ardent agents and create their workspace. Set with the secret and token URL.' },
  { name: 'MAGNUS_ARDENT_HIVEMEM_CLIENT_SECRET', group: 'hivemem', secret: true, description: 'Secret of MAGNUS_ARDENT_HIVEMEM_CLIENT_ID. Never sent to nodes.' },
  { name: 'MAGNUS_ARDENT_HIVEMEM_TOKEN_URL', group: 'hivemem', description: 'HTTPS Oathweave token endpoint for the client_credentials grant, for example https://oathweave.example.com/api/v1/oauth/token.' },
  { name: 'MAGNUS_ARDENT_HIVEMEM_SCOPE', group: 'hivemem', default: 'hivemem:admin:agents hivemem:workspaces:write hivemem:memories:read hivemem:memories:write hivemem:sessions:read hivemem:sessions:write', description: 'Permissions Magnus requests for its HiveMem service token, separated by spaces.' },
  { name: 'MAGNUS_ARDENT_HIVEMEM_ENROLLMENT_TOKEN', group: 'hivemem', secret: true, description: 'Instead of an Oathweave client: a HiveMem token with admin:agents (and workspace admin) that enrolls and rotates Ardent agent credentials. Never sent to nodes.' },
  { name: 'MAGNUS_ARDENT_HIVEMEM_WORKSPACE_ID', group: 'hivemem', default: 'ardent-agents (Oathweave client only)', description: 'HiveMem workspace Ardent agents are enrolled into. Magnus creates it with an Oathweave client; with an enrollment token it must exist and is required.' },
  { name: 'MAGNUS_ARDENT_HIVEMEM_CREDENTIAL_HOURS', group: 'hivemem', default: '720', description: 'Lifetime of an Ardent agent HiveMem credential, 1 to 720 hours.' },
  { name: 'MAGNUS_ARDENT_EMBERPATH_URL', group: 'router', description: 'OpenAI-compatible Emberpath base URL that Ardent New Agent writes for an Emberpath model alias.' },
  { name: 'MAGNUS_ARDENT_HIVESKILLS_URL', group: 'plugins', description: 'HTTPS HiveSkills registry base URL that the Ardent skill-install action fetches catalog releases from and checks against their catalog digest. Unset: skill-install answers 503 HIVESKILLS_UNCONFIGURED.' },

  // ── Security Fusion / external security console ──
  { name: 'CINDERTRACE_RESPONSE_SECRET', group: 'security', description: 'Dedicated HMAC credential for the optional Cindertrace managed response bridge.' },
  { name: 'CINDERTRACE_RESTART_ALLOWLIST', group: 'security', description: 'Comma-separated allowlisted response service names; empty by default.' },
  { name: 'CINDERTRACE_PROTECTED_TARGET_IDS', group: 'security', description: 'Comma-separated node IDs that Cindertrace must never isolate.' },
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
  { name: 'MAGNUS_EMBERMEND_GRANTS_JSON', group: 'plugins', description: 'Endpoint-scoped Embermend token hashes, installation identities, application IDs and exact per-target action grants; no node credentials.' },
  { name: 'MAGNUS_HIVESKILLS_DEPLOYMENTS_JSON', group: 'plugins', description: 'Optional endpoint-scoped HiveSkills executor grants: registry ID -> tokenSha256 and exact target -> nodeId/agentTarget mapping; no administrator credentials.' },
  { name: 'MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON', group: 'plugins', requiredWhen: 'MAGNUS_PLUGIN_API_ENABLED=true', description: 'JSON object {consumerId: sha256(token)} of 1-16 read-only plugin credentials.' },
  { name: 'MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256', group: 'plugins', requiredWhen: 'MAGNUS_PLUGIN_API_ENABLED=true', description: 'SHA-256 digest of the server-local plugin operator credential.' },
  { name: 'MAGNUS_APPROVAL_BRIDGE_CONSUMER', group: 'plugins', description: 'Plugin read consumer allowed to list approval plans and relay signed decisions.' },
  { name: 'APPROVAL_SIGNER_PUBLIC_KEY_PEM', group: 'plugins', description: 'Ed25519 public key (PEM) that signs approval decisions. _B64 (DER) and _PATH variants are also accepted.' },
  { name: 'APPROVAL_TELEGRAM_ACTOR_SHA256', group: 'plugins', description: 'Actor binding digest for decisions from the Telegram channel.' },
  { name: 'APPROVAL_IPHONE_ACTOR_SHA256', group: 'plugins', description: 'Actor binding digest for decisions from the iPhone channel.' },
  { name: 'MAGNUS_APPROVAL_ASSERTION_DOMAINS', group: 'plugins', default: 'magnus.approval-assertion', description: 'Comma-separated signature domain prefixes accepted for approval decisions (signed message is <prefix>.v<N>). The first is preferred; add a legacy signer domain to keep older signers working.' },
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
  { name: 'MAGNUS_EMBERPATH_URL', group: 'ai', description: 'Opt-in Emberpath provider: OpenAI-compatible base URL including /v1 (HTTPS in production). Set with MAGNUS_EMBERPATH_API_KEY and MAGNUS_EMBERPATH_MODEL; the default hosted routes then try Emberpath before OpenRouter.' },
  { name: 'MAGNUS_EMBERPATH_API_KEY', group: 'ai', secret: true, requiredWhen: 'MAGNUS_EMBERPATH_URL set', description: 'Emberpath client API key (Bearer). Give the key actorId metadata so Emberpath attributes the assistant traffic.' },
  { name: 'MAGNUS_EMBERPATH_MODEL', group: 'ai', requiredWhen: 'MAGNUS_EMBERPATH_URL set', description: 'Emberpath model name or alias the default routes use.' },

  // ── Upgrades ── (every automatic behaviour has its own switch; set them false to run your own release process)
  { name: 'MAGNUS_AUTO_MIGRATE', group: 'upgrades', default: 'false', description: 'true: apply pending migrations at startup, before listening, under an advisory lock and after a pg_dump. `magnus init` projects and the container images set it to true.' },
  { name: 'MAGNUS_AUTO_MIGRATE_BACKUP', group: 'upgrades', default: 'true', description: 'Dump the database (pg_dump -Fc into MAGNUS_BACKUP_DIR) before an automatic migration. A failed dump stops startup. Set false only if you back up another way.' },
  { name: 'MAGNUS_AUTO_MIGRATE_ALLOW_SLOW', group: 'upgrades', default: 'false', description: 'Let auto-migrate apply migrations marked slow or one-way; otherwise startup stops and asks for `magnus upgrade`.' },
  { name: 'MAGNUS_BACKUP_DIR', group: 'upgrades', default: '$MAGNUS_HOME/backups', description: 'Directory for pre-migration database dumps (0700; dumps are 0600).' },
  { name: 'MAGNUS_BACKUP_KEEP', group: 'upgrades', default: '5', description: 'Dumps kept in MAGNUS_BACKUP_DIR after each new one; older ones are deleted, except the newest dump of each label (each upgrade step keeps the dump its rollback needs).' },
  { name: 'MAGNUS_AUTO_MIGRATE_LOCK_TIMEOUT', group: 'upgrades', default: '600', description: 'Seconds startup auto-migrate waits for another instance\'s migrate lock before it gives up and exits.' },
  { name: 'MAGNUS_MIGRATE_DATABASE_URL', group: 'upgrades', secret: true, description: 'Direct PostgreSQL connection for migrations, dumps and restores when DATABASE_URL goes through a pooler such as PgBouncer (advisory locks need a session). Defaults to DATABASE_URL.' },
  { name: 'MAGNUS_PG_DUMP', group: 'upgrades', default: 'pg_dump', description: 'pg_dump binary used for pre-migration backups. Its major version must be at least the server\'s.' },
  { name: 'MAGNUS_RUNTIME_FILE', group: 'upgrades', default: '$MAGNUS_HOME/run/server-runtime.json', description: 'File the server writes after it starts listening ({version, pid, port, host}); upgrade tooling reads it to confirm the new version is serving.' },
  { name: 'MAGNUS_UPDATE_CHECK', group: 'upgrades', default: 'true', description: 'Daily check of the npm registry for newer Magnus releases, shown in the console and `magnus-server check`. Sends no data beyond a registry GET. Set false to opt out.' },
  { name: 'MAGNUS_UPDATE_REGISTRY', group: 'upgrades', default: 'https://registry.npmjs.org', description: 'npm registry used by the update check.' },
  { name: 'MAGNUS_AGENT_UPGRADES', group: 'upgrades', default: 'true', description: 'Allow server-driven agent upgrades (console action, API and `magnus-server agents upgrade`). Agents must also allow it (MAGNUS_AGENT_SELF_UPGRADE).' },
  { name: 'MAGNUS_AGENT_UPGRADE_CONCURRENCY', group: 'upgrades', default: '5', description: 'Agents upgraded in parallel after the first (canary) agent confirms. Maximum 50.' },
  { name: 'MAGNUS_AGENT_UPGRADE_MAX_FAILURES', group: 'upgrades', default: '2', description: 'Failures pointing at the release (revert, failed install, trial that never confirms) that stop an agent upgrade run after its canary. Problems of one node never stop a run. A run can override it.' },
  { name: 'MAGNUS_LEGACY_GIT_SELF_UPDATE', group: 'upgrades', default: 'false', description: 'true: keep the retired git-checkout self-update endpoints (/api/v1/self-update/apply and /restart) for source installs. npm installs use `magnus upgrade`.' },
  { name: 'NODE_EXTRA_CA_CERTS', group: 'upgrades', description: 'Extra CA bundle (PEM) trusted when the server calls agents, for agent certificates from a private CA. Node reads it at process start: set it in the unit; `magnus-server agents` also honours it from --env-file.' },
  { name: 'MAGNUS_PROJECT_DIR', group: 'upgrades', description: 'Managed project created by `magnus init` (holds magnus-project.json). `magnus-server upgrade` finds it from the install path when unset.' },

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
