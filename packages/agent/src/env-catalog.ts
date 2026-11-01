import { AGENT_VERSION } from './version.js';

/**
 * Machine-readable description of the agent's install-time settings, printed by
 * `magnus-agent env-schema`. It covers the settings a fresh node needs and the
 * switches for optional executors; `.env.example` documents the same keys.
 */
export interface EnvVarSpec {
  name: string;
  required: boolean;
  secret: boolean;
  default?: string;
  /** For secrets a launcher should create: `hex32` is 32 random bytes as hex. */
  generate?: 'hex32';
  group: 'core' | 'tls' | 'discovery' | 'logging' | 'skills' | 'hermes' | 'codex' | 'ardent' | 'renewal' | 'runtime';
  description: string;
}

export interface EnvSchemaDocument {
  service: 'magnus-agent';
  package: string;
  version: string;
  defaultPort: number;
  pingPath: string;
  healthPath: string;
  env: EnvVarSpec[];
}

export const DEFAULT_PORT = 4100;

export const agentEnvCatalog: EnvVarSpec[] = [
  { name: 'CONTROL_API_URL', required: true, secret: false, group: 'core', description: 'Base URL of the magnus-server Control API this node enrolls with, for example https://magnus.example.com:4000.' },
  { name: 'NODE_MANAGER_SECRET', required: true, secret: true, generate: 'hex32', group: 'core', description: 'Shared node credential. Must equal the value the Control API holds for this node (at least 32 characters).' },
  { name: 'RESULT_SIGNING_SECRET', required: true, secret: true, generate: 'hex32', group: 'core', description: 'Dedicated command-result signing key (at least 32 characters). Never reuse NODE_MANAGER_SECRET.' },
  { name: 'NODE_MANAGER_SECRET_PREVIOUS', required: false, secret: true, group: 'core', description: 'Previous node credential, accepted only during a rotation window.' },
  { name: 'RESULT_SIGNING_PREVIOUS_SECRET', required: false, secret: true, group: 'core', description: 'Previous result-signing key, accepted only during a rotation window.' },
  { name: 'COMMAND_RECONCILIATION_SECRET', required: false, secret: true, generate: 'hex32', group: 'core', description: 'Independent key that authorizes explicit command-receipt reconciliation. Leave unset unless your control plane uses it.' },
  { name: 'HOST_FQDN', required: false, secret: false, default: 'hostname --fqdn', group: 'core', description: 'Host identity reported to the Control API.' },
  { name: 'NODE_MANAGER_PORT', required: false, secret: false, default: String(DEFAULT_PORT), group: 'core', description: 'Listener port.' },
  { name: 'NODE_MANAGER_BIND_HOST', required: false, secret: false, default: '0.0.0.0 (TLS) / 127.0.0.1 (HTTP)', group: 'core', description: 'Listener address.' },
  { name: 'ENABLE_NODE_MANAGEMENT', required: false, secret: false, default: 'true', group: 'core', description: 'Node management routes and heartbeat. Must stay true.' },
  { name: 'MAGNUS_AGENT_PRIVILEGED', required: false, secret: false, default: 'true', group: 'core', description: 'true: run as root with every executor (startup fails if not root). false: run as an ordinary account; cron, users, system updates, docker-group remediation, Ardent management, credential renewal and the execution supervisor are disabled and their routes return 403 AGENT_NOT_PRIVILEGED.' },
  { name: 'MAGNUS_AGENT_SELF_UPGRADE', required: false, secret: false, default: 'true', group: 'core', description: 'true: accept server-driven upgrades to an exact version and npm integrity, installed into versions/<X> and confirmed by the launcher (needs `magnus-agent install-service`). false: refuse them; upgrade by hand or by image.' },
  { name: 'MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS', required: false, secret: false, default: '180', group: 'core', description: 'Seconds a newly installed version has to report an accepted heartbeat before the launcher switches back to the previous one (10-3600).' },
  { name: 'MAGNUS_AGENT_UPGRADE_REQUIRE_PROVENANCE', required: false, secret: false, default: 'true', group: 'core', description: 'Run `npm audit signatures` on a staged upgrade and refuse it unless every package has valid registry signatures. Set false only for locally built tarballs.' },
  { name: 'MAGNUS_AGENT_UPGRADE_SOURCE_DIR', required: false, secret: false, group: 'core', description: 'Install self-upgrades from tarballs in this directory (hivemagnus-magnus-agent-<X>.tgz) instead of the npm registry, for offline nodes. The integrity check still applies.' },
  { name: 'MAGNUS_AGENT_NPM', required: false, secret: false, default: 'npm', group: 'core', description: 'npm executable used for self-upgrades.' },
  { name: 'MAGNUS_EXECUTION_SUPERVISOR_ENABLED', required: false, secret: false, default: 'false', group: 'core', description: 'Run commands under the durable execution supervisor.' },
  { name: 'CONTROL_API_CA_PATH', required: false, secret: false, group: 'tls', description: 'PEM CA bundle trusted for a private-CA Control API. Verification is never disabled.' },
  { name: 'TLS_CERT_PATH', required: false, secret: false, group: 'tls', description: 'Listener certificate (absolute or relative to AGENT_INSTALL_DIR). Required with TLS_KEY_PATH when NODE_ENV=production.' },
  { name: 'TLS_KEY_PATH', required: false, secret: false, group: 'tls', description: 'Listener private key for TLS_CERT_PATH.' },
  { name: 'ALLOW_INSECURE_HTTP', required: false, secret: false, default: 'false', group: 'tls', description: 'Development only: serve plain HTTP on loopback. Rejected in production.' },
  { name: 'MAGNUS_AGENT_TLS_RENEWAL', required: false, secret: false, group: 'tls', description: 'Set to "tailscale" to renew the listener certificate with `tailscale cert` before it expires.' },
  { name: 'ENABLE_AGENT_DISCOVERY', required: false, secret: false, default: 'false', group: 'discovery', description: 'Authenticated UDP discovery of the control node.' },
  { name: 'AGENT_DISCOVERY_SECRET', required: false, secret: true, generate: 'hex32', group: 'discovery', description: 'Dedicated discovery HMAC key. Required when discovery is enabled.' },
  { name: 'AGENT_DISCOVERY_BIND_ADDRESS', required: false, secret: false, group: 'discovery', description: 'Explicit IPv4 interface address for discovery (no wildcard).' },
  { name: 'ENABLE_LOG_FORWARDING', required: false, secret: false, default: 'false', group: 'logging', description: 'Forward journald lines for LOG_UNITS to the Control API.' },
  { name: 'LOG_INGEST_TOKEN', required: false, secret: true, generate: 'hex32', group: 'logging', description: 'Log ingest credential. Required when log forwarding is enabled.' },
  { name: 'LOG_UNITS', required: false, secret: false, group: 'logging', description: 'Comma-separated systemd units whose logs are forwarded.' },
  { name: 'OTEL_ENABLED', required: false, secret: false, default: 'true', group: 'logging', description: 'Set to false to disable trace export. Export runs only when OTEL_EXPORTER_OTLP_ENDPOINT is set.' },
  { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', required: false, secret: false, group: 'logging', description: 'OTLP/HTTP endpoint for traces.' },
  { name: 'SKILLS_DIR', required: false, secret: false, default: '/opt/magnus-agent/skills', group: 'skills', description: 'Primary directory for published skills.' },
  { name: 'SKILLS_EXTRA_DIRS', required: false, secret: false, group: 'skills', description: 'Additional colon-separated skill directories to inventory.' },
  { name: 'HERMES_USER', required: false, secret: false, group: 'hermes', description: 'Local account that owns Hermes Agent. Enables Hermes inspection and management.' },
  { name: 'HERMES_REGISTRY_TOKEN', required: false, secret: true, group: 'hermes', description: '64-hex token issued by the Control API for magnus-hermes-sync. Without it the sync job does nothing.' },
  { name: 'MAGNUS_HERMES_SYNC_PULL', required: false, secret: false, default: 'false', group: 'hermes', description: 'Allow magnus-hermes-sync to apply desired state from the registry (otherwise use --submit-only).' },
  { name: 'CODEX_USER', required: false, secret: false, group: 'codex', description: 'Local account whose Codex CLI and login are managed. Defaults to HERMES_USER, then the invoking user.' },
  { name: 'CODEX_BIN', required: false, secret: false, group: 'codex', description: 'Codex CLI path override.' },
  { name: 'CODEX_HOME', required: false, secret: false, default: '~/.codex', group: 'codex', description: 'Codex state directory override.' },
  { name: 'ARDENT_OWNER_USER', required: false, secret: false, group: 'ardent', description: 'Local account that owns the Ardent runtime and profiles.' },
  { name: 'ARDENT_STAGED_PACKAGE', required: false, secret: false, default: '/opt/magnus-agent/ardent-package.tgz', group: 'ardent', description: 'Verified Ardent package tarball staged for installation.' },
  { name: 'MAGNUS_AGENT_ARDENT_PACKAGES', required: false, secret: false, default: '@hivemagnus/ardent', group: 'ardent', description: 'Comma-separated scoped npm package names accepted as the Ardent runtime (staged sidecar, install path, receipt), in preference order. Add a legacy name to keep managing an older Ardent build.' },
  { name: 'MAGNUS_AGENT_RENEWAL_CONFIG', required: false, secret: false, default: '$AGENT_INSTALL_DIR/credential-renewal.json', group: 'renewal', description: 'HiveMem credential renewal entries (root-owned, mode 0600). Absent means renewal is off.' },
  { name: 'MAGNUS_AGENT_RENEWAL_ENDPOINTS', required: false, secret: false, group: 'renewal', description: 'Comma-separated HTTPS HiveMem base URLs renewal may call.' },
  { name: 'MAGNUS_AGENT_RENEWAL_UNITS', required: false, secret: false, group: 'renewal', description: 'Comma-separated systemd units renewal may try-restart after replacing a credential.' },
  { name: 'MAGNUS_AGENT_RENEWAL_USERS', required: false, secret: false, group: 'renewal', description: 'Comma-separated accounts whose ~/.hermes/.env or Ardent profile env files may be renewed.' },
  { name: 'MAGNUS_AGENT_RENEWAL_ARDENT_PROFILES', required: false, secret: false, group: 'renewal', description: 'Comma-separated Ardent profile names whose env files may be renewed.' },
  { name: 'MAGNUS_AGENT_RENEWAL_TOKEN_FILES', required: false, secret: false, group: 'renewal', description: 'Comma-separated absolute service env/token files renewal may rewrite.' },
  { name: 'MAGNUS_AGENT_RENEWAL_SIGNING_ENV_FILES', required: false, secret: false, group: 'renewal', description: 'Comma-separated absolute env files holding HIVEMEM_JWT_SECRET for local admin renewal.' },
  { name: 'MAGNUS_AGENT_DOCKER_USER', required: false, secret: false, default: 'agent process user', group: 'runtime', description: 'Account the heartbeat docker-group check verifies (and, when privileged, adds to the docker group).' },
  { name: 'MAGNUS_AGENT_WORKSPACE_ROOT', required: false, secret: false, default: '/var/lib/magnus-agent/workspaces', group: 'runtime', description: 'Base directory for workspace routes.' },
  { name: 'AGENT_INSTALL_DIR', required: false, secret: false, default: 'working directory', group: 'runtime', description: 'Installation directory holding .env and agent state.' },
  { name: 'NODE_ENV', required: false, secret: false, default: 'development', group: 'runtime', description: 'production requires TLS.' },
  { name: 'LOG_LEVEL', required: false, secret: false, default: 'info', group: 'runtime', description: 'debug, info, warn or error.' },
];

export function buildEnvSchemaDocument(): EnvSchemaDocument {
  return {
    service: 'magnus-agent',
    package: '@hivemagnus/magnus-agent',
    version: AGENT_VERSION,
    defaultPort: DEFAULT_PORT,
    pingPath: '/api/v1/ping',
    healthPath: '/api/v1/health/check',
    env: agentEnvCatalog,
  };
}
