#!/usr/bin/env node
/**
 * Daemon restart/start helper:
 * - stop existing daemon (restart mode)
 * - start daemon-guard in detached background mode
 * - poll /health until ready
 * - retry on startup failure
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
function resolveFingerHome() {
  const override = process.env.FINGER_HOME;
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  return path.join(os.homedir(), '.finger');
}
const FINGER_HOME = resolveFingerHome();
const RUNTIME_DIR = path.join(FINGER_HOME, 'runtime');
const GUARD_PID_FILE = path.join(RUNTIME_DIR, 'guard.pid');
const SERVER_PID_FILE = path.join(RUNTIME_DIR, 'server.pid');
const DUAL_DAEMON_PID_FILE = path.join(RUNTIME_DIR, 'dual-daemon.pid');
const COMPAT_PID_FILES = [
  path.join(RUNTIME_DIR, 'daemon.pid'),
  path.join(FINGER_HOME, 'daemon.pid'),
  path.join(FINGER_HOME, 'finger-daemon.pid'),
];
const GUARD_LOCK_FILE = path.join(RUNTIME_DIR, 'guard.lock');
const STOP_SCRIPT = path.join(__dirname, 'daemon-stop.cjs');
const GUARD_SCRIPT = path.join(__dirname, 'daemon-guard.cjs');
const GUARD_LOCK_RUNNER = path.join(__dirname, 'guard-lock-runner.py');
const HEALTH_URL = process.env.FINGER_DAEMON_HEALTH_URL || 'http://127.0.0.1:9999/health';
const HEALTH_TIMEOUT_MS = Number(process.env.FINGER_DAEMON_HEALTH_TIMEOUT_MS || 45_000);
const MAX_START_ATTEMPTS = Number(process.env.FINGER_DAEMON_START_ATTEMPTS || 5);
const RETRY_DELAY_MS = Number(process.env.FINGER_DAEMON_RETRY_DELAY_MS || 2_000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPid(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function loadProcessSnapshot() {
  try {
    const output = execFileSync('ps', ['-eo', 'pid,command'], { encoding: 'utf8' });
    const rows = [];
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) continue;
      const pid = Number.parseInt(parts[0], 10);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      rows.push({ pid, command: parts.slice(1).join(' ') });
    }
    return rows;
  } catch {
    return [];
  }
}

function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function hasFlock() {
  try {
    execFileSync('bash', ['-lc', 'command -v flock >/dev/null 2>&1'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function sanitizePidFiles() {
  const processRows = loadProcessSnapshot();
  const cmdByPid = new Map(processRows.map((row) => [row.pid, row.command]));
  const checks = [
    { file: GUARD_PID_FILE, tag: 'guard.pid', matchers: [PROJECT_ROOT, 'scripts/daemon-guard.cjs'] },
    { file: SERVER_PID_FILE, tag: 'server.pid', matchers: [PROJECT_ROOT, 'dist/server/index.js'] },
    { file: DUAL_DAEMON_PID_FILE, tag: 'dual-daemon.pid', matchers: [PROJECT_ROOT, 'dist/daemon/dual-daemon'] },
  ];
  for (const check of checks) {
    const pid = readPid(check.file);
    if (!pid) continue;
    const cmdline = cmdByPid.get(pid);
    if (!cmdline) {
      try { fs.unlinkSync(check.file); } catch {}
      console.warn(`[DaemonRestart] Removed stale ${check.tag}: pid ${pid} not alive`);
      continue;
    }
    const matched = check.matchers.every((token) => cmdline.includes(token));
    if (!matched) {
      try { fs.unlinkSync(check.file); } catch {}
      console.warn(`[DaemonRestart] Removed dirty ${check.tag}: pid ${pid} cmdline mismatch`);
    }
  }
  for (const file of COMPAT_PID_FILES) {
    const pid = readPid(file);
    if (!pid) {
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
      continue;
    }
    const cmdline = cmdByPid.get(pid);
    if (!cmdline || !cmdline.includes(PROJECT_ROOT) || !cmdline.includes('dist/server/index.js')) {
      try { fs.unlinkSync(file); } catch {}
      console.warn(`[DaemonRestart] Removed stale compat pid: ${path.basename(file)} pid=${pid}`);
    }
  }
}

function syncCompatPidFiles(pid) {
  if (!pid) return;
  for (const file of COMPAT_PID_FILES) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(pid));
    } catch {}
  }
}

function pingHealth(url, timeoutMs = 1_500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const ok = res.statusCode === 200;
      res.resume();
      resolve(ok);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitHealthy(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await pingHealth(HEALTH_URL);
    if (ok) return true;
    await sleep(1_000);
  }
  return false;
}

function stopDaemon() {
  execFileSync(process.execPath, [STOP_SCRIPT], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });
}

function startGuardDetached() {
  ensureRuntimeDir();
  const env = { ...process.env };
  let child;
  if (hasFlock()) {
    const cmd = `exec flock -n ${shellEscape(GUARD_LOCK_FILE)} ${shellEscape(process.execPath)} ${shellEscape(GUARD_SCRIPT)}`;
    child = spawn('bash', ['-lc', cmd], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: 'ignore',
      env,
    });
  } else {
    console.warn('[DaemonRestart] flock not found, using Python fcntl lock runner');
    child = spawn('python3', [GUARD_LOCK_RUNNER, GUARD_LOCK_FILE, process.execPath, GUARD_SCRIPT], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: 'ignore',
      env,
    });
  }
  child.unref();
}

async function main() {
  sanitizePidFiles();
  const startOnly = process.argv.includes('--start-only');
  if (!startOnly) {
    console.log('[DaemonRestart] Restart mode: stopping existing daemon first...');
    stopDaemon();
  } else {
    console.log('[DaemonRestart] Start-only mode...');
  }

  for (let attempt = 1; attempt <= Math.max(1, MAX_START_ATTEMPTS); attempt += 1) {
    console.log(`[DaemonRestart] Starting daemon guard (attempt ${attempt}/${MAX_START_ATTEMPTS})...`);
    startGuardDetached();

    const healthy = await waitHealthy(HEALTH_TIMEOUT_MS);
    if (healthy) {
      const guardPid = readPid(GUARD_PID_FILE);
      const serverPid = readPid(SERVER_PID_FILE);
      syncCompatPidFiles(serverPid);
      console.log('[DaemonRestart] ✅ Daemon is healthy.');
      console.log(`[DaemonRestart] guard.pid=${guardPid ?? 'unknown'} server.pid=${serverPid ?? 'unknown'}`);
      process.exit(0);
      return;
    }

    console.error(`[DaemonRestart] Health check timeout (${HEALTH_TIMEOUT_MS}ms), cleaning up and retrying...`);
    stopDaemon();
    if (attempt < MAX_START_ATTEMPTS) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  console.error('[DaemonRestart] ❌ Failed to start daemon after max retries.');
  process.exit(1);
}

main().catch((error) => {
  console.error('[DaemonRestart] Fatal error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
