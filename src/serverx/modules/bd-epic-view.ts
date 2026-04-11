import { existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { dirname, join } from 'path';

/**
 * BD Epic 视图模块 - 提供当前 epic 和候选 epic 信息
 * 用于注入到 agent context slots 中
 */

export interface BdEpicInfo {
  id: string;
  title: string;
  status: string;
  priority?: string;
  currentTask?: string;
  nextTask?: string;
  progress?: string;
  updatedAt?: string;
}

/**
 * 检查 bd CLI 是否可用
 */
export function isBdAvailable\(\): boolean {
  try {
    const result = spawnSync\('bd', ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
    }\);
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * 获取当前正在执行的 epic
 */
export function getCurrentEpic\(bdStorePath: string, epicId?: string\): BdEpicInfo | null {
  if \(!isBdAvailable\(\) || !existsSync\(bdStorePath\)\) {
    return null;
  }
  
  try {
    const beadsDir = dirname\(bdStorePath\);
    
    // If epicId provided, get that specific epic
    if \(epicId\) {
      const result = spawnSync\('bd', ['--no-db', 'show', epicId, '--json'], {
        cwd: beadsDir,
        encoding: 'utf8',
        timeout: 5000,
      }\);
      
      if \(result.status === 0 && result.stdout\) {
        try {
          const issue = JSON.parse\(result.stdout\);
          return {
            id: issue.id || epicId,
            title: issue.title || '',
            status: issue.status || 'unknown',
            priority: issue.priority,
            updatedAt: issue.updatedAt,
          };
        } catch {
          return null;
        }
      }
      return null;
    }
    
    // Otherwise, find the first in_progress epic
    const result = spawnSync\('bd', ['--no-db', 'list', '--status', 'in_progress', '--type', 'epic', '--json'], {
      cwd: beadsDir,
      encoding: 'utf8',
      timeout: 5000,
    }\);
    
    if \(result.status === 0 && result.stdout\) {
      try {
        const issues = JSON.parse\(result.stdout\);
        if \(Array.isArray\(issues\) && issues.length > 0\) {
          const epic = issues[0];
          return {
            id: epic.id || '',
            title: epic.title || '',
            status: epic.status || 'in_progress',
            priority: epic.priority,
            updatedAt: epic.updatedAt,
          };
        }
      } catch {
        return null;
      }
    }
    
    return null;
  } catch \(err\) {
    return null;
  }
}

/**
 * 获取候选 epic（按优先级排序）
 */
export function getCandidateEpics\(bdStorePath: string, limit: number = 5\): BdEpicInfo[] {
  if \(!isBdAvailable\(\) || !existsSync\(bdStorePath\)\) {
    return [];
  }
  
  try {
    const beadsDir = dirname\(bdStorePath\);
    
    // Get open and in_progress epics, sorted by priority
    const result = spawnSync\('bd', ['--no-db', 'list', '--status', 'open', '--type', 'epic', '--json'], {
      cwd: beadsDir,
      encoding: 'utf8',
      timeout: 5000,
    }\);
    
    if \(result.status !== 0 || !result.stdout\) {
      return [];
    }
    
    try {
      const issues = JSON.parse\(result.stdout\);
      if \(!Array.isArray\(issues\)\) {
        return [];
      }
      
      // Sort by priority \(P0 > P1 > P2 > P3\), then by updatedAt \(newest first\)
      const priorityOrder: Record<string, number> = {
        'P0': 0,
        'P1': 1,
        'P2': 2,
        'P3': 3,
      };
      
      const sorted = issues
        .filter\(\(issue: any\) => issue.status !== 'closed' && issue.status !== 'done'\)
        .sort\(\(a: any, b: any\) => {
          const pa = priorityOrder[a.priority || 'P2'] ?? 2;
          const pb = priorityOrder[b.priority || 'P2'] ?? 2;
          if \(pa !== pb\) return pa - pb;
          // Newest first
          const ta = Date.parse\(a.updatedAt || '0'\);
          const tb = Date.parse\(b.updatedAt || '0'\);
          return tb - ta;
        }\);
      
      return sorted.slice\(0, limit\).map\(\(issue: any\) => \({
        id: issue.id || '',
        title: issue.title || '',
        status: issue.status || 'open',
        priority: issue.priority || 'P2',
        updatedAt: issue.updatedAt,
      }\)\);
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

/**
 * 获取下一个要执行的 epic（当前 epic 关闭后自动切换）
 */
export function getNextEpic\(bdStorePath: string, currentEpicId?: string\): BdEpicInfo | null {
  const candidates = getCandidateEpics\(bdStorePath, 10\);
  
  // Filter out current epic
  const filtered = currentEpicId
    ? candidates.filter\(\(epic\) => epic.id !== currentEpicId\)
    : candidates;
  
  // Return first candidate \(highest priority + newest\)
  return filtered.length > 0 ? filtered[0] : null;
}

/**
 * 获取 epic 的执行状态摘要
 */
export function getEpicTaskState\(bdStorePath: string, epicId: string\): {
  currentTask?: string;
  nextTask?: string;
  progress?: string;
} | null {
  if \(!isBdAvailable\(\) || !existsSync\(bdStorePath\)\) {
    return null;
  }
  
  try {
    const beadsDir = dirname\(bdStorePath\);
    
    // Get all tasks under this epic
    const result = spawnSync\('bd', ['--no-db', 'list', '--parent', epicId, '--json'], {
      cwd: beadsDir,
      encoding: 'utf8',
      timeout: 5000,
    }\);
    
    if \(result.status !== 0 || !result.stdout\) {
      return null;
    }
    
    try {
      const tasks = JSON.parse\(result.stdout\);
      if \(!Array.isArray\(tasks\)\) {
        return null;
      }
      
      const inProgressTask = tasks.find\(\(t: any\) => t.status === 'in_progress'\);
      const nextOpenTask = tasks.find\(\(t: any\) => t.status === 'open'\);
      const completedCount = tasks.filter\(\(t: any\) => t.status === 'done' || t.status === 'closed'\).length;
      
      return {
        currentTask: inProgressTask?.title,
        nextTask: nextOpenTask?.title,
        progress: `${completedCount}/${tasks.length}`,
      };
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}
