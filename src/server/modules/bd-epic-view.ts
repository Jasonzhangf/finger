/**
 * BD Epic View Module
 * 
 * Provides a view layer on top of bd (Beads CLI) for epic management.
 * This module is a read-only view of bd issues, used for session context.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from '../../core/logger.js';

const log = logger.module('bd-epic-view');

export interface EpicSummary {
  id: string;
  title: string;
  status: string;
  priority: number;
  updatedAt: string;
  progress: {
    total: number;
    completed: number;
    inProgress: number;
    blocked: number;
    open: number;
  };
  currentTaskId?: string;
  nextTaskId?: string;
}

export interface EpicTaskState {
  currentTask?: { id: string; title: string; status: string };
  nextTask?: { id: string; title: string; status: string };
  hasBlocked: boolean;
}

export interface BdIssue {
  id: string;
  title: string;
  status: string;
  type?: string;
  priority?: number;
  parent?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Check if bd CLI is available
 */
export function isBdAvailable(): boolean {
  const result = spawnSync('which', ['bd'], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0 && result.stdout.trim().length > 0;
}

/**
 * Run bd CLI command
 */
function runBdCommand(
  args: string[],
  bdStorePath: string,
): { stdout: string; stderr: string; status: number | null; error?: Error } {
  try {
    const beadsDir = dirname(bdStorePath);
    const result = spawnSync('bd', ['--no-db', ...args], {
      cwd: beadsDir,
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, BEADS_DIR: beadsDir },
    });
    
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
      error: result.error,
    };
  } catch (err) {
    return {
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      status: null,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/**
 * Parse JSON output from bd CLI
 */
function parseBdJson<T>(output: string): T | null {
  try {
    return JSON.parse(output) as T;
  } catch {
    return null;
  }
}

/**
 * Get current epic with progress summary
 */
export function getCurrentEpic(
  bdStorePath: string,
  epicId: string,
): EpicSummary | null {
  if (!existsSync(bdStorePath)) {
    log.warn('bd store not found', { bdStorePath });
    return null;
  }
  
  // Get epic data
  const epicResult = runBdCommand(['show', epicId, '--json'], bdStorePath);
  if (epicResult.status !== 0 || epicResult.error) {
    log.warn('failed to get epic', { epicId, error: epicResult.stderr });
    return null;
  }
  
  const epic = parseBdJson<BdIssue>(epicResult.stdout);
  if (!epic) {
    log.warn('failed to parse epic JSON', { epicId });
    return null;
  }
  
  // Get child tasks
  const tasksResult = runBdCommand(['list', '--parent', epicId, '--json'], bdStorePath);
  const tasks = parseBdJson<BdIssue[]>(tasksResult.stdout) ?? [];
  
  // Calculate progress
  const progress = {
    total: tasks.length,
    completed: tasks.filter(t => t.status === 'done' || t.status === 'closed').length,
    inProgress: tasks.filter(t => t.status === 'in_progress').length,
    blocked: tasks.filter(t => t.status === 'blocked').length,
    open: tasks.filter(t => t.status === 'open').length,
  };
  
  // Find current and next task
  const inProgressTask = tasks.find(t => t.status === 'in_progress');
  const openTasks = tasks.filter(t => t.status === 'open').sort((a, b) => {
    if (a.priority !== undefined && b.priority !== undefined) {
      return b.priority - a.priority; // Higher priority first
    }
    return (a.updatedAt ?? '') < (b.updatedAt ?? '') ? -1 : 1; // Older first
  });
  const nextTask = openTasks[0];
  
  return {
    id: epic.id,
    title: epic.title,
    status: epic.status,
    priority: epic.priority ?? 1,
    updatedAt: epic.updatedAt ?? new Date().toISOString(),
    progress,
    currentTaskId: inProgressTask?.id,
    nextTaskId: nextTask?.id,
  };
}

/**
 * Get candidate epics (open/in_progress), sorted by priority asc, updatedAt desc
 */
export function getCandidateEpics(
  bdStorePath: string,
  limit?: number,
): EpicSummary[] {
  if (!existsSync(bdStorePath)) {
    log.warn('bd store not found', { bdStorePath });
    return [];
  }
  
  const result = runBdCommand(['list', '--type', 'epic', '--json'], bdStorePath);
  if (result.status !== 0 || result.error) {
    log.warn('failed to list epics', { error: result.stderr });
    return [];
  }
  
  const epics = parseBdJson<BdIssue[]>(result.stdout) ?? [];
  
  // Filter candidates: open or in_progress
  const candidates = epics.filter(e => e.status === 'open' || e.status === 'in_progress');
  
  // Sort: priority asc (0=highest), updatedAt desc (newest first)
  const sorted = candidates.sort((a, b) => {
    const aPriority = a.priority ?? 1;
    const bPriority = b.priority ?? 1;
    if (aPriority !== bPriority) {
      return aPriority - bPriority; // Lower number = higher priority = first
    }
    return (b.updatedAt ?? '') > (a.updatedAt ?? '') ? 1 : -1; // Newest first
  });
  
  // Build summaries (without full progress calculation for efficiency)
  const summaries: EpicSummary[] = sorted.slice(0, limit ?? 10).map(epic => ({
    id: epic.id,
    title: epic.title,
    status: epic.status,
    priority: epic.priority ?? 1,
    updatedAt: epic.updatedAt ?? new Date().toISOString(),
    progress: { total: 0, completed: 0, inProgress: 0, blocked: 0, open: 0 },
  }));
  
  return summaries;
}

/**
 * Get next epic after current one is closed
 */
export function getNextEpic(
  bdStorePath: string,
  currentEpicId?: string,
): EpicSummary | null {
  const candidates = getCandidateEpics(bdStorePath);
  
  // Filter out current epic
  const filtered = currentEpicId 
    ? candidates.filter(e => e.id !== currentEpicId)
    : candidates;
  
  return filtered[0] ?? null;
}

/**
 * Get current task state for an epic
 */
export function getEpicTaskState(
  bdStorePath: string,
  epicId: string,
): EpicTaskState {
  if (!existsSync(bdStorePath)) {
    return { hasBlocked: false };
  }
  
  const result = runBdCommand(['list', '--parent', epicId, '--json'], bdStorePath);
  if (result.status !== 0 || result.error) {
    log.warn('failed to get epic tasks', { epicId, error: result.stderr });
    return { hasBlocked: false };
  }
  
  const tasks = parseBdJson<BdIssue[]>(result.stdout) ?? [];
  
  // Find current in_progress task
  const currentTask = tasks.find(t => t.status === 'in_progress');
  
  // Find next open task
  const openTasks = tasks.filter(t => t.status === 'open').sort((a, b) => {
    if (a.priority !== undefined && b.priority !== undefined) {
      return b.priority - a.priority;
    }
    return (a.updatedAt ?? '') < (b.updatedAt ?? '') ? -1 : 1;
  });
  const nextTask = openTasks[0];
  
  // Check for blocked
  const hasBlocked = tasks.some(t => t.status === 'blocked');
  
  return {
    currentTask: currentTask ? { id: currentTask.id, title: currentTask.title, status: currentTask.status } : undefined,
    nextTask: nextTask ? { id: nextTask.id, title: nextTask.title, status: nextTask.status } : undefined,
    hasBlocked,
  };
}

/**
 * Create a new task under an epic
 */
export function createTaskForEpic(
  bdStorePath: string,
  epicId: string,
  title: string,
  options?: { description?: string; priority?: number },
): BdIssue | null {
  const args = ['create', title, '--parent', epicId, '--type', 'task'];
  if (options?.priority !== undefined) {
    args.push('--priority', String(options.priority));
  }
  if (options?.description) {
    args.push('--description', options.description);
  }
  
  const result = runBdCommand(args, bdStorePath);
  if (result.status !== 0 || result.error) {
    log.error('failed to create task', new Error(result.stderr), { epicId, title });
    return null;
  }
  
  // Parse output - bd create returns non-JSON, extract ID
  const match = result.stdout.match(/Created issue: ([\w-]+)/);
  if (!match) {
    log.warn('failed to parse created issue ID', { output: result.stdout });
    return null;
  }
  
  return {
    id: match[1],
    title,
    status: 'open',
    parent: epicId,
  };
}

/**
 * Update task status
 */
export function updateTaskStatus(
  bdStorePath: string,
  taskId: string,
  status: string,
): boolean {
  const result = runBdCommand(['update', taskId, '--status', status], bdStorePath);
  if (result.status !== 0 || result.error) {
    log.error('failed to update task status', new Error(result.stderr), { taskId, status });
    return false;
  }
  return true;
}
