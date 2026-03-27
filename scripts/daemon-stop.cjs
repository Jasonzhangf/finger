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
const ORPHAN_MAIL_PATTERN = /(\/\.finger\/scripts\/email_poll\.sh|email envelope list --account)/;
const killedPids = new Set();

function readPid(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const pid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function cmdlineMatches(cmdline, requiredTokens) {
  if (!cmdline) return false;
  return requiredTokens.every((token) => cmdline.includes(token));
}

function loadProcessSnapshot() {
  const rows = [];
  try {
    const psOutput = execSync('ps -eo pid,ppid,command', { encoding: 'utf8' });
    for (const line of psOutput.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 3) continue;
      const pid = parseInt(parts[0], 10);
      const ppid = parseInt(parts[1], 10);
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
      rows.push({ pid, ppid, cmd: parts.slice(2).join(' ') });
    }
  } catch (_) {}
  return rows;
}

function buildChildrenMap(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.ppid)) map.set(row.ppid, []);
    map.get(row.ppid).push(row.pid);
  }
  return map;
}

function collectDescendants(rootPid, childrenMap) {
  const out = [];
  const stack = [...(childrenMap.get(rootPid) || [])];
  const seen = new Set();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    const children = childrenMap.get(pid);
    if (children && children.length > 0) {
      for (const child of children) stack.push(child);
    }
  }
  return out;
}

function killPid(pid, label) {
  if (!pid || killedPids.has(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
    killedPids.add(pid);
    console.log(`[DaemonStop] Killed ${label} PID ${pid}`);
  } catch (_) {}
}

function killProcessTree(rootPid, label, childrenMap) {
  if (!rootPid) return;
  const descendants = collectDescendants(rootPid, childrenMap);
  for (const pid of descendants.reverse()) {
    killPid(pid, `${label} child`);
  }
  killPid(rootPid, label);
}

console.log('[DaemonStop] Stopping all finger daemon processes...');
const processRows = loadProcessSnapshot();
const childrenMap = buildChildrenMap(processRows);

// 1. Kill processes from PID files
const pidFileChecks = [
  { file: PID_FILE, tag: 'server.pid', requiredTokens: [FINGER_ROOT, 'dist/server/index.js'] },
  { file: GUARD_PID_FILE, tag: 'guard.pid', requiredTokens: [FINGER_ROOT, 'scripts/daemon-guard.cjs'] },
  { file: DUAL_DAEMON_PID_FILE, tag: 'dual-daemon.pid', requiredTokens: [FINGER_ROOT, 'dist/daemon/dual-daemon'] },
];
const cmdByPid = new Map(processRows.map((row) => [row.pid, row.cmd]));
for (const check of pidFileChecks) {
  if (!fs.existsSync(check.file)) continue;
  const pid = readPid(check.file);
  if (!pid) {
    try { fs.unlinkSync(check.file); } catch (_) {}
    continue;
  }
  const cmdline = cmdByPid.get(pid);
  if (!cmdline) {
    console.log(`[DaemonStop] Removed stale ${check.tag}: pid ${pid} not alive`);
    try { fs.unlinkSync(check.file); } catch (_) {}
    continue;
  }
  if (!cmdlineMatches(cmdline, check.requiredTokens)) {
    console.warn(`[DaemonStop] Dirty ${check.tag}: pid ${pid} cmdline mismatch, skip killing unrelated process`);
    try { fs.unlinkSync(check.file); } catch (_) {}
    continue;
  }
  killProcessTree(pid, check.tag, childrenMap);
  try { fs.unlinkSync(check.file); } catch (_) {}
}

// 2. Kill all orphan finger daemon/heartbeat/kernel-bridge processes
for (const row of processRows) {
  const { pid, ppid, cmd } = row;
  if (ppid !== 1) continue;
  if (HEARTBEAT_PATTERN.test(cmd)) {
    killProcessTree(pid, 'orphan heartbeat', childrenMap);
    continue;
  }
  if (cmd.includes('dist/server/index.js') && cmd.includes(FINGER_ROOT)) {
    killProcessTree(pid, 'orphan daemon', childrenMap);
    continue;
  }
  if (cmd.includes('scripts/daemon-guard.cjs') && cmd.includes(FINGER_ROOT)) {
    killProcessTree(pid, 'orphan guard', childrenMap);
    continue;
  }
  if (cmd.includes('finger-kernel-bridge-bin')) {
    killProcessTree(pid, 'orphan kernel-bridge', childrenMap);
    continue;
  }
  if (cmd.includes('dist/daemon/dual-daemon')) {
    killProcessTree(pid, 'orphan dual-daemon', childrenMap);
    continue;
  }
  if (ORPHAN_MAIL_PATTERN.test(cmd)) {
    killProcessTree(pid, 'orphan mail-poll', childrenMap);
  }
}

// 3. Clean heartbeat file
if (fs.existsSync(path.join(RUNTIME_DIR, 'daemon.heartbeat'))) {
  try { fs.unlinkSync(path.join(RUNTIME_DIR, 'daemon.heartbeat')); } catch (_) {}
}

console.log('[DaemonStop] All finger daemon processes stopped');
