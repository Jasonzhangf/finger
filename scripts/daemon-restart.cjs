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
const { spawn, execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(PROJECT_ROOT, '.finger', 'runtime');
const GUARD_PID_FILE = path.join(RUNTIME_DIR, 'guard.pid');
const SERVER_PID_FILE = path.join(RUNTIME_DIR, 'server.pid');
const STOP_SCRIPT = path.join(__dirname, 'daemon-stop.cjs');
const GUARD_SCRIPT = path.join(__dirname, 'daemon-guard.cjs');
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
  const child = spawn(process.execPath, [GUARD_SCRIPT], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
}

async function main() {
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
