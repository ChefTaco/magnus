import { requireSshExitStatus } from './ssh-exec-service.js';
import { withApiSshOwnership } from './managed-ssh-admission.js';
import { Client, type SFTPWrapper } from 'ssh2';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve as pathResolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const AGENT_PKG = '@hivemagnus/magnus-agent';
const REMOTE_INSTALL_DIR = '/opt/magnus-agent';
const SERVICE_NAME = 'magnus-agent';
const LOCAL_AGENT_PACKAGE_DIR = 'agent-package';
const REMOTE_AGENT_TARBALL = '/tmp/magnus-agent-local.tgz';

export interface DeployOptions {
  hostname: string;
  port?: number;
  username: string;
  password: string;
  privateKey?: string;
  controlApiUrl: string;
  nodeManagerSecret: string;
  nodeManagerPort?: number;
}

export interface DeployProgress {
  step: string;
  status: 'running' | 'done' | 'error';
  message: string;
}

export interface UpgradeOptions {
  hostname: string;
  port?: number;
  username: string;
  password: string;
  privateKey?: string;
  controlApiUrl: string;
  nodeManagerSecret: string;
  nodeManagerPort?: number;
}

/** Execute a command over an open SSH connection and collect stdout+stderr. */
function execRemote(
  conn: Client,
  cmd: string,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      let stdout = '';
      stream.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      stream.stderr.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      stream.on('close', (code: number) => {
        try { resolve({ code: requireSshExitStatus(code), stdout }); } catch (error) { reject(error); }
      });
      stream.on('error', reject);
    });
  });
}

function escapeForSingleQuotes(value: string): string {
  return value.replace(/'/g, "'\\''");
}

interface BuildAgentDeployScriptOptions {
  hostname: string;
  password: string;
  username: string;
  controlApiUrl: string;
  nodeManagerSecret: string;
  nodeManagerPort: number;
  deployedAtIso: string;
  certContent?: string;
  keyContent?: string;
}

export function buildAgentDeployScript(options: BuildAgentDeployScriptOptions): string {
  const {
    hostname,
    password,
    username,
    controlApiUrl,
    nodeManagerSecret,
    nodeManagerPort,
    deployedAtIso,
    certContent = '',
    keyContent = '',
  } = options;

  const hasTls = Boolean(certContent && keyContent);
  const envLines = [
    `# Magnus Agent — ${controlApiUrl}`,
    `# Deployed by Control API on ${deployedAtIso}`,
    '',
    '# ── Fleet Management ──',
    'ENABLE_NODE_MANAGEMENT=true',
    `CONTROL_API_URL=${controlApiUrl}`,
    `NODE_MANAGER_PORT=${nodeManagerPort}`,
    `NODE_MANAGER_SECRET=${nodeManagerSecret}`,
    `HERMES_USER=${username}`,
    `AGENT_INSTALL_DIR=${REMOTE_INSTALL_DIR}`,
    'NODE_ENV=production',
    'LOG_LEVEL=info',
  ];

  if (hasTls) {
    envLines.push(
      '',
      '# ── TLS ──',
      `TLS_CERT_PATH=${REMOTE_INSTALL_DIR}/certs/server.crt`,
      `TLS_KEY_PATH=${REMOTE_INSTALL_DIR}/certs/server.key`,
    );
  }

  const envContent = envLines.join('\n');
  const serviceContent = [
    '[Unit]',
    'Description=Magnus Agent',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${REMOTE_INSTALL_DIR}`,
    `EnvironmentFile=${REMOTE_INSTALL_DIR}/.env`,
    `ExecStart=/usr/bin/node ${REMOTE_INSTALL_DIR}/node_modules/${AGENT_PKG}/dist/index.js`,
    'Restart=always',
    'RestartSec=5',
    'StandardOutput=journal',
    'StandardError=journal',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n');

  const certBlock = hasTls
    ? `
echo ">>> Deploying TLS certificates"
mkdir -p ${REMOTE_INSTALL_DIR}/certs
cat > ${REMOTE_INSTALL_DIR}/certs/server.crt << 'CERT_EOF'
${certContent}
CERT_EOF
cat > ${REMOTE_INSTALL_DIR}/certs/server.key << 'KEY_EOF'
${keyContent}
KEY_EOF
chmod 600 ${REMOTE_INSTALL_DIR}/certs/server.key
chmod 644 ${REMOTE_INSTALL_DIR}/certs/server.crt
`
    : '';

  return `
set -e

# Store the sudo password in a temp file readable only by this user,
# then pipe from the file — avoids exposing it in /proc/*/cmdline via echo
__sudo_pw_file=$(mktemp)
chmod 600 "$__sudo_pw_file"
printf '%s\\n' '${escapeForSingleQuotes(password)}' > "$__sudo_pw_file"

do_sudo() {
  local tmpfile
  tmpfile=$(mktemp)
  if [ -s "$__sudo_pw_file" ]; then
    cat "$__sudo_pw_file" | sudo -S env "PATH=$PATH" "$@" > "$tmpfile" 2>&1
  else
    sudo -n env "PATH=$PATH" "$@" > "$tmpfile" 2>&1
  fi
  local rc=$?
  grep -v '\\[sudo\\] password' "$tmpfile" || true
  rm -f "$tmpfile"
  return $rc
}

echo ">>> Checking for Node.js 22"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "\${NODE_MAJOR:-0}" -lt 22 ] || ! command -v npm &>/dev/null; then
  echo ">>> Installing Node.js 22 via NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
  do_sudo bash /tmp/nodesource_setup.sh
  rm -f /tmp/nodesource_setup.sh
  do_sudo apt-get install -y nodejs
fi
hash -r
echo ">>> Node.js: $(node --version), npm: $(npm --version)"

echo ">>> Setting up agent directory"
do_sudo mkdir -p ${REMOTE_INSTALL_DIR}
do_sudo chown -R $USER:$USER ${REMOTE_INSTALL_DIR}
cd ${REMOTE_INSTALL_DIR}

echo ">>> Removing registry credentials"
rm -f .npmrc

echo ">>> Initializing package.json"
if [ ! -f package.json ]; then
  cat > package.json << 'PKGJSON'
{
  "name": "magnus-agent-host",
  "version": "1.0.0",
  "private": true,
  "type": "module"
}
PKGJSON
fi

echo ">>> Installing local ${AGENT_PKG} package"
npm install ${REMOTE_AGENT_TARBALL} 2>&1
rm -f ${REMOTE_AGENT_TARBALL}

INSTALLED_VER=$(node -e "console.log(JSON.parse(require('fs').readFileSync('node_modules/${AGENT_PKG}/package.json','utf8')).version)" 2>/dev/null || echo "unknown")
echo ">>> Installed ${AGENT_PKG}@\${INSTALLED_VER}"

echo ">>> Writing .env"
cat > ${REMOTE_INSTALL_DIR}/.env << 'ENVEOF'
${envContent}
ENVEOF
chmod 600 ${REMOTE_INSTALL_DIR}/.env
${certBlock}
echo ">>> Preparing systemd unit"
do_sudo systemctl unmask ${SERVICE_NAME} || true
do_sudo rm -f /etc/systemd/system/${SERVICE_NAME}.service || true

echo ">>> Writing systemd unit"
do_sudo bash -c "cat > /etc/systemd/system/${SERVICE_NAME}.service << 'SVCEOF'
${serviceContent}
SVCEOF"

echo ">>> Enabling and starting service"
do_sudo systemctl daemon-reload
do_sudo systemctl enable ${SERVICE_NAME}
if do_sudo systemctl list-unit-files ${SERVICE_NAME}-update.timer --no-pager 2>/dev/null | grep -q ${SERVICE_NAME}-update.timer; then
  echo ">>> Disabling registry auto-update timer"
  do_sudo systemctl disable --now ${SERVICE_NAME}-update.timer || true
fi
do_sudo systemctl restart ${SERVICE_NAME}

echo ">>> Verifying service"
HEALTH_OK=false
for i in $(seq 1 12); do
  sleep 5
  if ! do_sudo systemctl is-active ${SERVICE_NAME} >/dev/null 2>&1; then
    echo ">>> Service not active on attempt $i/12 — waiting..."
    continue
  fi

  if { [ -f ${REMOTE_INSTALL_DIR}/certs/server.crt ] && \
       curl --fail --silent --show-error --cacert ${REMOTE_INSTALL_DIR}/certs/server.crt \
         --resolve '${hostname}:${nodeManagerPort}:127.0.0.1' \
         'https://${hostname}:${nodeManagerPort}/api/v1/ping' >/dev/null 2>&1; } || \
     curl --fail --silent --show-error --max-time 3 \
       http://127.0.0.1:${nodeManagerPort}/api/v1/ping >/dev/null 2>&1; then
    HEALTH_OK=true
    break
  fi

  echo ">>> Health endpoint not ready on attempt $i/12 — waiting..."
done

if [ "$HEALTH_OK" != true ]; then
  echo ">>> HEALTH CHECK FAILED — agent did not start successfully"
  echo ">>> Recent logs:"
  do_sudo journalctl -u ${SERVICE_NAME} -n 20 --no-pager 2>/dev/null || true
  rm -f "$__sudo_pw_file"
  exit 1
fi

rm -f "$__sudo_pw_file"

echo ">>> Deploy complete"
`;
}

function sftpUpload(sftp: SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, { concurrency: 4, chunkSize: 32768 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function uploadFile(conn: Client, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) {
        reject(err);
        return;
      }
      sftpUpload(sftp, localPath, remotePath)
        .then(resolve, reject)
        .finally(() => sftp.end());
    });
  });
}

function findLocalAgentPackage(): string {
  const repoRoot = pathResolve(__dirname, '../../');
  const packageDir = pathResolve(repoRoot, LOCAL_AGENT_PACKAGE_DIR);

  if (!existsSync(packageDir)) {
    throw new Error(`Local agent package directory not found: ${packageDir}`);
  }

  const candidates = readdirSync(packageDir)
    .filter((name) => name.endsWith('.tgz'))
    .sort()
    .reverse();
  const newest = candidates[0];
  if (!newest) {
    throw new Error(`No local agent package tarball found in ${packageDir}`);
  }

  return pathResolve(packageDir, newest);
}

/**
 * Deploy the Magnus node-manager agent to a remote host via SSH.
 *
 * Uses the local workspace package tarball bundled with the Control API deploy.
 *
 * Steps:
 * 1. Connect via SSH
 * 2. Install Node.js 22 via NodeSource if not present
 * 3. Upload the bundled @hivemagnus/magnus-agent tarball
 * 4. npm install /tmp/magnus-agent-local.tgz
 * 5. Write .env config
 * 6. Copy TLS certs if applicable
 * 7. Create systemd service + auto-update timer & start it
 */
export async function deployNodeAgent(
  opts: DeployOptions,
  onProgress?: (p: DeployProgress) => void,
): Promise<{ success: boolean; message: string }> {
  const {
    hostname,
    port = 22,
    username,
    password,
    privateKey,
    controlApiUrl,
    nodeManagerSecret,
    nodeManagerPort = 4100,
  } = opts;

  const log = (step: string, status: DeployProgress['status'], message: string): void => {
    onProgress?.({ step, status, message });
  };

  let localAgentPackage: string;
  try {
    localAgentPackage = findLocalAgentPackage();
  } catch (err: unknown) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  return withApiSshOwnership(hostname, 'agent-deploy', () => new Promise((resolve) => {
    const conn = new Client();

    conn.on('error', (err) => {
      log('connect', 'error', `SSH connection failed: ${err.message}`);
      resolve({ success: false, message: `SSH connection failed: ${err.message}` });
    });

    conn.on('ready', () => {
      log('connect', 'done', `Connected to ${hostname}`);

      const tlsCertPath = process.env['TLS_CERT_PATH'];
      const tlsKeyPath = process.env['TLS_KEY_PATH'];
      const hasTls = !!(tlsCertPath && tlsKeyPath);

      let certContent = '';
      let keyContent = '';
      if (hasTls && tlsCertPath && tlsKeyPath) {
        const repoRoot = pathResolve(__dirname, '../../');
        const resolvedCert = pathResolve(repoRoot, tlsCertPath);
        const resolvedKey = pathResolve(repoRoot, tlsKeyPath);
        if (existsSync(resolvedCert) && existsSync(resolvedKey)) {
          certContent = readFileSync(resolvedCert, 'utf-8');
          keyContent = readFileSync(resolvedKey, 'utf-8');
        }
      }
      const deployScript = buildAgentDeployScript({
        hostname,
        password,
        username,
        controlApiUrl,
        nodeManagerSecret,
        nodeManagerPort,
        deployedAtIso: new Date().toISOString(),
        certContent: hasTls ? certContent : '',
        keyContent: hasTls ? keyContent : '',
      });

      void (async () => {
        try {
          log('upload', 'running', `Uploading ${basename(localAgentPackage)}...`);
          await uploadFile(conn, localAgentPackage, REMOTE_AGENT_TARBALL);
          log('upload', 'done', `Uploaded ${basename(localAgentPackage)}`);
          log('install', 'running', 'Running deploy script...');
          const result = await execRemote(conn, deployScript);
          if (result.code !== 0) {
            log('install', 'error', `Deploy failed (exit ${result.code}): ${result.stdout.slice(-500)}`);
            resolve({ success: false, message: result.stdout.slice(-500) });
          } else {
            log('install', 'done', 'Agent deployed successfully');
            resolve({ success: true, message: 'Deploy complete' });
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log('install', 'error', message);
          resolve({ success: false, message });
        } finally {
          conn.end();
        }
      })();
    });

    conn.connect({ host: hostname, port, username, ...(privateKey ? { privateKey } : { password }), readyTimeout: 30_000 });
  }));
}

/**
 * Upgrade the Magnus agent on a remote host via SSH using the bundled package.
 *
 * Uses the local workspace package tarball bundled with the Control API deploy.
 *
 * Steps:
 * 1. Connect via SSH
 * 2. Migrate ocd-agent directory/service → magnus-agent if needed
 * 3. Stop the agent service
 * 4. npm install /tmp/magnus-agent-local.tgz
 * 5. Update .env fields
 * 6. Restart magnus-agent service
 */
export async function upgradeNodeAgent(
  opts: UpgradeOptions,
  onProgress?: (p: DeployProgress) => void,
): Promise<{ success: boolean; message: string; installedVersion?: string }> {
  const {
    hostname,
    port = 22,
    username,
    password,
    privateKey,
    controlApiUrl,
    nodeManagerSecret,
    nodeManagerPort = 4100,
  } = opts;

  const esc = (s: string): string => s.replace(/'/g, "'\\''");

  const log = (step: string, status: DeployProgress['status'], message: string): void => {
    onProgress?.({ step, status, message });
  };

  let localAgentPackage: string;
  try {
    localAgentPackage = findLocalAgentPackage();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log('upgrade', 'error', message);
    return { success: false, message };
  }

  return withApiSshOwnership(hostname, 'agent-upgrade', () => new Promise((resolve) => {
    const conn = new Client();

    conn.on('error', (err) => {
      log('connect', 'error', `SSH connection failed: ${err.message}`);
      resolve({ success: false, message: `SSH connection failed: ${err.message}` });
    });

    conn.on('ready', () => {
      log('connect', 'done', `Connected to ${hostname}`);

      const upgradeScript = `
set -e

# Store the sudo password in a temp file readable only by this user
__sudo_pw_file=$(mktemp)
chmod 600 "$__sudo_pw_file"
printf '%s\\n' '${esc(password)}' > "$__sudo_pw_file"

do_sudo() {
  local tmpfile
  tmpfile=$(mktemp)
  cat "$__sudo_pw_file" | sudo -S env "PATH=$PATH" "$@" > "$tmpfile" 2>&1
  local rc=$?
  grep -v '\\\\[sudo\\\\] password' "$tmpfile" || true
  rm -f "$tmpfile"
  return $rc
}

# ── Migrate ocd-agent → magnus-agent if needed ──
OLD_DIR="/opt/ocd-agent"
if [ -d "$OLD_DIR" ] && [ ! -d "${REMOTE_INSTALL_DIR}" ]; then
  echo ">>> Migrating legacy ocd-agent to magnus-agent"
  do_sudo mv "$OLD_DIR" "${REMOTE_INSTALL_DIR}"
elif [ -d "$OLD_DIR" ]; then
  echo ">>> Removing legacy ocd-agent directory"
  do_sudo rm -rf "$OLD_DIR"
fi

# ── Migrate systemd service if needed ──
if do_sudo systemctl list-unit-files ocd-agent.service --no-pager 2>/dev/null | grep -q ocd-agent; then
  do_sudo systemctl stop ocd-agent || true
  do_sudo systemctl disable ocd-agent || true
  if [ -f /etc/systemd/system/ocd-agent.service ]; then
    do_sudo rm -f /etc/systemd/system/ocd-agent.service
    do_sudo systemctl daemon-reload
  fi
fi

echo ">>> Stopping agent service"
do_sudo systemctl stop ${SERVICE_NAME} 2>/dev/null || true

echo ">>> Setting up agent directory"
do_sudo mkdir -p ${REMOTE_INSTALL_DIR}
do_sudo chown -R $USER:$USER ${REMOTE_INSTALL_DIR}
cd ${REMOTE_INSTALL_DIR}

echo ">>> Removing registry credentials"
rm -f .npmrc

# ── Ensure package.json exists ──
if [ ! -f package.json ]; then
  echo ">>> Initializing package.json"
  cat > package.json << 'PKGJSON'
{
  "name": "magnus-agent-host",
  "version": "1.0.0",
  "private": true,
  "type": "module"
}
PKGJSON
fi

# ── Clean up old git-based install if present ──
if [ -d .git ]; then
  echo ">>> Removing old git repo (migrating to packaged install)"
  rm -rf .git src dist tsconfig.json vitest.config.ts CHANGELOG.md
fi

echo ">>> Installing local ${AGENT_PKG} package"
npm install ${REMOTE_AGENT_TARBALL} 2>&1
rm -f ${REMOTE_AGENT_TARBALL}

INSTALLED_VER=$(node -e "console.log(JSON.parse(require('fs').readFileSync('node_modules/${AGENT_PKG}/package.json','utf8')).version)" 2>/dev/null || echo "unknown")
echo ">>> Installed ${AGENT_PKG}@\${INSTALLED_VER}"

echo ">>> Updating .env"
update_env() {
  local key=\$1
  local val=\$2
  if grep -q "^\$key=" .env 2>/dev/null; then
    sed -i "s|^\$key=.*|\$key=\$val|" .env
  else
    printf '%s=%s\\\\n' "\$key" "\$val" >> .env
  fi
}
update_env CONTROL_API_URL "${controlApiUrl}"
update_env NODE_MANAGER_SECRET "${nodeManagerSecret}"
update_env NODE_MANAGER_PORT "${nodeManagerPort}"
update_env HERMES_USER "${username}"
update_env AGENT_INSTALL_DIR "${REMOTE_INSTALL_DIR}"

# ── Ensure systemd service points to npm package ──
echo ">>> Writing systemd service"
do_sudo bash -c "cat > /etc/systemd/system/${SERVICE_NAME}.service << 'SVCEOF'
[Unit]
Description=Magnus Agent
After=network.target

[Service]
Type=simple
WorkingDirectory=${REMOTE_INSTALL_DIR}
EnvironmentFile=${REMOTE_INSTALL_DIR}/.env
ExecStart=/usr/bin/node ${REMOTE_INSTALL_DIR}/node_modules/${AGENT_PKG}/dist/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF"

echo ">>> Starting agent service"
do_sudo systemctl daemon-reload
if do_sudo systemctl list-unit-files ${SERVICE_NAME}-update.timer --no-pager 2>/dev/null | grep -q ${SERVICE_NAME}-update.timer; then
  echo ">>> Disabling registry auto-update timer"
  do_sudo systemctl disable --now ${SERVICE_NAME}-update.timer || true
fi
do_sudo systemctl restart ${SERVICE_NAME}

echo ">>> Health check — verifying agent starts and heartbeats"
HEALTH_OK=false
for i in $(seq 1 9); do
  sleep 5
  if do_sudo systemctl is-active ${SERVICE_NAME} >/dev/null 2>&1; then
    # Check if the agent's HTTP server is responding
    if { [ -f ${REMOTE_INSTALL_DIR}/certs/server.crt ] && \
         curl --fail --silent --show-error --cacert ${REMOTE_INSTALL_DIR}/certs/server.crt \
           --resolve '${hostname}:${nodeManagerPort}:127.0.0.1' \
           'https://${hostname}:${nodeManagerPort}/api/v1/ping' >/dev/null 2>&1; } || \
       curl --fail --silent --show-error --max-time 3 \
         http://127.0.0.1:${nodeManagerPort}/api/v1/ping >/dev/null 2>&1; then
      HEALTH_OK=true
      break
    fi
    # Also accept if service is active for at least 15 seconds without crashing
    if [ "$i" -ge 3 ] && do_sudo systemctl is-active ${SERVICE_NAME} >/dev/null 2>&1; then
      HEALTH_OK=true
      break
    fi
  else
    echo ">>> Service not active on attempt $i/9 — waiting..."
  fi
done

if [ "$HEALTH_OK" = true ]; then
  echo ">>> Agent is healthy"
else
  echo ">>> HEALTH CHECK FAILED — agent did not start successfully"
  echo ">>> Recent logs:"
  do_sudo journalctl -u ${SERVICE_NAME} -n 20 --no-pager 2>/dev/null || true
  # Clean up password file (still exit with error)
  rm -f "$__sudo_pw_file"
  exit 1
fi

# Clean up password file
rm -f "$__sudo_pw_file"

echo "INSTALLED_VERSION=\${INSTALLED_VER}"
echo ">>> Upgrade complete"
`;

      void (async () => {
        try {
          log('upload', 'running', `Uploading ${basename(localAgentPackage)}...`);
          await uploadFile(conn, localAgentPackage, REMOTE_AGENT_TARBALL);
          log('upload', 'done', `Uploaded ${basename(localAgentPackage)}`);
          log('upgrade', 'running', 'Running upgrade script...');
          const result = await execRemote(conn, upgradeScript);
          if (result.code !== 0) {
            log('upgrade', 'error', `Upgrade failed (exit ${result.code}): ${result.stdout.slice(-500)}`);
            resolve({ success: false, message: result.stdout.slice(-500) });
          } else {
            // Extract installed version from script output
            const versionMatch = result.stdout.match(/INSTALLED_VERSION=(\S+)/);
            const installedVersion = versionMatch?.[1] ?? undefined;
            log('upgrade', 'done', `Agent upgraded successfully${installedVersion ? ` to v${installedVersion}` : ''}`);
            resolve({ success: true, message: 'Upgrade complete', installedVersion });
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log('upgrade', 'error', message);
          resolve({ success: false, message });
        } finally {
          conn.end();
        }
      })();
    });

    conn.connect({ host: hostname, port, username, ...(privateKey ? { privateKey } : { password }), readyTimeout: 30_000 });
  }));
}

// ─── Batch Deploy / Upgrade ────────────────────────────────────────────────

export interface BatchDeployTarget {
  hostname: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  controlApiUrl: string;
  nodeManagerSecret: string;
  nodeManagerPort?: number;
}

export interface BatchDeployResult {
  hostname: string;
  success: boolean;
  message: string;
  installedVersion?: string;
}

/**
 * Deploy/upgrade agents to multiple hosts in parallel with a concurrency limit.
 * Uses a semaphore pattern to limit concurrent SSH sessions.
 */
export async function batchDeployAgents(
  targets: BatchDeployTarget[],
  opts: { concurrency?: number; type?: 'deploy' | 'upgrade'; canaryPercent?: number; healthCheckWaitMs?: number; atomic?: boolean } = {},
): Promise<BatchDeployResult[]> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 5, 20));
  const type = opts.type ?? 'deploy';

  // ── Atomic mode: deploy sequentially, halt on first failure ──
  if (opts.atomic) {
    return runAtomicDeploy(targets, type);
  }

  // ── Canary mode: deploy to a subset first, verify, then rest ──
  if (opts.canaryPercent && opts.canaryPercent > 0 && opts.canaryPercent < 100) {
    const canaryCount = Math.max(1, Math.round(targets.length * opts.canaryPercent / 100));
    const canaryTargets = targets.slice(0, canaryCount);
    const remainingTargets = targets.slice(canaryCount);

    // Phase 1: Deploy to canary group
    const canaryResults = await runBatchDeploy(canaryTargets, concurrency, type);

    // Check canary health
    const canaryFailures = canaryResults.filter((r) => !r.success);
    if (canaryFailures.length > 0) {
      // Canary failed — halt and report. Remaining targets marked as skipped.
      const skippedResults: BatchDeployResult[] = remainingTargets.map((t) => ({
        hostname: t.hostname,
        success: false,
        message: `Skipped: canary phase failed (${canaryFailures.length}/${canaryCount} canary targets failed)`,
      }));
      return [...canaryResults, ...skippedResults];
    }

    // Optional wait for health stabilization
    if (opts.healthCheckWaitMs && opts.healthCheckWaitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(opts.healthCheckWaitMs!, 120_000)));
    }

    // Phase 2: Deploy to remaining targets
    const remainingResults = await runBatchDeploy(remainingTargets, concurrency, type);
    return [...canaryResults, ...remainingResults];
  }

  // Standard (non-canary) batch deploy
  return runBatchDeploy(targets, concurrency, type);
}

/** Internal batch deploy execution with semaphore concurrency. */
function runBatchDeploy(
  targets: BatchDeployTarget[],
  concurrency: number,
  type: 'deploy' | 'upgrade',
): Promise<BatchDeployResult[]> {
  if (targets.length === 0) return Promise.resolve([]);

  const results: BatchDeployResult[] = [];

  // Semaphore-based concurrency limiter
  let active = 0;
  let idx = 0;

  return new Promise((resolve) => {
    function next() {
      while (active < concurrency && idx < targets.length) {
        const target = targets[idx++]!;
        active++;

        const deployOpts: DeployOptions = {
          hostname: target.hostname,
          port: target.port,
          username: target.username,
          password: target.password ?? '',
          privateKey: target.privateKey,
          controlApiUrl: target.controlApiUrl,
          nodeManagerSecret: target.nodeManagerSecret,
          nodeManagerPort: target.nodeManagerPort,
        };

        const run = type === 'upgrade'
          ? upgradeNodeAgent(deployOpts as UpgradeOptions)
          : deployNodeAgent(deployOpts);

        run
          .then((result) => {
            results.push({
              hostname: target.hostname,
              success: result.success,
              message: result.message,
              installedVersion: (result as { installedVersion?: string }).installedVersion,
            });
          })
          .catch((err: unknown) => {
            results.push({
              hostname: target.hostname,
              success: false,
              message: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            active--;
            if (results.length === targets.length) {
              resolve(results);
            } else {
              next();
            }
          });
      }
    }

    next();
  });
}

/** Atomic deploy: execute one-by-one, halt on first failure. */
async function runAtomicDeploy(
  targets: BatchDeployTarget[],
  type: 'deploy' | 'upgrade',
): Promise<BatchDeployResult[]> {
  const results: BatchDeployResult[] = [];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    const deployOpts: DeployOptions = {
      hostname: target.hostname,
      port: target.port,
      username: target.username,
      password: target.password ?? '',
      privateKey: target.privateKey,
      controlApiUrl: target.controlApiUrl,
      nodeManagerSecret: target.nodeManagerSecret,
      nodeManagerPort: target.nodeManagerPort,
    };

    try {
      const result = type === 'upgrade'
        ? await upgradeNodeAgent(deployOpts as UpgradeOptions)
        : await deployNodeAgent(deployOpts);

      results.push({
        hostname: target.hostname,
        success: result.success,
        message: result.message,
        installedVersion: (result as { installedVersion?: string }).installedVersion,
      });

      if (!result.success) {
        // Atomic halt: mark remaining as skipped
        for (let j = i + 1; j < targets.length; j++) {
          results.push({
            hostname: targets[j]!.hostname,
            success: false,
            message: `Skipped: atomic deploy halted after failure on ${target.hostname}`,
          });
        }
        break;
      }
    } catch (err: unknown) {
      results.push({
        hostname: target.hostname,
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
      // Atomic halt
      for (let j = i + 1; j < targets.length; j++) {
        results.push({
          hostname: targets[j]!.hostname,
          success: false,
          message: `Skipped: atomic deploy halted after failure on ${target.hostname}`,
        });
      }
      break;
    }
  }

  return results;
}
