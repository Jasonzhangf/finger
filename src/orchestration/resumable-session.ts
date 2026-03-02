/**
 * Resumable Session - 可恢复会话管理
 * 支持会话保存、恢复、进度跟踪
 */

import fs from 'fs';
import path from 'path';
import { FINGER_PATHS, ensureDir, normalizeSessionDirName } from '../core/finger-paths.js';

const SESSIONS_DIR = FINGER_PATHS.sessions.dir;
const CHECKPOINTS_DIR = 'checkpoints';
const SESSION_STATE_FILE = 'session-state.json';

export interface TaskProgress {
  taskId: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  assignedAgent?: string;
  startedAt?: string;
  completedAt?: string;
  result?: {
    success: boolean;
    output?: string;
    error?: string;
  };
  iterationCount: number;
  maxIterations: number;
}

export interface SessionMetadata {
  id: string;
  name: string;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  activeWorkflows: string[];
}

export interface PhaseHistoryEntry {
  phase: string;
  timestamp: string;
  action: string;
  checkpointId?: string;
}

export interface SessionCheckpoint {
  checkpointId: string;
  sessionId: string;
  timestamp: string;
  originalTask: string;
  taskProgress: TaskProgress[];
  completedTaskIds: string[];
  failedTaskIds: string[];
  pendingTaskIds: string[];
  agentStates: Record<string, {
    agentId: string;
    currentTaskId?: string;
    status: string;
    round: number;
    thought?: string;
  }>;
  phaseHistory?: PhaseHistoryEntry[];
  context: Record<string, unknown>;
}

export interface ResumeContext {
  checkpoint: SessionCheckpoint;
  summary: string;
  nextActions: string[];
  estimatedProgress: number; // 0-100
}

export class ResumableSessionManager {
  constructor() {
    this.ensureDirs();
  }

  private ensureDirs(): void {
    ensureDir(SESSIONS_DIR);
  }

  private resolveSessionDir(sessionId: string): string {
    ensureDir(SESSIONS_DIR);
    const projects = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    for (const projectDir of projects) {
      const candidate = path.join(SESSIONS_DIR, projectDir, normalizeSessionDirName(sessionId));
      if (fs.existsSync(candidate)) return candidate;
    }
    const fallback = path.join(SESSIONS_DIR, '_unknown', normalizeSessionDirName(sessionId));
    if (!fs.existsSync(fallback)) {
      fs.mkdirSync(fallback, { recursive: true });
    }
    return fallback;
  }

  private getCheckpointPath(checkpointId: string, sessionId: string): string {
    const sessionDir = this.resolveSessionDir(sessionId);
    const checkpointDir = path.join(sessionDir, CHECKPOINTS_DIR);
    if (!fs.existsSync(checkpointDir)) {
      fs.mkdirSync(checkpointDir, { recursive: true });
    }
    return path.join(checkpointDir, `${checkpointId}.json`);
  }

  getCheckpointDir(sessionId: string): string {
    const sessionDir = this.resolveSessionDir(sessionId);
    const checkpointDir = path.join(sessionDir, CHECKPOINTS_DIR);
    if (!fs.existsSync(checkpointDir)) {
      fs.mkdirSync(checkpointDir, { recursive: true });
    }
    return checkpointDir;
  }

  /**
   * Create a checkpoint for current session state
   */
  createCheckpoint(
    sessionId: string,
    originalTask: string,
    taskProgress: TaskProgress[],
    agentStates: SessionCheckpoint['agentStates'],
    context: Record<string, unknown> = {},
    phaseHistory: PhaseHistoryEntry[] = []
  ): SessionCheckpoint {
    // Ensure unique checkpoint ID even in tight loops
    const baseCheckpointId = `chk-${sessionId}-${Date.now()}`;
    let checkpointId = baseCheckpointId;
    let counter = 0;
    while (fs.existsSync(this.getCheckpointPath(checkpointId, sessionId))) {
      counter++;
      checkpointId = `${baseCheckpointId}-${counter}`;
    }
    
    const completedTaskIds = taskProgress
      .filter(t => t.status === 'completed')
      .map(t => t.taskId);
    
    const failedTaskIds = taskProgress
      .filter(t => t.status === 'failed')
      .map(t => t.taskId);
    
    const pendingTaskIds = taskProgress
      .filter(t => t.status === 'pending' || t.status === 'in_progress')
      .map(t => t.taskId);

    const checkpoint: SessionCheckpoint = {
      checkpointId,
      sessionId,
      timestamp: new Date().toISOString(),
      originalTask,
      taskProgress,
      completedTaskIds,
      failedTaskIds,
      pendingTaskIds,
      agentStates,
      phaseHistory: phaseHistory.length > 0 ? phaseHistory : undefined,
      context,
    };

    fs.writeFileSync(
      this.getCheckpointPath(checkpointId, sessionId),
      JSON.stringify(checkpoint, null, 2)
    );

    console.log(`[ResumableSession] Created checkpoint ${checkpointId} for session ${sessionId}`);
    return checkpoint;
  }

  /**
   * Update session metadata, specifically activeWorkflows.
   */
  updateSession(sessionId: string, updates: Partial<SessionMetadata>): void {
    const sessionFilePath = path.join(this.resolveSessionDir(sessionId), SESSION_STATE_FILE);
    let session: SessionMetadata | null = null;

    if (fs.existsSync(sessionFilePath)) {
      try {
        session = JSON.parse(fs.readFileSync(sessionFilePath, 'utf-8'));
      } catch (error) {
        console.error(`[ResumableSession] Failed to read session file ${sessionId}:`, error);
        return;
      }
    }

    if (!session) {
      // Create new session metadata if doesn't exist
      session = {
        id: sessionId,
        name: sessionId,
        projectPath: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        activeWorkflows: [],
      };
    }

    Object.assign(session, updates);
    session.updatedAt = new Date().toISOString();
    fs.writeFileSync(sessionFilePath, JSON.stringify(session, null, 2));
    console.log(`[ResumableSession] Updated session ${sessionId}`);
  }

  /**
   * Load a checkpoint by ID
   */
  loadCheckpoint(checkpointId: string): SessionCheckpoint | null {
    const sessionId = checkpointId.split('-').slice(1, -1).join('-');
    if (!sessionId) return null;
    const filePath = this.getCheckpointPath(checkpointId, sessionId);
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as SessionCheckpoint;
    } catch (err) {
      console.error(`[ResumableSession] Failed to load checkpoint ${checkpointId}:`, err);
      return null;
    }
  }

  /**
   * Find latest checkpoint for a session
   */
  findLatestCheckpoint(sessionId: string): SessionCheckpoint | null {
    const checkpointDir = this.getCheckpointDir(sessionId);
    if (!fs.existsSync(checkpointDir)) return null;

    const files = fs.readdirSync(checkpointDir)
      .filter(f => f.startsWith(`chk-${sessionId}-`) && f.endsWith('.json'))
      .sort()
      .reverse();

    for (const file of files) {
      const checkpointId = file.replace('.json', '');
      const checkpoint = this.loadCheckpoint(checkpointId);
      if (checkpoint) return checkpoint;
    }

    return null;
  }

  /**
   * Build resume context for model
   */
  buildResumeContext(checkpoint: SessionCheckpoint): ResumeContext {
    const total = checkpoint.taskProgress.length;
    const completed = checkpoint.completedTaskIds.length;

    const estimatedProgress = total > 0 ? Math.round((completed / total) * 100) : 0;

    const summary = this.generateProgressSummary(checkpoint);

    const nextActions = this.identifyNextActions(checkpoint);

    return {
      checkpoint,
      summary,
      nextActions,
      estimatedProgress,
    };
  }

  /**
   * Generate human-readable progress summary
   */
  private generateProgressSummary(checkpoint: SessionCheckpoint): string {
    const lines: string[] = [];
    
    lines.push(`# Session Resume Summary`);
    lines.push(`Original task: ${checkpoint.originalTask}`);
    lines.push(`Last updated: ${checkpoint.timestamp}`);
    lines.push('');

    const total = checkpoint.taskProgress.length;
    const completed = checkpoint.completedTaskIds.length;
    const failed = checkpoint.failedTaskIds.length;

    lines.push(`Progress: ${completed}/${total} tasks completed (${failed} failed)`);
    lines.push('');

    if (completed > 0) {
      lines.push('## Completed tasks:');
      for (const task of checkpoint.taskProgress.filter(t => t.status === 'completed')) {
        lines.push(`- [✓] ${task.taskId}: ${task.description}`);
        if (task.result?.output) {
          lines.push(`  Result: ${task.result.output.slice(0, 200)}...`);
        }
      }
      lines.push('');
    }

    if (failed > 0) {
      lines.push('## Failed tasks:');
      for (const task of checkpoint.taskProgress.filter(t => t.status === 'failed')) {
        lines.push(`- [✗] ${task.taskId}: ${task.description}`);
        if (task.result?.error) {
          lines.push(`  Error: ${task.result.error.slice(0, 200)}`);
        }
      }
      lines.push('');
    }

    const inProgress = checkpoint.taskProgress.filter(t => t.status === 'in_progress');
    if (inProgress.length > 0) {
      lines.push('## In-progress tasks:');
      for (const task of inProgress) {
        lines.push(`- [→] ${task.taskId}: ${task.description} (iteration ${task.iterationCount}/${task.maxIterations})`);
        const agentState = checkpoint.agentStates[task.assignedAgent || ''];
        if (agentState?.thought) {
          lines.push(`  Current thought: ${agentState.thought.slice(0, 200)}...`);
        }
      }
      lines.push('');
    }

    lines.push('## Next steps:');
    lines.push(...this.identifyNextActions(checkpoint).map(a => `- ${a}`));

    return lines.join('\n');
  }

  /**
   * Identify what actions should be taken next
   */
  private identifyNextActions(checkpoint: SessionCheckpoint): string[] {
    const actions: string[] = [];

    // Check for in-progress tasks that need continuation
    const inProgress = checkpoint.taskProgress.filter(t => t.status === 'in_progress');
    for (const task of inProgress) {
      const agentState = checkpoint.agentStates[task.assignedAgent || ''];
      if (agentState) {
        actions.push(`Continue task "${task.description}" (currently ${agentState.status}, round ${agentState.round})`);
      }
    }

    // Check for pending tasks
    for (const task of checkpoint.taskProgress.filter(t => t.status === 'pending')) {
      actions.push(`Start pending task: ${task.description}`);
    }

    // Check for failed tasks that might need retry
    const failedTasks = checkpoint.taskProgress.filter(t => t.status === 'failed');
    if (failedTasks.length > 0) {
      actions.push(`Review ${failedTasks.length} failed task(s) for potential retry`);
    }

    if (actions.length === 0 && checkpoint.pendingTaskIds.length === 0) {
      actions.push('All tasks completed - session can be finalized');
    }

    return actions;
  }

  /**
   * Clean up old checkpoints (keep last 10 per session)
   */
  cleanupOldCheckpoints(sessionId: string, keepCount: number = 10): number {
    const checkpointDir = this.getCheckpointDir(sessionId);
    if (!fs.existsSync(checkpointDir)) return 0;

    const files = fs.readdirSync(checkpointDir)
      .filter(f => f.startsWith(`chk-${sessionId}-`) && f.endsWith('.json'))
      .sort()
      .reverse();

    let deleted = 0;
    for (const file of files.slice(keepCount)) {
      try {
        fs.unlinkSync(path.join(checkpointDir, file));
        deleted++;
      } catch {
        // Ignore errors
      }
    }

    return deleted;
  }
}

// Singleton instance
export const resumableSessionManager = new ResumableSessionManager();

/**
 * Determine which phase to resume from based on checkpoint state
 */
export function determineResumePhase(checkpoint: SessionCheckpoint): string {
  // Failed tasks always force rollback to plan phase
  if (checkpoint.failedTaskIds.length > 0) {
    return 'plan';
  }

  // If checkpoint has phase history, use the latest phase
  if (checkpoint.phaseHistory && checkpoint.phaseHistory.length > 0) {
    const latestEntry = checkpoint.phaseHistory[checkpoint.phaseHistory.length - 1];
    return latestEntry.phase;
  }

  // Fallback: read phase history from context if present
  const ctx = checkpoint.context as { phaseHistory?: PhaseHistoryEntry[] } | undefined;
  if (ctx?.phaseHistory && ctx.phaseHistory.length > 0) {
    const latestEntry = ctx.phaseHistory[ctx.phaseHistory.length - 1];
    return latestEntry.phase;
  }
  
  // Fallback: infer from context
  const context = checkpoint.context as { phase?: string } | undefined;
  const savedPhase = context?.phase || 'understanding';
  
  // If there are in-progress tasks, resume from parallel_dispatch
  const inProgress = checkpoint.taskProgress.filter(t => t.status === 'in_progress');
  if (inProgress.length > 0) {
    return 'parallel_dispatch';
  }
  
  // If all tasks completed, go to verify
  if (checkpoint.pendingTaskIds.length === 0 && checkpoint.completedTaskIds.length > 0) {
    return 'verify';
  }
  
  // Otherwise resume from saved phase
  return savedPhase;
}
