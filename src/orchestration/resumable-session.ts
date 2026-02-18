/**
 * Resumable Session - 可恢复会话管理
 * 支持会话保存、恢复、进度跟踪
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const FINGER_HOME = path.join(os.homedir(), '.finger');
const SESSION_STATE_DIR = path.join(FINGER_HOME, 'session-states');

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
    if (!fs.existsSync(SESSION_STATE_DIR)) {
      fs.mkdirSync(SESSION_STATE_DIR, { recursive: true });
    }
  }

  private getCheckpointPath(checkpointId: string): string {
    return path.join(SESSION_STATE_DIR, `${checkpointId}.json`);
  }

  /**
   * Create a checkpoint for current session state
   */
  createCheckpoint(
    sessionId: string,
    originalTask: string,
    taskProgress: TaskProgress[],
    agentStates: SessionCheckpoint['agentStates'],
    context: Record<string, unknown> = {}
  ): SessionCheckpoint {
    const checkpointId = `chk-${sessionId}-${Date.now()}`;
    
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
      context,
    };

    fs.writeFileSync(
      this.getCheckpointPath(checkpointId),
      JSON.stringify(checkpoint, null, 2)
    );

    console.log(`[ResumableSession] Created checkpoint ${checkpointId} for session ${sessionId}`);
    return checkpoint;
  }

  /**
   * Load a checkpoint by ID
   */
  loadCheckpoint(checkpointId: string): SessionCheckpoint | null {
    const filePath = this.getCheckpointPath(checkpointId);
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
    if (!fs.existsSync(SESSION_STATE_DIR)) return null;

    const files = fs.readdirSync(SESSION_STATE_DIR)
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
    if (!fs.existsSync(SESSION_STATE_DIR)) return 0;

    const files = fs.readdirSync(SESSION_STATE_DIR)
      .filter(f => f.startsWith(`chk-${sessionId}-`) && f.endsWith('.json'))
      .sort()
      .reverse();

    let deleted = 0;
    for (const file of files.slice(keepCount)) {
      try {
        fs.unlinkSync(path.join(SESSION_STATE_DIR, file));
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
