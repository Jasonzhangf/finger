/**
 * Resource Cleanup
 */

import * as fs from 'fs';
import * as path from 'path';
import { FINGER_PATHS } from '../finger-paths.js';
import { logger } from '../logger.js';
import { HEALTH_CHECK_CONFIG } from './config.js';
import type { CleanupStats } from './types.js';

const log = logger.module('HealthChecker');

/**
 * 执行资源清理
 */
export function performResourceCleanup(): CleanupStats {
  const stats: CleanupStats = {
    sessionsRemoved: 0,
    logsRemoved: 0,
    backupsRemoved: 0,
    totalSizeFreed: 0,
  };

  try {
    stats.sessionsRemoved += cleanExpiredSessions();
    stats.logsRemoved += cleanExpiredLogs();
    stats.backupsRemoved += cleanExpiredBackups();
    log.info('Resource cleanup completed', { stats });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to perform resource cleanup', error);
  }

  return stats;
}

function cleanExpiredSessions(): number {
  let count = 0;

  try {
    const sessionsDir = FINGER_PATHS.sessions.dir;
    if (!fs.existsSync(sessionsDir)) return 0;

    const sessionDirs = fs.readdirSync(sessionsDir, { withFileTypes: true });
    const now = Date.now();

    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;

      const sessionPath = path.join(sessionsDir, sessionDir.name);
      const stats = fs.statSync(sessionPath);
      const age = now - stats.mtimeMs;

      if (age > HEALTH_CHECK_CONFIG.sessionMaxAgeMs) {
        removeDirectoryRecursive(sessionPath);
        count++;
        log.info('Cleaned expired session', { sessionPath, age });
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to clean expired sessions', error);
  }

  return count;
}

function cleanExpiredLogs(): number {
  let count = 0;

  try {
    const logsDir = FINGER_PATHS.logs.dir;
    if (!fs.existsSync(logsDir)) return 0;

    const logFiles = fs.readdirSync(logsDir);
    const now = Date.now();

    for (const logFile of logFiles) {
      const logPath = path.join(logsDir, logFile);
      const stats = fs.statSync(logPath);
      const age = now - stats.mtimeMs;

      if (stats.isFile() && age > HEALTH_CHECK_CONFIG.logMaxAgeMs) {
        fs.unlinkSync(logPath);
        count++;
        log.info('Cleaned expired log', { logPath, age, size: stats.size });
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to clean expired logs', error);
  }

  return count;
}

function cleanExpiredBackups(): number {
  let count = 0;

  try {
    const configDir = FINGER_PATHS.config.dir;
    const backupFiles = fs.readdirSync(configDir).filter(f => f.endsWith('.backup.json'));
    const now = Date.now();

    for (const backupFile of backupFiles) {
      const backupPath = path.join(configDir, backupFile);
      const stats = fs.statSync(backupPath);
      const age = now - stats.mtimeMs;

      if (age > HEALTH_CHECK_CONFIG.backupMaxAgeMs) {
        fs.unlinkSync(backupPath);
        count++;
        log.info('Cleaned expired backup', { backupPath, age });
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to clean expired backups', error);
  }

  return count;
}

function removeDirectoryRecursive(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      removeDirectoryRecursive(fullPath);
    } else {
      fs.unlinkSync(fullPath);
    }
  }

  fs.rmdirSync(dirPath);
}
