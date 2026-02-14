import type { Task } from '../core/types.js';
import { TaskStateMachine } from './task-state-machine.js';

export interface RecoveryAction {
  taskId: string;
  action: 'retry' | 'escalate' | 'skip' | 'wait';
  reason: string;
  delayMs?: number;
}

export class RecoveryManager {
  private stateMachine = new TaskStateMachine();
  private checkpoints: Map<string, TaskCheckpoint> = new Map();

  analyzeFailure(task: Task): RecoveryAction {
    if (this.stateMachine.shouldEscalate(task)) {
      return {
        taskId: task.id,
        action: 'escalate',
        reason: `Task failed ${task.retryCount} times, exceeding retry limit`
      };
    }

    const errorType = this.classifyError(task);

    switch (errorType) {
      case 'transient':
        return {
          taskId: task.id,
          action: 'retry',
          reason: 'Transient error, will retry with exponential backoff',
          delayMs: this.calculateBackoff(task.retryCount)
        };

      case 'dependency':
        return {
          taskId: task.id,
          action: 'wait',
          reason: 'Waiting for dependency to resolve'
        };

      case 'critical':
        return {
          taskId: task.id,
          action: 'escalate',
          reason: 'Critical error requires human intervention'
        };

      default:
        return {
          taskId: task.id,
          action: 'skip',
          reason: 'Unknown error, skipping task'
        };
    }
  }

  saveCheckpoint(task: Task): void {
    this.checkpoints.set(task.id, {
      taskId: task.id,
      status: task.status,
      progress: this.calculateProgress(task),
      artifacts: [...task.artifacts],
      timestamp: new Date()
    });
  }

  restoreCheckpoint(taskId: string): TaskCheckpoint | undefined {
    return this.checkpoints.get(taskId);
  }

  private classifyError(task: Task): 'transient' | 'dependency' | 'critical' | 'unknown' {
    if (task.status === 'failed' && task.retryCount < 3) {
      return 'transient';
    }

    if (task.status === 'blocked') {
      return 'dependency';
    }

    return 'unknown';
  }

  private calculateBackoff(retryCount: number): number {
    const baseDelay = 1000;
    return baseDelay * Math.pow(2, retryCount);
  }

  private calculateProgress(task: Task): number {
    if (task.status === 'closed') return 100;
    if (task.status === 'review') return 90;
    if (task.status === 'in_progress') return 50;
    if (task.status === 'blocked' || task.status === 'failed') return 25;
    return 0;
  }
}

interface TaskCheckpoint {
  taskId: string;
  status: string;
  progress: number;
  artifacts: Task['artifacts'];
  timestamp: Date;
}
