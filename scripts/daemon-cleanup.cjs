#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

function resolveFingerHome() {
  const override = process.env.FINGER_HOME;
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  return path.join(os.homedir(), '.finger');
}
const FINGER_HOME = resolveFingerHome();
const RUNTIME_DIR = path.join(FINGER_HOME, 'runtime');
const PID_FILE = path.join(RUNTIME_DIR, 'server.pid');
const GUARD_PID_FILE = path.join(RUNTIME_DIR, 'guard.pid');
const HEARTBEAT_FILE = path.join(RUNTIME_DIR, 'daemon.heartbeat');

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeStalePid(file, name) {
  if (!fs.existsSync(file)) return;
  const pid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
  if (!pid || !isRunning(pid)) {
    console.log(`[Cleanup] Removing stale ${name} PID file: ${file}`);
    fs.unlinkSync(file);
  }
}

function cleanStaleHeartbeats() {
  if (!fs.existsSync(HEARTBEAT_FILE)) return;
  const stats = fs.statSync(HEARTBEAT_FILE);
  const age = Date.now() - stats.mtime.getTime();
  if (age > 60000) {
    console.log('[Cleanup] Removing stale heartbeat file');
    fs.unlinkSync(HEARTBEAT_FILE);
  }
}

removeStalePid(PID_FILE, 'server');
removeStalePid(GUARD_PID_FILE, 'guard');
cleanStaleHeartbeats();

console.log('[Cleanup] Done');
