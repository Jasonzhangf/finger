import type { Task, Agent } from '../core/types.js';
import { TaskStateMachine } from './task-state-machine.js';
import { Scheduler, type SchedulingResult } from './scheduler.js';
import { RecoveryManager, type RecoveryAction } from './recovery-manager.js';

export interface WorkflowContext {
  projectId: string;
  tasks: Map<string, Task>;
  agents: Map<string, Agent>;
}

export interface WorkflowEvent {
  type: 'task_completed' | 'task_failed' | 'task_blocked' | 'agent_available' | 'dependency_resolved';
  taskId?: string;
  agentId?: string;
  data?: unknown;
}

export class WorkflowEngine {
  private stateMachine = new TaskStateMachine();
  private scheduler = new Scheduler();
  private recoveryManager = new RecoveryManager();
  private running = false;
  private eventHandlers: ((event: WorkflowEvent) => void)[] = [];

  onEvent(handler: (event: WorkflowEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  tick(context: WorkflowContext): SchedulingResult[] {
    if (!this.running) return [];

    this.processBlockedTasks(context);
    this.processFailedTasks(context);

    const taskList = Array.from(context.tasks.values());
    const agentList = Array.from(context.agents.values());

    return this.scheduler.schedule(taskList, agentList);
  }

  handleTaskCompletion(taskId: string, context: WorkflowContext): void {
    const task = context.tasks.get(taskId);
    if (!task) return;

    if (task.status === 'in_progress') {
      try {
        const updated = this.stateMachine.transition(task, 'review');
        context.tasks.set(taskId, updated);
        this.emitEvent({ type: 'task_completed', taskId });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to complete task ${taskId}: ${errMsg}`);
      }
    }
  }

  handleTaskFailure(taskId: string, context: WorkflowContext): RecoveryAction {
    const task = context.tasks.get(taskId);
    if (!task) {
      return { taskId, action: 'skip', reason: 'Task not found' };
    }

    try {
      const updated = this.stateMachine.transition(task, 'failed');
      context.tasks.set(taskId, updated);
    } catch (err) {
      console.error(`Failed to mark task as failed: ${err}`);
    }

    this.recoveryManager.saveCheckpoint(task);
    const action = this.recoveryManager.analyzeFailure(task);

    if (action.action === 'escalate') {
      try {
        const escalated = this.stateMachine.transition(task, 'escalated');
        context.tasks.set(taskId, escalated);
      } catch {
        console.error(`Failed to escalate task ${taskId}`);
      }
    }

    this.emitEvent({ type: 'task_failed', taskId, data: action });
    return action;
  }

  private processBlockedTasks(context: WorkflowContext): void {
    for (const task of context.tasks.values()) {
      if (task.status !== 'blocked') continue;

      const depsResolved = task.dependencies.every(depId => {
        const dep = context.tasks.get(depId);
        return dep && dep.status === 'closed';
      });

      if (depsResolved) {
        try {
          const updated = this.stateMachine.transition(task, 'in_progress');
          context.tasks.set(task.id, updated);
          this.emitEvent({ type: 'dependency_resolved', taskId: task.id });
        } catch (err) {
          console.error(`Failed to unblock task ${task.id}: ${err}`);
        }
      }
    }
  }

  private processFailedTasks(context: WorkflowContext): void {
    for (const task of context.tasks.values()) {
      if (task.status !== 'failed') continue;

      const action = this.recoveryManager.analyzeFailure(task);

      if (action.action === 'retry') {
        try {
          const updated = this.stateMachine.transition(task, 'open');
          context.tasks.set(task.id, updated);
        } catch {
          console.error(`Failed to retry task ${task.id}`);
        }
      }
    }
  }

  private emitEvent(event: WorkflowEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        console.error(`Event handler error: ${err}`);
      }
    }
  }
}
