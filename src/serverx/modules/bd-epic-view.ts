import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { logger } from '../../core/logger.js';

const log = logger.module('BdEpicView');

export interface BdEpicInfo {
  id: string;
  title: string;
  status: string;
  priority: number;
  updatedAt: number;
  taskId?: string;
  taskStatus?: string;
}

export interface BdCandidateEpic extends BdEpicInfo {
  briefSummary?: string;
}

/**
 * Check if bd CLI is available
 */
export function isBdAvailable(): boolean {
  try {
    const result = spawnSync('bd', ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Get current executing epic
 */
export function getCurrentEpic(bdStorePath: string, epicId?: string): BdEpicInfo | null {
  if (!isBdAvailable() || !existsSync(bdStorePath)) {
    return null;
  }

  try {
    if (epicId) {
      const result = spawnSync('bd', ['--no-db', 'show', epicId, '--json'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      if (result.status === 0 && result.stdout) {
        const parsed = JSON.parse(result.stdout);
        return {
          id: parsed.id,
          title: parsed.title,
          status: parsed.status,
          priority: parsed.priority ?? 99,
          updatedAt: parsed.updatedAt ?? 0,
          taskId: parsed.taskId,
          taskStatus: parsed.taskStatus,
        };
      }
    }

    // Get first in_progress epic
    const result = spawnSync('bd', ['--no-db', 'list', '--status', 'in_progress', '--json'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      const items = JSON.parse(result.stdout);
      if (Array.isArray(items) && items.length > 0) {
        const first = items[0];
        return {
          id: first.id,
          title: first.title,
          status: first.status,
          priority: first.priority ?? 99,
          updatedAt: first.updatedAt ?? 0,
          taskId: first.taskId,
          taskStatus: first.taskStatus,
        };
      }
    }
  } catch (e) {
    log.warn('Failed to get current epic', { bdStorePath, epicId, error: String(e) });
  }
  return null;
}

/**
 * Get candidate epics (open/in_progress), sorted by priority ASC then updatedAt DESC
 */
export function getCandidateEpics(bdStorePath: string, limit = 5): BdCandidateEpic[] {
  if (!isBdAvailable() || !existsSync(bdStorePath)) {
    return [];
  }

  try {
    const result = spawnSync(
      'bd',
      ['--no-db', 'list', '--status', 'open', '--status', 'in_progress', '--json'],
      { encoding: 'utf8', timeout: 5000 },
    );
    if (result.status === 0 && result.stdout) {
      const items = JSON.parse(result.stdout);
      if (Array.isArray(items)) {
        return items
          .filter((i: Record<string, unknown>) => i.status === 'open' || i.status === 'in_progress')
          .sort((a: Record<string, number>, b: Record<string, number>) => {
            const pa = a.priority ?? 99;
            const pb = b.priority ?? 99;
            if (pa !== pb) return pa - pb;
            return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
          })
          .slice(0, limit)
          .map((i: Record<string, unknown>) => ({
            id: String(i.id),
            title: String(i.title),
            status: String(i.status),
            priority: i.priority as number,
            updatedAt: i.updatedAt as number,
          }));
      }
    }
  } catch (e) {
    log.warn('Failed to get candidate epics', { bdStorePath, error: String(e) });
  }
  return [];
}

/**
 * Get next epic after current one is closed
 */
export function getNextEpic(bdStorePath: string, currentEpicId?: string): BdEpicInfo | null {
  const candidates = getCandidateEpics(bdStorePath, 10);
  const filtered = candidates.filter((c) => c.id !== currentEpicId);
  return filtered.length > 0 ? filtered[0] : null;
}

/**
 * Get epic task state summary
 */
export function getEpicTaskState(bdStorePath: string, epicId: string): {
  currentTaskId?: string;
  currentTaskStatus?: string;
  nextTaskId?: string;
  totalTasks: number;
  doneTasks: number;
} | null {
  if (!isBdAvailable() || !existsSync(bdStorePath)) {
    return null;
  }

  try {
    const result = spawnSync(
      'bd',
      ['--no-db', 'search', `parent:${epicId}`, '--json'],
      { encoding: 'utf8', timeout: 5000 },
    );
    if (result.status === 0 && result.stdout) {
      const items = JSON.parse(result.stdout);
      if (Array.isArray(items)) {
        const active = items.find((i: Record<string, string>) => i.status === 'in_progress');
        const next = items.find((i: Record<string, string>) => i.status === 'open');
        const done = items.filter((i: Record<string, string>) => i.status === 'done' || i.status === 'closed').length;
        return {
          currentTaskId: active?.id,
          currentTaskStatus: active?.status,
          nextTaskId: next?.id,
          totalTasks: items.length,
          doneTasks: done,
        };
      }
    }
  } catch (e) {
    log.warn('Failed to get epic task state', { bdStorePath, epicId, error: String(e) });
  }
  return null;
}
