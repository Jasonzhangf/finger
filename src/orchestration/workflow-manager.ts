/**
 * Workflow Manager - 任务流程管理
 * 负责任务依赖图、状态机、资源分配
 */

import { saveWorkflow } from './workflow-persistence.js';
export type TaskStatus = 'pending' | 'blocked' | 'ready' | 'in_progress' | 'completed' | 'failed';

export interface TaskNode {
  id: string;
  description: string;
  type: 'executor' | 'reviewer';
  status: TaskStatus;
  dependencies: string[];
  dependents: string[];
  assignee?: string;
  estimatedDuration?: number;
  deadline?: number;
  startedAt?: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
}

export interface Workflow {
  id: string;
  sessionId: string;
  epicId?: string;
  tasks: Map<string, TaskNode>;
  status: 'planning' | 'executing' | 'completed' | 'failed' | 'partial';
  createdAt: string;
  updatedAt: string;
}

export interface ResourcePool {
  executors: string[];
  reviewers: string[];
  busyAgents: Set<string>;
}

export class WorkflowManager {
  private workflows: Map<string, Workflow> = new Map();
  private resourcePool: ResourcePool;

  constructor() {
    this.resourcePool = {
      executors: [],
      reviewers: [],
      busyAgents: new Set(),
    };
  }

  registerAgent(agentId: string, type: 'executor' | 'reviewer'): void {
    if (type === 'executor') {
      this.resourcePool.executors.push(agentId);
    } else {
      this.resourcePool.reviewers.push(agentId);
    }
  }

  unregisterAgent(agentId: string): void {
    this.resourcePool.executors = this.resourcePool.executors.filter(id => id !== agentId);
    this.resourcePool.reviewers = this.resourcePool.reviewers.filter(id => id !== agentId);
    this.resourcePool.busyAgents.delete(agentId);
  }

  createWorkflow(sessionId: string, epicId?: string): Workflow {
    const id = `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const workflow: Workflow = {
      id,
      sessionId,
      epicId,
      tasks: new Map(),
      status: 'planning',
      createdAt: now,
      updatedAt: now,
    };
    this.workflows.set(id, workflow);
    saveWorkflow(workflow);
    return workflow;
  }

  addTask(workflowId: string, task: Omit<TaskNode, 'status' | 'dependents'>): TaskNode {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) throw new Error(`Workflow ${workflowId} not found`);

    const taskNode: TaskNode = {
      ...task,
      status: 'pending',
      dependents: [],
    };

    for (const depId of task.dependencies) {
      const depTask = workflow.tasks.get(depId);
      if (depTask) {
        depTask.dependents.push(task.id);
      }
    }

    workflow.tasks.set(task.id, taskNode);
    workflow.updatedAt = new Date().toISOString();
    saveWorkflow(workflow);
    return taskNode;
  }

  updateTaskStatus(workflowId: string, taskId: string, status: TaskStatus, result?: unknown, error?: string): boolean {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return false;

    const task = workflow.tasks.get(taskId);
    if (!task) return false;

    task.status = status;
    task.result = result;
    task.error = error;

    if (status === 'in_progress') {
      task.startedAt = new Date().toISOString();
    } else if (status === 'completed' || status === 'failed') {
      task.completedAt = new Date().toISOString();
      if (task.assignee) {
        this.resourcePool.busyAgents.delete(task.assignee);
      }
    }

    if (status === 'completed') {
      this.updateDependentStatuses(workflow, taskId);
    }

    workflow.updatedAt = new Date().toISOString();
    this.updateWorkflowStatus(workflow);
    saveWorkflow(workflow);
    return true;
  }

  private updateDependentStatuses(workflow: Workflow, completedTaskId: string): void {
    const task = workflow.tasks.get(completedTaskId);
    if (!task) return;

    for (const dependentId of task.dependents) {
      const dependent = workflow.tasks.get(dependentId);
      if (!dependent || dependent.status !== 'blocked') continue;

      const allDepsCompleted = dependent.dependencies.every(depId => {
        const dep = workflow.tasks.get(depId);
        return dep?.status === 'completed';
      });

      if (allDepsCompleted) {
        dependent.status = 'ready';
      }
    }
  }

  assignTask(workflowId: string, taskId: string, agentId: string): boolean {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return false;

    const task = workflow.tasks.get(taskId);
    if (!task) return false;

    task.assignee = agentId;
    this.resourcePool.busyAgents.add(agentId);
    workflow.updatedAt = new Date().toISOString();
    saveWorkflow(workflow);
    return true;
  }

  getReadyTasks(workflowId: string): TaskNode[] {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return [];

    return Array.from(workflow.tasks.values()).filter(
      t => t.status === 'ready' || (t.status === 'pending' && t.dependencies.length === 0)
    );
  }

  getAvailableAgents(type: 'executor' | 'reviewer'): string[] {
    const agents = type === 'executor' ? this.resourcePool.executors : this.resourcePool.reviewers;
    return agents.filter(id => !this.resourcePool.busyAgents.has(id));
  }

  private updateWorkflowStatus(workflow: Workflow): void {
    const tasks = Array.from(workflow.tasks.values());
    const allCompleted = tasks.every(t => t.status === 'completed');
    const anyFailed = tasks.some(t => t.status === 'failed');

    if (allCompleted) {
      workflow.status = 'completed';
    } else if (anyFailed) {
      workflow.status = 'partial';
    } else {
      workflow.status = 'executing';
    }
  }

  getWorkflow(workflowId: string): Workflow | undefined {
    return this.workflows.get(workflowId);
  }

  getResourcePool(): ResourcePool {
    return {
      ...this.resourcePool,
      busyAgents: new Set(this.resourcePool.busyAgents),
    };
  }
}
