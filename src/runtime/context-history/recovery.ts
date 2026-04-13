/**
 * Context History Management - 崩溃恢复
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { logger } from '../../core/logger.js';
import type { PendingMarker } from './types.js';
import { generateId } from './utils.js';

const log = logger.module('ContextHistoryRecovery');

const PENDING_MARKER_FILE = '.compact-pending.json';
const COMPACT_MEMORY_FILE = 'compact-memory.jsonl';

export function getPendingMarkerPath(memoryDir: string): string {
  return path.join(memoryDir, PENDING_MARKER_FILE);
}

export function getCompactMemoryPath(memoryDir: string): string {
  return path.join(memoryDir, COMPACT_MEMORY_FILE);
}

export async function writePendingMarker(memoryDir: string, sessionId: string): Promise<string> {
  const compactionId = generateId();
  const marker: PendingMarker = {
    compactionId,
    sessionId,
    startedAt: Date.now(),
    startedAtIso: new Date().toISOString(),
  };

  const markerPath = getPendingMarkerPath(memoryDir);
  await fs.writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf-8');

  log.info('Pending marker written', { compactionId, sessionId });
  return compactionId;
}

export async function deletePendingMarker(memoryDir: string): Promise<void> {
  const markerPath = getPendingMarkerPath(memoryDir);
  try {
    await fs.unlink(markerPath);
    log.info('Pending marker deleted', { memoryDir });
  } catch {
    log.debug('Pending marker not found', { memoryDir });
  }
}

export async function readPendingMarker(memoryDir: string): Promise<PendingMarker | null> {
  const markerPath = getPendingMarkerPath(memoryDir);
  try {
    const content = await fs.readFile(markerPath, 'utf-8');
    return JSON.parse(content) as PendingMarker;
  } catch {
    return null;
  }
}

export async function checkLastCompactionId(memoryDir: string, compactionId: string): Promise<boolean> {
  const compactPath = getCompactMemoryPath(memoryDir);
  try {
    const content = await fs.readFile(compactPath, 'utf-8');
    const lines = content.trim().split('\n');
    if (lines.length === 0) {
      return false;
    }

    const lastLine = lines[lines.length - 1];
    const lastEntry = JSON.parse(lastLine);

    if (lastEntry.compaction_id === compactionId) {
      return true;
    }

    return false;
  } catch {
    log.warn('Failed to read compact-memory.jsonl', { memoryDir });
    return false;
  }
}

export async function checkCrashRecovery(memoryDir: string): Promise<{
  needsRecovery: boolean;
  pendingMarker: PendingMarker | null;
  action: 'complete' | 'retry' | 'none';
}> {
  const pendingMarker = await readPendingMarker(memoryDir);

  if (!pendingMarker) {
    return {
      needsRecovery: false,
      pendingMarker: null,
      action: 'none',
    };
  }

  const isComplete = await checkLastCompactionId(memoryDir, pendingMarker.compactionId);

  if (isComplete) {
    await deletePendingMarker(memoryDir);
    log.info('Crash recovery: compaction already complete', {
      compactionId: pendingMarker.compactionId,
    });
    return {
      needsRecovery: true,
      pendingMarker,
      action: 'complete',
    };
  }

  log.warn('Crash recovery: compaction incomplete, needs retry', {
    compactionId: pendingMarker.compactionId,
    sessionId: pendingMarker.sessionId,
  });
  return {
    needsRecovery: true,
    pendingMarker,
    action: 'retry',
  };
}

export async function executeCrashRecovery(
  memoryDir: string,
  sessionId: string,
  compressFn: () => Promise<void>,
): Promise<void> {
  const recoveryResult = await checkCrashRecovery(memoryDir);

  if (!recoveryResult.needsRecovery) {
    return;
  }

  if (recoveryResult.action === 'retry') {
    log.info('Executing crash recovery retry', { sessionId });
    await compressFn();
  }
}
