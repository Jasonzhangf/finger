#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

const FINGER_ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(FINGER_ROOT, '.finger', 'runtime');
const PID_FILE = path.join(RUNTIME_DIR, 'server.pid');
const GUARD_PID_FILE = path.join(RUNTIME_DIR, 'guard.pid');
const HEARTBEAT_FILE = path.join(RUNTIME_DIR, 'daemon.heartbeat');

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '0.0.0.0');
  });
}

async function waitForPorts(ports) {
  while (true) {
    const checks = await Promise.all(ports.map(isPortAvailable));
    if (checks.every(Boolean)) return;
    console.log('[Restart] Port still in use, waiting...');
    await new Promise(r => setTimeout(r, 1000));
  }
}

function stopProcesses() {
  [PID_FILE, GUARD_PID_FILE].forEach((file) => {
    if (fs.existsSync(file)) {
      const pid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
      if (pid) {
        try { process.kill(pid, 'SIGTERM'); } catch (e) {}
      }
      fs.unlinkSync(file);
    }
  });
  if (fs.existsSync(HEARTBEAT_FILE)) {
    fs.unlinkSync(HEARTBEAT_FILE);
  }
}

function findPortOwner(port) {
  try {
    const output = require('child_process').execSync('netstat -anv -p tcp', { encoding: 'utf8' });
    const lines = output.split(/\n+/).filter(Boolean);
    for (const line of lines) {
      if (line.includes(`.${port}`) && line.includes('LISTEN')) {
        const match = line.match(/\s+([A-Za-z0-9_-]+):(\d+)\s+/);
        if (match && match[2]) {
          const pid = parseInt(match[2], 10);
          return isNaN(pid) ? null : pid;
        }
      }
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function killPortOwner(port) {
  const pid = findPortOwner(port);
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`[Restart] Killed process ${pid} on port ${port}`);
    } catch (e) {
      // ignore
    }
  }
}

async function restartDaemon() {
  stopProcesses();
  // Ensure old listeners are killed
  killPortOwner(9998);
  killPortOwner(9999);
  await waitForPorts([9998, 9999]);
  console.log('[Restart] Ports free, starting guard...');
  const guard = spawn('node', [path.join(FINGER_ROOT, 'scripts', 'daemon-guard.cjs')], {
    stdio: 'ignore',
    detached: true
  });
  guard.unref();
  fs.writeFileSync(GUARD_PID_FILE, String(guard.pid));
  console.log(`[Restart] Guard started (PID: ${guard.pid})`);
}

restartDaemon();
