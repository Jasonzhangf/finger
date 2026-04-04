import { execSync } from 'child_process';
import { createServer } from 'net';
import { logger } from '../../core/logger.js';
import { FINGER_SOURCE_ROOT } from '../../core/source-root.js';

const log = logger.module('port-guard');

export interface PortProcessSnapshotRow {
  pid: number;
  ppid: number;
  command: string;
}

function buildLsofListenCommand(port: number): string {
  return `lsof -nP -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true`;
}

function parsePidList(raw: string): number[] {
  return raw
    .split(/\s+/)
    .map((entry) => Number.parseInt(entry, 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EADDRINUSE'));
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadProcessSnapshot(): PortProcessSnapshotRow[] {
  try {
    const output = execSync('ps -eo pid,ppid,command', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rows: PortProcessSnapshotRow[] = [];
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 3) continue;
      const pid = Number.parseInt(parts[0], 10);
      const ppid = Number.parseInt(parts[1], 10);
      if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(ppid) || ppid < 0) continue;
      rows.push({ pid, ppid, command: parts.slice(2).join(' ') });
    }
    return rows;
  } catch (err) {
    log.warn('Failed to load process snapshot from ps command', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function listPidsOnPort(port: number): number[] {
  try {
    const output = execSync(buildLsofListenCommand(port), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parsePidList(output);
  } catch (err) {
    log.warn('Failed to check port', { port, message: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export function isManagedFingerPortProcess(
  row: PortProcessSnapshotRow | null | undefined,
  sourceRoot = FINGER_SOURCE_ROOT,
): boolean {
  if (!row) return false;
  const cmd = row.command || '';
  if (!cmd.includes(sourceRoot)) return false;
  return cmd.includes('dist/server/index.js')
    || cmd.includes('dist/daemon/dual-daemon')
    || cmd.includes('scripts/daemon-guard.cjs');
}

function buildChildrenMap(rows: PortProcessSnapshotRow[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const row of rows) {
    const list = map.get(row.ppid) ?? [];
    list.push(row.pid);
    map.set(row.ppid, list);
  }
  return map;
}

function collectDescendants(rootPid: number, childrenMap: Map<number, number[]>): number[] {
  const out: number[] = [];
  const stack = [...(childrenMap.get(rootPid) ?? [])];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    const children = childrenMap.get(pid) ?? [];
    for (const child of children) stack.push(child);
  }
  return out;
}

function terminatePid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    log.debug('Failed to terminate pid (may already be dead or inaccessible)', {
      pid,
      signal,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function terminateManagedPortProcesses(port: number, rootPids: number[], snapshot: PortProcessSnapshotRow[]): Promise<void> {
  if (rootPids.length === 0) return;
  const childrenMap = buildChildrenMap(snapshot);
  const ordered = new Set<number>();
  for (const rootPid of rootPids) {
    for (const childPid of collectDescendants(rootPid, childrenMap).reverse()) {
      ordered.add(childPid);
    }
    ordered.add(rootPid);
  }

  log.info('Port occupied by managed finger process, attempting graceful shutdown', {
    port,
    pids: Array.from(ordered).join(', '),
  });
  for (const pid of ordered) terminatePid(pid, 'SIGTERM');

  const gracefulDeadline = Date.now() + 5_000;
  while (Date.now() < gracefulDeadline) {
    if (!(await isPortInUse(port))) return;
    await sleep(200);
  }

  log.warn('Managed finger process did not release port after SIGTERM, escalating to SIGKILL', {
    port,
    pids: Array.from(ordered).join(', '),
  });
  for (const pid of ordered) terminatePid(pid, 'SIGKILL');

  const hardDeadline = Date.now() + 2_000;
  while (Date.now() < hardDeadline) {
    if (!(await isPortInUse(port))) return;
    await sleep(200);
  }
}

export async function ensureSingleInstance(port: number): Promise<void> {
  if (!(await isPortInUse(port))) return;

  const portPids = listPidsOnPort(port);
  const snapshot = loadProcessSnapshot();
  const rowsByPid = new Map(snapshot.map((row) => [row.pid, row]));

  if (portPids.length === 0) {
    throw new Error(`Port ${port} is busy, but no owning PID could be resolved`);
  }

  const managedPids = portPids.filter((pid) => isManagedFingerPortProcess(rowsByPid.get(pid)));
  const unmanagedPids = portPids.filter((pid) => !managedPids.includes(pid));
  if (unmanagedPids.length > 0) {
    const details = unmanagedPids.map((pid) => `${pid}:${rowsByPid.get(pid)?.command ?? 'unknown'}`).join(' | ');
    throw new Error(`Port ${port} is occupied by non-finger process(es): ${details}`);
  }

  await terminateManagedPortProcesses(port, managedPids, snapshot);
  if (await isPortInUse(port)) {
    throw new Error(`Port ${port} is still in use after managed finger cleanup`);
  }
}

export const __test__ = {
  buildLsofListenCommand,
  parsePidList,
  listPidsOnPort,
  loadProcessSnapshot,
  buildChildrenMap,
  collectDescendants,
};
