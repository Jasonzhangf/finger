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
  cleanedCompactionMarkers: string[];
} {
  const pidCleanup = sanitizeRuntimePidFiles();
  const removedSessionRoots = [
    ...pruneOrphanSessionRootDirs(FINGER_PATHS.sessions.dir).removed,
    ...pruneOrphanSessionRootDirs(path.join(FINGER_PATHS.home, 'system', 'sessions')).removed,
  ];
  const compactionCleanup = sanitizePendingCompactionMarkers();
  return {
    removedPidFiles: pidCleanup.removed,
    removedSessionRoots,
    cleanedCompactionMarkers: compactionCleanup.cleaned,
  };
}

/**
 * Scan for pending compaction markers across all sessions and clean them up.
 * Pending markers indicate interrupted compactions from crash/exit.
 * These can be safely removed because compaction is deterministic (no LLM involved).
 * The next compaction will rebuild from ledger data.
 */
export function sanitizePendingCompactionMarkers(): { cleaned: string[] } {
  const cleaned: string[] = [];
  const sessionsDir = FINGER_PATHS.sessions.dir;
  const systemSessionsDir = path.join(FINGER_PATHS.home, 'system', 'sessions');

  const scanDir = (baseDir: string): void => {
    if (!fs.existsSync(baseDir)) return;
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith('session-') && !entry.name.startsWith('system-')) continue;

      const sessionRoot = path.join(baseDir, entry.name);
      // Look for agent subdirectories within session
      try {
        const agentEntries = fs.readdirSync(sessionRoot, { withFileTypes: true });
        for (const agentEntry of agentEntries) {
          if (!agentEntry.isDirectory()) continue;
          const agentDir = path.join(sessionRoot, agentEntry.name);
          // Check for .compact-pending.json in agent directory or mode subdirs
          const pendingPath = path.join(agentDir, '.compact-pending.json');
          if (fs.existsSync(pendingPath)) {
            try {
              fs.unlinkSync(pendingPath);
              cleaned.push(pendingPath);
              log.warn('Removed pending compaction marker from interrupted compaction', {
                path: pendingPath,
                session: entry.name,
                agent: agentEntry.name,
              });
            } catch (err) {
              log.warn('Failed to remove pending compaction marker', {
                path: pendingPath,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          // Also check mode subdirectories (track0, track1, etc.)
          try {
            const modeEntries = fs.readdirSync(agentDir, { withFileTypes: true });
            for (const modeEntry of modeEntries) {
              if (!modeEntry.isDirectory()) continue;
              const modePendingPath = path.join(agentDir, modeEntry.name, '.compact-pending.json');
              if (fs.existsSync(modePendingPath)) {
                try {
                  fs.unlinkSync(modePendingPath);
                  cleaned.push(modePendingPath);
                  log.warn('Removed pending compaction marker from mode subdir', {
                    path: modePendingPath,
                    session: entry.name,
                    agent: agentEntry.name,
                    mode: modeEntry.name,
                  });
                } catch (err) {
                  log.warn('Failed to remove pending compaction marker', {
                    path: modePendingPath,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            }
          } catch {
            // Ignore errors reading mode subdirs
          }
        }
      } catch {
        // Ignore errors reading agent subdirs
      }
    }
  };

  scanDir(sessionsDir);
  scanDir(systemSessionsDir);

  return { cleaned };
}
