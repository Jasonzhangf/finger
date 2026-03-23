#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FINGER_ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(FINGER_ROOT, '.finger', 'runtime');
const PID_FILE = path.join(RUNTIME_DIR, 'server.pid');
const GUARD_PID_FILE = path.join(RUNTIME_DIR, 'guard.pid');
const DUAL_DAEMON_PID_FILE = path.join(RUNTIME_DIR, 'dual-daemon.pid');
const HEARTBEAT_PATTERN = /daemon\.heartbeat/;

console.log('[DaemonStop] Stopping all finger daemon processes...');

// 1. Kill processes from PID files
for (const file of [PID_FILE, GUARD_PID_FILE, DUAL_DAEMON_PID_FILE]) {
  if (fs.existsSync(file)) {
    try {
      const pid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
      if (pid && !isNaN(pid)) {
        try { process.kill(pid, 'SIGTERM'); console.log(`[DaemonStop] Killed ${path.basename(file)} PID ${pid}`); } catch (_) {}
      }
    } catch (_) {}
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

// 2. Kill all orphan finger daemon/heartbeat/kernel-bridge processes
try {
  const psOutput = execSync('ps -eo pid,ppid,command', { encoding: 'utf8' });
  for (const line of psOutput.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = parseInt(parts[0]);
    const ppid = parseInt(parts[1]);
    const cmd = parts.slice(2).join(' ');
    if (ppid === 1 && HEARTBEAT_PATTERN.test(cmd)) {
      try { process.kill(pid, 'SIGTERM'); console.log(`[DaemonStop] Killed orphan heartbeat PID ${pid}`); } catch (_) {}
    }
    if (ppid === 1 && cmd.includes('dist/server/index.js') && cmd.includes(FINGER_ROOT)) {
      try { process.kill(pid, 'SIGTERM'); console.log(`[DaemonStop] Killed orphan daemon PID ${pid}`); } catch (_) {}
    }
    if (ppid === 1 && cmd.includes('finger-kernel-bridge-bin')) {
      try { process.kill(pid, 'SIGTERM'); console.log(`[DaemonStop] Killed orphan kernel-bridge PID ${pid}`); } catch (_) {}
    }
    if (ppid === 1 && cmd.includes('dist/daemon/dual-daemon')) {
      try { process.kill(pid, 'SIGTERM'); console.log(`[DaemonStop] Killed orphan dual-daemon PID ${pid}`); } catch (_) {}
    }
  }
} catch (_) {}

// 3. Clean heartbeat file
if (fs.existsSync(path.join(RUNTIME_DIR, 'daemon.heartbeat'))) {
  try { fs.unlinkSync(path.join(RUNTIME_DIR, 'daemon.heartbeat')); } catch (_) {}
}

console.log('[DaemonStop] All finger daemon processes stopped');
