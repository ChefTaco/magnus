import { requireSshExitStatus } from './ssh-exec-service.js';
import { withApiSshOwnership } from './managed-ssh-admission.js';
import { Client, type SFTPWrapper } from 'ssh2';
import { existsSync, unlinkSync, statSync } from 'node:fs';
import { resolve as pathResolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { CONTROL_API_VERSION } from '../config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DeployControlNodeOptions {
  /** Target hostname or IP */
  hostname: string;
  /** SSH port */
  sshPort?: number;
  /** SSH username */
  username: string;
  /** SSH password */
  password: string;
  /** Control API port on the target */
  controlApiPort?: number;
  /** Node Manager port (for agents managed by this control node) */
  nodeManagerPort?: number;
  /** Dedicated node-agent authentication secret (never reused for API/JWT). */
  nodeManagerSecret: string;
  /** Redis URL on the target */
  redisUrl?: string;
  /** Exact dashboard browser origin allowed by CORS */
  corsOrigin?: string;
}

export interface DeployControlNodeProgress {
  step: string;
  status: 'running' | 'done' | 'error';
  message: string;
}

/** Never provision a production control node with wildcard browser access. */
export function resolveControlNodeCorsOrigin(hostname: string, configured?: string): string {
  const candidate = configured?.trim();
  return candidate && candidate !== '*' ? candidate : `https://${hostname}`;
}

export interface ControlNodePurposeSecrets {
  apiSecret: string;
  jwtSecret: string;
  credentialRotationKey: string;
  auditHmacSecret: string;
  resultSigningSecret: string;
  logIngestSigningSecret: string;
}

/** Generate independent protocol keys; never derive one purpose from another. */
export function generateControlNodePurposeSecrets(): ControlNodePurposeSecrets {
  const generate = (): string => randomBytes(32).toString('base64url');
  return {
    apiSecret: generate(),
    jwtSecret: generate(),
    credentialRotationKey: generate(),
    auditHmacSecret: generate(),
    resultSigningSecret: generate(),
    logIngestSigningSecret: generate(),
  };
}

// ── Timeout wrapper ──────────────────────────────────────────────────────────
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${label} (${ms}ms)`)), ms);
    promise
      .then((v) => { clearTimeout(timer); resolve(v); })
      .catch((e: unknown) => { clearTimeout(timer); reject(e); });
  });
}

// ── Create deploy tarball ────────────────────────────────────────────────────
function createDeployTarball(): string {
  const repoRoot = pathResolve(__dirname, '../../');
  const tarballPath = pathResolve(repoRoot, '.magnus-deploy.tar.gz');

  execSync(
    `tar czf "${tarballPath}" ` +
    `--exclude='node_modules' ` +
    `--exclude='.git' ` +
    `--exclude='.next' ` +
    `--exclude='*.db' ` +
    `--exclude='*.db-journal' ` +
    `--exclude='audit-logs' ` +
    `--exclude='.magnus' ` +
    `--exclude='.magnus-deploy.tar.gz' ` +
    `--exclude='*.tsbuildinfo' ` +
    `--exclude='dist' ` +
    `-C "${repoRoot}" .`,
    { timeout: 120_000 },
  );

  return tarballPath;
}

// ── SSH connect (promise) ────────────────────────────────────────────────────
async function sshConnect(opts: {
  host: string; port: number; username: string; password: string;
}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('error', reject);
    conn.on('ready', () => resolve(conn));
    conn.connect({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      password: opts.password,
      readyTimeout: 30_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 6,
    });
  });
}

// ── Execute remote command (promise) ─────────────────────────────────────────
function sshExec(
  conn: Client,
  command: string,
  onStdout?: (line: string) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) { reject(err); return; }

      let stdout = '';
      let stderr = '';

      stream.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        if (onStdout) {
          for (const line of text.split('\n')) {
            if (line.trim()) onStdout(line);
          }
        }
      });

      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      // Closure without an exit-status frame leaves remote effects uncertain.
      stream.on('close', (code: number) => {
        try { resolve({ code: requireSshExitStatus(code), stdout, stderr }); } catch (error) { reject(error); }
      });

      stream.on('error', reject);
    });
  });
}

// ── Get SFTP session (promise) ───────────────────────────────────────────────
function sshSftp(conn: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) reject(err);
      else resolve(sftp);
    });
  });
}

// ── Upload file via sftp.fastPut (reliable, chunked) ─────────────────────────
function sftpUpload(sftp: SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, { concurrency: 4, chunkSize: 32768 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Deploy the Magnus Control API (Control Node) to a remote host via SSH.
 *
 * Strategy: Package the local monorepo as a tarball, upload via SFTP,
 * extract on target, install deps, build, and start as a systemd service.
 */
export async function deployControlNode(
  opts: DeployControlNodeOptions,
  onProgress?: (p: DeployControlNodeProgress) => void,
): Promise<{ success: boolean; message: string }> {
  return withApiSshOwnership(opts.hostname, 'control-deploy', async () => {
  const {
    hostname,
    sshPort = 22,
    username,
    password,
    controlApiPort = 4000,
    nodeManagerPort = 4100,
    nodeManagerSecret,
    redisUrl = 'redis://127.0.0.1:6379',
    corsOrigin: configuredCorsOrigin,
  } = opts;
  const corsOrigin = resolveControlNodeCorsOrigin(hostname, configuredCorsOrigin);
  if (nodeManagerSecret.length < 32) {
    throw new Error('nodeManagerSecret must be a dedicated secret of at least 32 characters');
  }
  const purposeSecrets = generateControlNodePurposeSecrets();

  const log = (step: string, status: DeployControlNodeProgress['status'], message: string): void => {
    onProgress?.({ step, status, message });
  };

  // ── Phase 0: Create tarball locally ──
  log('package', 'running', 'Packaging magnus-api...');
  let tarballPath: string;
  try {
    tarballPath = createDeployTarball();
    const stats = statSync(tarballPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
    log('package', 'done', `Tarball created (${sizeMB} MB)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('package', 'error', `Failed to create tarball: ${msg}`);
    return { success: false, message: `Failed to create deploy tarball: ${msg}` };
  }

  // Helper to clean up tarball
  const cleanup = (): void => {
    try { unlinkSync(tarballPath); } catch { /* ignore */ }
  };

  // Read TLS certs from local repo for embedding
  const tlsCertPath = process.env['TLS_CERT_PATH'];
  const tlsKeyPath = process.env['TLS_KEY_PATH'];
  const hasTls = !!(tlsCertPath && tlsKeyPath);

  // If TLS is configured locally, we'll generate a fresh cert for the target
  // hostname on the remote host (via openssl in the deploy script).
  // We no longer copy the local cert — it has SANs for the local machine only.
  let certContent = '';
  if (hasTls) {
    const repoRoot = pathResolve(__dirname, '../../');
    const resolvedCert = pathResolve(repoRoot, tlsCertPath);
    const resolvedKey = pathResolve(repoRoot, tlsKeyPath);
    // Check the local cert exists so we know TLS should be configured
    if (existsSync(resolvedCert) && existsSync(resolvedKey)) {
      certContent = 'GENERATE_ON_HOST';
    }
  }

  const magnusDir = '/opt/magnus-api';
  const escapedPassword = password.replace(/'/g, "'\\''");
  const postgresPassword = randomBytes(32).toString('hex');

  // Build .env for the remote control node
  const envLines = [
    `# Magnus Control Node - ${hostname}`,
    `# Deployed at ${new Date().toISOString()}`,
    '',
    '# PostgreSQL',
    `POSTGRES_PASSWORD=${postgresPassword}`,
    `DATABASE_URL="postgresql://magnus:${postgresPassword}@127.0.0.1:5432/magnus"`,
    `DATABASE_POOL_SIZE=20`,
    '',
    '# Redis',
    `REDIS_HOST=127.0.0.1`,
    `REDIS_PORT=6379`,
    `REDIS_URL="${redisUrl}"`,
    `REDIS_PREFIX=magnus-`,
    '',
    '# Control API',
    `CONTROL_API_PORT=${controlApiPort}`,
    `CONTROL_API_URL=https://${hostname}:${controlApiPort}`,
    `API_SECRET=${purposeSecrets.apiSecret}`,
    '',
    '# Node Manager',
    `NODE_MANAGER_PORT=${nodeManagerPort}`,
    `NODE_MANAGER_SECRET=${nodeManagerSecret}`,
    '',
    '# Auth',
    `JWT_SECRET=${purposeSecrets.jwtSecret}`,
    `CREDENTIAL_ROTATION_KEY=${purposeSecrets.credentialRotationKey}`,
    `AUDIT_HMAC_SECRET=${purposeSecrets.auditHmacSecret}`,
    `RESULT_SIGNING_SECRET=${purposeSecrets.resultSigningSecret}`,
    `LOG_INGEST_SIGNING_SECRET=${purposeSecrets.logIngestSigningSecret}`,
    `JWT_EXPIRY=24h`,
    '',
    '# CORS — exact dashboard browser origin',
    `CORS_ORIGIN=${corsOrigin}`,
    '',
    '# Logging',
    `LOG_LEVEL=info`,
    `NODE_ENV=production`,
    '',
    '# Deploy (SSH credentials for agent deploy/upgrade)',
    `SSH_USERNAME=${username}`,
    `SSH_PASSWORD=${password}`,
  ];

  if (hasTls && certContent) {
    envLines.push(
      '',
      '# TLS',
      `TLS_CERT_PATH=./certs/server.crt`,
      `TLS_KEY_PATH=./certs/server.key`,
      `CONTROL_API_CA_PATH=./certs/server.crt`,
      `CONTROL_API_TLS_SERVERNAME=${hostname}`,
      `CONTROL_HOST_AGENT_TLS_SERVERNAME=${hostname}`,
    );
  }

  const envContent = envLines.join('\n');

  const serviceContent = [
    '[Unit]',
    'Description=Magnus Control API (Control Node)',
    'After=network.target docker.service redis-server.service',
    'Wants=docker.service redis-server.service',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${magnusDir}`,
    `EnvironmentFile=${magnusDir}/.env`,
    `ExecStart=/usr/bin/node ${magnusDir}/dist/index.js`,
    'Restart=always',
    'RestartSec=5',
    'UMask=0077',
    'StandardOutput=journal',
    'StandardError=journal',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n');

  // Remote deploy script — runs AFTER tarball is uploaded
  const script = `
set -e
export SUDO_ASKPASS=/bin/false

do_sudo() {
  local tmpfile
  tmpfile=$(mktemp)
  echo '${escapedPassword}' | sudo -S env "PATH=$PATH" "$@" > "$tmpfile" 2>&1
  local rc=$?
  grep -v '\\[sudo\\] password' "$tmpfile" || true
  rm -f "$tmpfile"
  return $rc
}

echo ">>> Phase 1: Installing prerequisites"

echo ">>> Checking for Node.js"
if ! command -v node &>/dev/null || ! command -v npm &>/dev/null; then
  echo ">>> Installing Node.js via NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
  do_sudo bash /tmp/nodesource_setup.sh
  rm -f /tmp/nodesource_setup.sh
  do_sudo apt-get install -y nodejs
fi
hash -r
echo ">>> Node.js: $(node --version)"

echo ">>> Checking for Redis"
if ! command -v redis-server &>/dev/null; then
  echo ">>> Installing Redis"
  do_sudo apt-get update -y
  do_sudo apt-get install -y redis-server
  do_sudo systemctl enable redis-server
  do_sudo systemctl start redis-server
fi
echo ">>> Redis: $(redis-server --version 2>/dev/null | head -c 50)"

echo ">>> Checking for Docker Compose"
if ! command -v docker &>/dev/null || ! do_sudo docker compose version &>/dev/null; then
  echo ">>> Installing Docker and Compose"
  do_sudo apt-get update -y
  do_sudo apt-get install -y docker.io docker-compose-v2
  do_sudo systemctl enable --now docker
fi

echo ">>> Phase 2: Extracting Magnus package"
cd ${magnusDir}
tar xzf /tmp/magnus-deploy.tar.gz --strip-components=0
rm -f /tmp/magnus-deploy.tar.gz

echo ">>> Phase 3: Installing dependencies"
npm ci

echo ">>> Phase 4: Writing environment config"
cat > .env << 'ENVFILE'
${envContent}
ENVFILE
chmod 600 .env

${hasTls && certContent ? `
echo ">>> Generating TLS certificates for ${hostname}"
mkdir -p certs
# Resolve IP address for SANs
HOST_IP=$(getent hosts ${hostname} 2>/dev/null | awk '{print $1}' || echo "")
SAN_ENTRIES="DNS:localhost,DNS:${hostname}"
if [ -n "$HOST_IP" ]; then
  SAN_ENTRIES="$SAN_ENTRIES,IP:127.0.0.1,IP:$HOST_IP"
else
  SAN_ENTRIES="$SAN_ENTRIES,IP:127.0.0.1"
fi
# Add wildcard for domain if hostname has a subdomain
DOMAIN=$(echo "${hostname}" | sed 's/^[^.]*\\.//')
if [ -n "$DOMAIN" ] && [ "$DOMAIN" != "${hostname}" ]; then
  SAN_ENTRIES="$SAN_ENTRIES,DNS:*.$DOMAIN"
fi
echo ">>> SAN entries: $SAN_ENTRIES"
openssl req -x509 -newkey rsa:2048 \\
  -keyout certs/server.key -out certs/server.crt \\
  -days 3650 -nodes \\
  -subj '/CN=Magnus Control Plane' \\
  -addext "subjectAltName=$SAN_ENTRIES"
chmod 600 certs/server.key
chmod 644 certs/server.crt
echo ">>> TLS cert generated with SANs: $SAN_ENTRIES"
` : ''}

echo ">>> Phase 5: Building"
find . -name '*.tsbuildinfo' -delete 2>/dev/null || true
rm -rf dist
npm run db:generate
npm run build

echo ">>> Phase 6: Starting PostgreSQL and running database migrations"
do_sudo docker compose --env-file .env -f docker-compose.postgres.yml up -d --wait --wait-timeout 120
set -a
. ./.env
set +a
npm run db:migrate:deploy

echo ">>> Phase 7: Installing systemd service"
do_sudo bash -c 'cat > /etc/systemd/system/magnus-control-api.service << SVCFILE
${serviceContent}
SVCFILE'

do_sudo systemctl daemon-reload
do_sudo systemctl enable magnus-control-api

echo ">>> Stopping existing service (if running)"
do_sudo systemctl stop magnus-control-api 2>/dev/null || true

echo ">>> Starting Magnus Control API"
do_sudo systemctl start magnus-control-api

echo ">>> Waiting for service to start..."
sleep 5

if do_sudo systemctl is-active --quiet magnus-control-api; then
  echo ">>> SUCCESS: Magnus Control API is running on port ${controlApiPort}"
else
  echo ">>> WARNING: Service may still be starting. Check: journalctl -u magnus-control-api -f"
  do_sudo journalctl -u magnus-control-api --no-pager -n 20 || true
fi

echo ">>> Deploy complete — Control Node version: ${CONTROL_API_VERSION}"
`;

  // ── Async deploy flow (flat, no callback pyramid) ─────────────────────────
  let conn: Client | null = null;

  try {
    // Phase 1: SSH connect
    log('connect', 'running', `Connecting to ${hostname}:${sshPort}...`);
    conn = await withTimeout(
      sshConnect({ host: hostname, port: sshPort, username, password }),
      30_000,
      'SSH connect',
    );
    log('connect', 'done', `Connected to ${hostname}`);

    // Phase 2: Create target directory
    log('upload', 'running', 'Preparing target directory...');
    const mkdirResult = await withTimeout(
      sshExec(conn, `echo '${escapedPassword}' | sudo -S mkdir -p ${magnusDir} && echo '${escapedPassword}' | sudo -S chown $USER:$USER ${magnusDir} && echo MKDIR_OK`),
      30_000,
      'mkdir',
    );
    if (mkdirResult.code !== 0 || !mkdirResult.stdout.includes('MKDIR_OK')) {
      throw new Error(`Failed to create ${magnusDir}: ${mkdirResult.stderr || mkdirResult.stdout}`);
    }

    // Phase 3: Upload tarball via SFTP (using fastPut — reliable chunked transfer)
    log('upload', 'running', 'Uploading Magnus package via SFTP...');
    const sftp = await withTimeout(sshSftp(conn), 15_000, 'SFTP session');

    await withTimeout(
      sftpUpload(sftp, tarballPath, '/tmp/magnus-deploy.tar.gz'),
      300_000, // 5 min for upload
      'SFTP upload',
    );
    sftp.end();
    log('upload', 'done', 'Package uploaded successfully');

    // Phase 4: Run deploy script
    log('deploy', 'running', 'Executing deploy script (this may take several minutes)...');

    const deployResult = await withTimeout(
      sshExec(conn, script, (line) => {
        if (line.startsWith('>>>')) {
          log('deploy', 'running', line.replace('>>> ', ''));
        }
      }),
      600_000, // 10 min for full deploy
      'deploy script',
    );

    conn.end();
    conn = null;
    cleanup();

    if (deployResult.code === 0) {
      log('deploy', 'done', 'Control Node deployed successfully');
      return { success: true, message: deployResult.stdout };
    } else {
      log('deploy', 'error', `Deploy failed (exit code ${deployResult.code})`);
      return {
        success: false,
        message: `Deploy failed (exit ${deployResult.code}):\n${deployResult.stderr || deployResult.stdout}`,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('deploy', 'error', msg);
    cleanup();
    if (conn) { try { conn.end(); } catch { /* ignore */ } }
    return { success: false, message: msg };
  }
  });
}
