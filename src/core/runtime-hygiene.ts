import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { FINGER_PATHS } from './finger-paths.js';
import { FINGER_SOURCE_ROOT } from './source-root.js';
import { logger } from './logger.js';

const log = logger.module('RuntimeHygiene');

export interface ProcessSnapshotRow {
  pid: number;
  command: string;
}

export interface PidFileDescriptor {
  filePath: string;
  tag: string;
  matchers: string[];
}

export function loadProcessSnapshot(): ProcessSnapshotRow[] {
  try {
    const output = execFileSync('ps', ['-Ao', 'pid,command'], { encoding: 'utf8' });
    const rows: ProcessSnapshotRow[] = [];
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

export function resolveDefaultPidDescriptors(): PidFileDescriptor[] {
  const runtimeDir = FINGER_PATHS.runtime.dir;
  const sourceRoot = FINGER_SOURCE_ROOT;
  return [
    {
      filePath: path.join(runtimeDir, 'daemon.pid'),
      tag: 'daemon.pid',
      matchers: [sourceRoot, 'dist/server/index.js'],
    },
    {
      filePath: path.join(runtimeDir, 'server.pid'),
      tag: 'server.pid',
      matchers: [sourceRoot, 'dist/server/index.js'],
    },
    {
      filePath: path.join(runtimeDir, 'dual-daemon.pid'),
      tag: 'dual-daemon.pid',
      matchers: [sourceRoot, 'dist/daemon/dual-daemon'],
    },
    {
      filePath: path.join(runtimeDir, 'daemon-1.pid'),
      tag: 'daemon-1.pid',
      matchers: [sourceRoot, 'dist/server/index.js'],
    },
    {
      filePath: path.join(runtimeDir, 'daemon-2.pid'),
      tag: 'daemon-2.pid',
      matchers: [sourceRoot, 'dist/server/index.js'],
    },
    {
      filePath: path.join(runtimeDir, 'guard.pid'),
      tag: 'guard.pid',
      matchers: [sourceRoot, 'scripts/daemon-guard.cjs'],
    },
  ];
}

export function sanitizeRuntimePidFiles(
  descriptors: PidFileDescriptor[] = resolveDefaultPidDescriptors(),
  snapshot: ProcessSnapshotRow[] = loadProcessSnapshot(),
): { removed: string[] } {
  const removed: string[] = [];
  const cmdByPid = new Map<number, string>(snapshot.map((row) => [row.pid, row.command]));

  for (const descriptor of descriptors) {
    if (!fs.existsSync(descriptor.filePath)) continue;
    try {
      const raw = fs.readFileSync(descriptor.filePath, 'utf8').trim();
      const pid = Number.parseInt(raw, 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        fs.unlinkSync(descriptor.filePath);
        removed.push(descriptor.tag);
        log.warn('Removed dirty pid file with invalid pid', {
          file: descriptor.filePath,
          tag: descriptor.tag,
          raw,
        });
        continue;
      }

      const cmdline = cmdByPid.get(pid);
      if (!cmdline) {
        fs.unlinkSync(descriptor.filePath);
        removed.push(descriptor.tag);
        log.warn('Removed stale pid file: process not alive', {
          file: descriptor.filePath,
          tag: descriptor.tag,
          pid,
        });
        continue;
      }

      const matched = descriptor.matchers.every((token) => cmdline.includes(token));
      if (!matched) {
        fs.unlinkSync(descriptor.filePath);
        removed.push(descriptor.tag);
        log.warn('Removed dirty pid file: cmdline mismatch', {
          file: descriptor.filePath,
          tag: descriptor.tag,
          pid,
          cmdline,
        });
      }
    } catch (error) {
      log.warn('Failed to sanitize pid file', {
        file: descriptor.filePath,
        tag: descriptor.tag,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { removed };
}

function isSessionRootArtifact(dirName: string): boolean {
  return dirName.startsWith('session-') || dirName.startsWith('system-');
}

export function pruneOrphanSessionRootDirs(baseDir: string): { removed: string[] } {
  const removed: string[] = [];
  if (!fs.existsSync(baseDir)) return { removed };

  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!isSessionRootArtifact(entry.name)) continue;
    const sessionRoot = path.join(baseDir, entry.name);
    let childCount = 0;
    try {
      const children = fs.readdirSync(sessionRoot, { withFileTypes: true });
      childCount = children.length;
    } catch {
      continue;
    }
    if (childCount > 0) continue;

    fs.rmSync(sessionRoot, { recursive: true, force: true });
    removed.push(sessionRoot);
    log.warn('Removed orphan session root artifact', { sessionRoot });
  }

  return { removed };
}

export function sanitizeFingerRuntimeState(): {
  removedPidFiles: string[];
  removedSessionRoots: string[];
} {
  const pidCleanup = sanitizeRuntimePidFiles();
  const removedSessionRoots = [
    ...pruneOrphanSessionRootDirs(FINGER_PATHS.sessions.dir).removed,
    ...pruneOrphanSessionRootDirs(path.join(FINGER_PATHS.home, 'system', 'sessions')).removed,
  ];
  return {
    removedPidFiles: pidCleanup.removed,
    removedSessionRoots,
  };
}
