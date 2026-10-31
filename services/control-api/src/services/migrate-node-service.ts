import { requireSshExitStatus } from './ssh-exec-service.js';
import { withApiSshOwnership } from './managed-ssh-admission.js';
import { Client } from 'ssh2';

export interface MigrateNodeOptions {
  /** Agent node hostname / IP to SSH into */
  hostname: string;
  /** SSH port */
  sshPort?: number;
  /** SSH username */
  username: string;
  /** SSH password */
  password: string;
  /** New CONTROL_API_URL the agent should point to */
  targetControlApiUrl: string;
  /** New NODE_MANAGER_SECRET for the target control node */
  targetSecret: string;
}

export interface MigrateNodeResult {
  success: boolean;
  message: string;
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

// ── SSH connect ──────────────────────────────────────────────────────────────
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
    });
  });
}

// ── Execute remote command ───────────────────────────────────────────────────
function sshExec(
  conn: Client,
  command: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) { reject(err); return; }
      let stdout = '';
      let stderr = '';
      stream.on('data', (data: Buffer) => { stdout += data.toString(); });
      stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      stream.on('close', (code: number) => {
        try { resolve({ code: requireSshExitStatus(code), stdout, stderr }); } catch (error) { reject(error); }
      });
      stream.on('error', reject);
    });
  });
}

/**
 * Migrate a node agent to point at a different control node.
 *
 * Steps:
 * 1. SSH into the agent host
 * 2. Update CONTROL_API_URL in /opt/magnus-agent/.env
 * 3. Update NODE_MANAGER_SECRET if changed
 * 4. Restart the magnus-agent systemd service
 */
export async function migrateNodeAgent(
  opts: MigrateNodeOptions,
): Promise<MigrateNodeResult> {
  return withApiSshOwnership(opts.hostname, 'agent-migrate', async () => {
  const {
    hostname,
    sshPort = 22,
    username,
    password,
    targetControlApiUrl,
    targetSecret,
  } = opts;

  const escapedPassword = password.replace(/'/g, "'\\''");
  const agentDir = '/opt/magnus-agent';

  let conn: Client | null = null;

  try {
    // Connect via SSH
    conn = await withTimeout(
      sshConnect({ host: hostname, port: sshPort, username, password }),
      30_000,
      'SSH connect',
    );

    // Build a script that:
    // 1. Updates CONTROL_API_URL in .env
    // 2. Updates NODE_MANAGER_SECRET in .env
    // 3. Verifies the .env was actually updated
    // 4. Restarts the service
    const script = `
set -e

do_sudo() {
  echo '${escapedPassword}' | sudo -S env "PATH=$PATH" "$@" 2>/dev/null
}

ENV_FILE="${agentDir}/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found"
  exit 1
fi

echo ">>> Current CONTROL_API_URL:"
grep '^CONTROL_API_URL=' "$ENV_FILE" || echo "(not set)"

echo ">>> Updating CONTROL_API_URL to ${targetControlApiUrl}"
if grep -q '^CONTROL_API_URL=' "$ENV_FILE"; then
  sed -i 's|^CONTROL_API_URL=.*|CONTROL_API_URL=${targetControlApiUrl}|' "$ENV_FILE"
else
  echo 'CONTROL_API_URL=${targetControlApiUrl}' >> "$ENV_FILE"
fi

echo ">>> Updating NODE_MANAGER_SECRET"
if grep -q '^NODE_MANAGER_SECRET=' "$ENV_FILE"; then
  sed -i 's|^NODE_MANAGER_SECRET=.*|NODE_MANAGER_SECRET=${targetSecret}|' "$ENV_FILE"
else
  echo 'NODE_MANAGER_SECRET=${targetSecret}' >> "$ENV_FILE"
fi

echo ">>> Verifying .env updates..."
ACTUAL_URL=$(grep '^CONTROL_API_URL=' "$ENV_FILE" | cut -d= -f2-)
ACTUAL_SECRET=$(grep '^NODE_MANAGER_SECRET=' "$ENV_FILE" | cut -d= -f2-)

if [ "$ACTUAL_URL" != "${targetControlApiUrl}" ]; then
  echo "ERROR: CONTROL_API_URL verification failed. Expected '${targetControlApiUrl}', got '$ACTUAL_URL'"
  exit 2
fi

if [ "$ACTUAL_SECRET" != "${targetSecret}" ]; then
  echo "ERROR: NODE_MANAGER_SECRET verification failed"
  exit 2
fi
echo ">>> .env verified OK"

echo ">>> Restarting magnus-agent service"
do_sudo systemctl restart magnus-agent

sleep 3

if do_sudo systemctl is-active --quiet magnus-agent; then
  echo ">>> SUCCESS: Agent migrated and running"
else
  echo ">>> WARNING: Service may still be starting"
  do_sudo journalctl -u magnus-agent --no-pager -n 10 || true
fi
`;

    const result = await withTimeout(
      sshExec(conn, script),
      60_000,
      'migrate script',
    );

    conn.end();
    conn = null;

    if (result.code === 0 && result.stdout.includes('SUCCESS')) {
      return { success: true, message: `Agent on ${hostname} migrated to ${targetControlApiUrl}` };
    } else {
      return {
        success: false,
        message: `Migration script exit code ${result.code}: ${result.stderr || result.stdout}`,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (conn) { try { conn.end(); } catch { /* ignore */ } }
    return { success: false, message: msg };
  }
  });
}
