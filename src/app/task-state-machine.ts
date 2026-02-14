import type { Task, TaskStatus } from '../core/types.js';

export interface TransitionResult {
  allowed: boolean;
  from: TaskStatus;
  to: TaskStatus;
  reason?: string;
}

const transitions: Record<TaskStatus, TaskStatus[]> = {
  open: ['in_progress', 'closed'],
  in_progress: ['blocked', 'failed', 'review'],
  blocked: ['in_progress', 'open', 'closed'],
  failed: ['open', 'escalated'],
  review: ['closed', 'open'],
  escalated: ['closed', 'open'],
  closed: ['open']
};

export class TaskStateMachine {
  canTransition(from: TaskStatus, to: TaskStatus): TransitionResult {
    const allowed = transitions[from]?.includes(to) ?? false;

    if (!allowed) {
      return {
        allowed: false,
        from,
        to,
        reason: `Invalid transition from ${from} to ${to}`
      };
    }

    return { allowed: true, from, to };
  }

  transition(task: Task, to: TaskStatus, _context?: Record<string, unknown>): Task {
    const result = this.canTransition(task.status, to);
    if (!result.allowed) {
      throw new Error(result.reason);
    }

    // Strong review gate: task can only close from review.
    if (to === 'closed' && task.status !== 'review') {
      throw new Error('Task must be in review state before closing');
    }

    // Retry policy: max 3 retries then escalate.
    if (to === 'open' && task.status === 'failed' && task.retryCount >= 3) {
      throw new Error('Retry limit reached, task must escalate');
    }

    if (to === 'open' && task.status === 'failed') {
      task.retryCount += 1;
    }

    task.status = to;
    task.updatedAt = new Date();
    return task;
  }

  shouldEscalate(task: Task): boolean {
    return task.status === 'failed' && task.retryCount >= 3;
  }
}
